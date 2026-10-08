import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { linkedSessions as _linkedSessions, diagnosticsSession } from './sessions.mjs';
import { getDefaultKey, listAccounts as _listAccounts, AccountStatus } from './accounts.mjs';
import { queueDir } from './paths.mjs';
import { copilotSessionFile } from './copilot-paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { postSessionError } from './session-error-report.mjs';
import { recordIssue, rememberHostVersion } from './telemetry.mjs';
import { bindInstallationIfNeeded } from './installation-binding.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { readJsonSalvaged } from './fs-store.mjs';
import { claimIntervals, mergeIntervals, subtractIntervals, totalMs } from './active-time.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { allowsLiveFor, isLiveTrackingAllowed, isTenantDark, markTenantDark, markTrackingDisabled, readTrackingState } from './tracking.mjs';
import { readSessionWorkspace, resolveTargets, tenantsOf, isMultiTenant, expandTargets, QUEUE_HOLD_MS } from './workspace.mjs';
import { enqueue, enqueueHeld, unwrapQueueFile, releaseHeldFile } from './workspace-queue.mjs';
import { bindSessionRoutes, usesRules } from './workspace-rules.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { resolveBilling } from './billing.mjs';
import { accountStamp } from './identity-stamp.mjs';
import { resolveSessionAccount } from './session-account-copilot.mjs';
import { readCachedQuota } from './quota-copilot.mjs';
import { maybePostUsageSnapshot } from './usage-report-copilot.mjs';
import { EVENT_TYPES, readEvents, sessionStartOf } from './copilot-events.mjs';
import { readUsageRows, STORE_REASON, isDefinitiveReason, isStoreGone } from './copilot-store.mjs';
import { findSessionFile, readSessionHead } from './transcript-index-copilot.mjs';
import { acquireSessionLock, CURSOR_TRAIL_MAX, isUsableSessionId, loadSessionState, saveSessionState } from './session-state.mjs';
import { buildSegments, attributeRows, attributeShutdowns, segmentStats, shutdownKey, hasActivity } from './delta-copilot.mjs';
import { collectOperations, completionsById, emptyOperations } from './operations.mjs';
import { buildToolIndex, collectToolFailures } from './tool-failures.mjs';
import { countCompactions } from './compactions.mjs';
import { clientSurfaceOf } from './client-surface.mjs';
import { buildAutoTimeline } from './auto-selection.mjs';
import { collectCodeChanges, emptyCodeChanges } from './code-changes.mjs';
import { collectErrors } from './error-events.mjs';
import { collectSubagents, subagentStateMap } from './subagents-copilot.mjs';
import { resolveSessionName } from './session-name.mjs';
import { projectInstructions } from './project-instructions.mjs';
import { buildTimeline, postSessionTimeline } from './session-timeline-copilot.mjs';
import { establishStart } from './session-coverage.mjs';

export { enqueue, unwrapQueueFile };

const FLUSH_COUNTERS = ['flushed', 'rejected', 'failed', 'expired', 'salvaged', 'quarantined', 'workspacePending', 'deferred'];

// Sums one flush result per account into the single summary older call sites still read.
export function mergeFlushResults(list) {
  const merged = { flushed: 0, rejected: 0, failed: 0, expired: 0, salvaged: 0, quarantined: 0, workspacePending: 0, deferred: 0, trackingDisabled: false, lastError: null };
  for (const r of list) {
    if (r == null) continue;
    for (const c of FLUSH_COUNTERS) merged[c] += r[c] == null ? 0 : r[c];
    if (r.trackingDisabled) merged.trackingDisabled = true;
    if (r.lastError) merged.lastError = r.lastError;
  }
  return merged;
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
export function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// Last resort when nothing names the work (no cwd anywhere, or a filesystem root): every main work still reports, so the cursor advances.
export const UNKNOWN_REMOTE = 'local:unknown';

// Server-side DTO caps. One over-long field 400s the whole request (and on the batch route the
// whole 50-session chunk), so clamp at the source. `remote` is deliberately NOT clamped: a
// truncated remote would fabricate a bogus repo key — let it be rejected honestly.
export const clamp = (value, max) =>
  typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
export const BRANCH_MAX = 255;
const AGENT_NAME_MAX = 200;
const AGENT_TYPE_MAX = 100;
const SEGMENT_ID_MAX = 200;

// The session lock goes stale after 2 minutes; a long read refreshes it at least this often.
const LOCK_KEEPALIVE_MS = 15 * 1000;
const MAX_PENDING_ERRORS = 20;
const MAX_SHUTDOWN_REFS = 50;
const ERROR_POST_TIMEOUT_MS = 3000;
const FINALIZE_IDLE_MS = 5 * 60 * 1000;
// V-09 joins rows by created_at and V-27 opens the store read-only, so per-call rows are billed.
const PER_CALL_ENABLED = true;

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
export function detectTimezone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone == null ? null : timeZone;
  } catch {
    return null;
  }
}

function isPlain(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isFile(p) {
  try { return typeof p === 'string' && p !== '' && fs.statSync(p).isFile(); } catch { return false; }
}

function nonEmpty(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function validError(e) {
  return isPlain(e) && typeof e.error === 'string' && e.error !== '';
}

// Matches the server's own row key closely enough to fold a parked error and its fresh twin into one.
function errorKey(e) {
  return `${e.error}|${e.occurredAt == null ? '' : e.occurredAt}|${e.errorDetails == null ? '' : e.errorDetails}`;
}

// A post that landed, or that a permanent 4xx (not auth, timeout or throttle) answered: neither will change on a retry.
function isSettledPost(r) {
  return r.reported === true || (typeof r.status === 'number' && r.status >= 400 && r.status < 500 && [401, 403, 408, 429].indexOf(r.status) === -1);
}

function dedupeErrors(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = errorKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// True when any number inside is above zero: a subagent that did no counted work.
function anyPositive(v) {
  if (typeof v === 'number') return v > 0;
  if (v != null && typeof v === 'object') return Object.keys(v).some((k) => anyPositive(v[k]));
  return false;
}

function eventAtLine(events, line) {
  let lo = 0;
  let hi = events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = events[mid].line;
    if (at === line) return events[mid];
    if (at < line) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function eventById(events, id) {
  if (id == null) return null;
  for (const e of events) if (e.id === id) return e;
  return null;
}

// Where the persisted cursor sits in the file as it is now. The host can rewrite the file under it (a /rewind drops
// events and renumbers the rest), so a cursor whose anchor event is gone moves to the newest older anchor that
// survives, then to a clamp; it is never held. Double billing is stopped by shutdown ids and row ids, not by the line.
function locateCursor(events, state, toLine) {
  const ce = state.cursorEvent;
  if (ce == null) {
    return state.cursorLine > toLine ? { cursor: toLine, note: 'cursor-reset' } : { cursor: state.cursorLine, note: null };
  }
  const at = eventAtLine(events, ce.line);
  if (at != null && at.id === ce.id) return { cursor: Math.min(state.cursorLine, toLine), note: null };
  const found = eventById(events, ce.id);
  if (found != null) return { cursor: Math.min(toLine, found.line + (state.cursorLine - ce.line)), note: 'cursor-relocated' };
  const byId = new Map();
  for (const e of events) if (e.id != null) byId.set(e.id, e);
  for (let i = state.cursorTrail.length - 1; i >= 0; i--) {
    const older = byId.get(state.cursorTrail[i].id);
    if (older != null) return { cursor: Math.min(toLine, older.line), note: 'cursor-relocated' };
  }
  return { cursor: Math.min(state.cursorLine, toLine), note: 'cursor-reset' };
}

// The earlier cursor events still present in the file, oldest first: what a rewind that removes the newest anchor relocates to.
function trailAfter(cur, events, lastEvent) {
  if (lastEvent == null) return cur.cursorTrail;
  const ids = new Set();
  for (const e of events) if (e.id != null) ids.add(e.id);
  const earlier = cur.cursorEvent == null ? cur.cursorTrail : [...cur.cursorTrail, cur.cursorEvent];
  return earlier.filter((a) => a.id != null && a.id !== lastEvent.id && ids.has(a.id)).slice(-CURSOR_TRAIL_MAX);
}

// The Copilot version on the newest session.start: the closest record of the host that is running now.
function hostVersionOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === EVENT_TYPES.SESSION_START) return nonEmpty(events[i].data.copilotVersion);
  }
  return null;
}

// A file holding an earlier run: a resume record, or more than one start.
function hasPriorRun(events) {
  let starts = 0;
  for (const e of events) {
    if (e.type === EVENT_TYPES.SESSION_RESUME) return true;
    if (e.type === EVENT_TYPES.SESSION_START) starts += 1;
  }
  return starts > 1;
}

// True when a shutdown follows the last start or resume.
function lastRunFinished(events) {
  let last = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === EVENT_TYPES.SESSION_START || events[i].type === EVENT_TYPES.SESSION_RESUME) last = i;
  }
  for (let i = last + 1; i < events.length; i++) if (events[i].type === EVENT_TYPES.SESSION_SHUTDOWN) return true;
  return false;
}

// The file's own activity first, then any per-call row from the start of the store; an unavailable store counts as none.
async function sessionHasActivity(sessionId, events) {
  if (hasActivity(events)) return true;
  if (!PER_CALL_ENABLED) return false;
  const store = await readUsageRows(sessionId, { afterRowId: 0, limit: 1 });
  return store.available && store.rows.length > 0;
}

// An audit reads only the stored usage mode; every cursor-bound field starts empty so it never inherits live progress.
function auditState(loaded) {
  return {
    ...loaded,
    cursorLine: null,
    cursorEvent: null,
    cursorTrail: [],
    lastUsageRowId: 0,
    reportedShutdownLines: [],
    coveredIntervals: [],
    lastReport: null,
    sessionName: null,
    pendingErrors: [],
    timelineHash: null,
    subagents: {},
  };
}

// Step 3 of every checkpoint (Copilot CLI and VS Code): recipients, workspace fan-out and the tracking gate.
// → { stop: 'no-recipients'|'no-activity'|'tracking-gated' } or { stop: null, plans, senders, liveSenders, emit, workspaceState }.
// bindCwd() names the folder a not-yet-bound live session binds from; beforeBind() false stops it as no-activity first.
export async function planDelivery(sessionId, { deps = {}, options = {}, bindCwd = () => null, beforeBind = null } = {}) {
  let sessions;
  try {
    sessions = options.sessions == null ? await (deps.linkedSessions == null ? _linkedSessions : deps.linkedSessions)(deps) : options.sessions;
  } catch { sessions = []; }
  sessions = sessions || [];
  // A temporarily unreadable/refreshing credential must not lose this delta: queue for every
  // linked account, and defer only the network work until its token is usable again.
  let recipients = sessions;
  if (options.sessions == null) {
    let rows = [];
    try { rows = await (deps.listAccounts == null ? _listAccounts : deps.listAccounts)(deps); } catch { rows = []; }
    const byKey = new Map(sessions.map((session) => [session.key, session]));
    for (const row of rows) {
      if (row.status === AccountStatus.LINKED && !byKey.has(row.key)) byKey.set(row.key, row);
    }
    recipients = [...byKey.values()];
  }
  if (recipients.length === 0) return { stop: 'no-recipients' };
  // Diagnostics use the machine-wide anonymous worker; only identity correlation is authenticated.
  let defaultKey = null;
  try { defaultKey = await getDefaultKey(); } catch { /* best-effort */ }
  const diag = diagnosticsSession(sessions, defaultKey);
  try { await bindInstallationIfNeeded(diag, { postJsonImpl: deps.postJsonImpl }); } catch { /* best-effort */ }
  // One read per checkpoint; a tenant set on caller-supplied sessions (sync --tenant) wins. Account
  // rows carry the web-side tenantId, which must never be followed.
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(sessionId); } catch { /* best-effort */ }
  // A live session whose SessionStart saw no multi-workspace account (a login mid-session) is bound from
  // here. Tenant-scoping invariant: only the hook's or the session file's own cwd binds; never process.cwd().
  if (workspaceState == null && options.sessions == null && recipients.some(usesRules)) {
    const cwd = bindCwd();
    if (cwd != null) {
      if (beforeBind != null && !(await beforeBind())) return { stop: 'no-activity' };
      try { workspaceState = bindSessionRoutes(sessionId, cwd, recipients); } catch { /* best-effort */ }
    }
  }
  const skipGate = options.skipLiveTrackingGate === true;
  // Per account: live targets (dark ones dropped) plus every workspace held until a rule answers.
  const plans = recipients.map((s) => {
    const tracking = readTrackingState(s.key);
    const multi = isMultiTenant(s);
    if (options.sessions != null && typeof s.tenantId === 'string' && s.tenantId !== '') {
      return { session: s, multi, targets: skipGate || allowsLiveFor(s, tracking) ? [s.tenantId] : [], hold: [] };
    }
    const r = resolveTargets(s, workspaceState);
    const targets = skipGate ? r.targets : r.targets.filter((t) => allowsLiveFor({ ...s, tenantId: t }, tracking));
    const hold = r.pendingAsk ? r.askTenants.filter((t) => !isTenantDark(tracking, t)) : [];
    return { session: s, multi, targets, hold };
  }).filter((p) => p.targets.length > 0 || p.hold.length > 0);
  if (plans.length === 0) return { stop: 'tracking-gated' };
  // One clone per target; `senders` keeps tokenless ones so the snapshot drain waits for them.
  const senders = [];
  for (const p of plans) for (const t of p.targets) senders.push({ ...p.session, tenantId: t });
  const liveSenders = senders.filter((s) => s.token);
  // Fan each payload into every target file, plus one held copy while the session awaits a rule.
  const emit = options.sink == null
    ? (payload) => {
      for (const p of plans) {
        for (const t of p.targets) enqueue(p.session.key, payload, t, { multi: p.multi });
        if (p.hold.length > 0) enqueueHeld(p.session.key, payload, p.hold);
      }
    }
    : options.sink;
  return { stop: null, plans, senders, liveSenders, emit, workspaceState };
}

// Drains each planned account's queue inside the deadline; returns the accepted count, pushing 'flush-failed' into errors.
export async function flushPlans(plans, { fetchImpl, deadline = null, getAccessToken, errors }) {
  const flushes = [];
  for (const p of plans) {
    if (!p.session.token) continue;
    if (deadline != null && Date.now() >= deadline) break;
    try {
      flushes.push(await flushQueue(p.session, { fetchImpl, deadline, now: Date.now, getAccessToken }));
    } catch { errors.push('flush-failed'); }
  }
  return mergeFlushResults(flushes).flushed;
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Never rejects. One per-session lock covers read → enqueue → cursor save; the queue file is on disk
// before the cursor is saved, so a kill in between re-emits identical segmentIds.
// `options.sessions` overrides the linked-account lookup; `sink`, `skipFlush`, `collectSessionErrors` and
// persistState:false redirect the audit's side effects; `startCursor` replaces the local read position.
export async function runCheckpoint(input, deps = {}, options = {}) {
  const gitImpl = deps.gitImpl == null ? git : deps.gitImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const errors = [];
  const sessionErrors = [];
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false, usageHeld: false, cursorMismatch: false };
  const out = { segmentsQueued: 0, flushed: 0, errors, outcome: 'failed', reason: null, sessionErrors, skipped, gated: false };
  const finish = (outcome, reason) => {
    out.outcome = outcome;
    out.reason = reason == null ? null : reason;
  };
  let lock = null;
  const unlock = () => {
    if (lock != null) {
      const held = lock;
      lock = null;
      held.release();
    }
  };

  const run = async () => {
    // Step 1: input.
    const inp = input != null && typeof input === 'object' ? input : {};
    const sessionId = inp.sessionId != null ? inp.sessionId : inp.session_id;
    const transcriptHint = inp.transcriptPath != null ? inp.transcriptPath : inp.transcript_path;
    const hookCwd = nonEmpty(inp.cwd);
    const budgetMs = typeof inp.budgetMs === 'number' && inp.budgetMs > 0 ? inp.budgetMs : null;
    const hookErrors = Array.isArray(inp.hookErrors) ? inp.hookErrors.filter(validError) : [];
    const withTimeline = inp.withTimeline === true || options.emitTimeline === true;
    const withQuota = inp.withQuota === true;
    const live = options.persistState !== false;
    const deadline = budgetMs == null ? null : Date.now() + budgetMs;
    const timeLeft = () => (deadline == null ? null : deadline - Date.now());
    // A request cap that never outlives the run budget.
    const cap = (ms) => {
      const left = timeLeft();
      return left == null ? ms : Math.max(1, Math.min(ms, left));
    };
    // Session-id invariant (R-17): nothing below builds a path from an id that failed this check.
    if (!isUsableSessionId(sessionId)) {
      finish('failed', 'unnamed-session');
      return;
    }

    // Step 2: the transcript, first that is a file.
    let transcript = null;
    for (const candidate of [transcriptHint, copilotSessionFile(sessionId)]) {
      if (isFile(candidate)) { transcript = candidate; break; }
    }
    if (transcript == null) {
      const found = findSessionFile(sessionId);
      if (found != null && isFile(found.transcriptPath)) transcript = found.transcriptPath;
    }
    let head;
    const headCwd = () => {
      if (head === undefined) head = transcript == null ? null : readSessionHead(transcript);
      return head == null ? null : nonEmpty(head.cwd);
    };

    // Step 3: recipients, workspace fan-out and gating.
    const delivery = await planDelivery(sessionId, {
      deps,
      options,
      bindCwd: () => (hookCwd == null ? headCwd() : hookCwd),
      // The binding is written per session, so a session with no activity yet stops here like the gate below.
      beforeBind: async () => {
        const early = transcript == null ? null : readEvents(transcript);
        return !(early != null && !early.unreadable && !(await sessionHasActivity(sessionId, early.events)));
      },
    });
    if (delivery.stop != null) {
      if (delivery.stop === 'tracking-gated') out.gated = true;
      finish('deferred', delivery.stop);
      return;
    }
    const { plans, senders, liveSenders, emit, workspaceState } = delivery;
    // One billing snapshot per run (R-20): source, plan and identity can never disagree within a checkpoint.
    let billingFields = {};
    let identity = {};
    let billingConfig = null;
    try {
      billingConfig = readBillingConfig();
      billingFields = resolveBilling({ config: billingConfig });
      identity = accountStamp({ sessionId, config: billingConfig });
    } catch { errors.push('collector:billing'); }

    // State the tail (errors, timeline, quota, second patch) reads; set once the file has been read.
    let state = null;
    let events = [];
    let windowEvents = [];
    let consumed = false;
    let cwd = hookCwd;
    let sessionName = null;
    let namePatch = null;
    let mapDirty = false;
    const map = loadRepoMap();

    // Steps 4-11 are one block so any early stop falls through to the tail.
    locked: {
      if (transcript == null) {
        finish('failed', 'no-transcript');
        break locked;
      }

      // Step 4: park hook errors, take the session lock, read.
      if (hookErrors.length > 0 && live) {
        saveSessionState(sessionId, (cur) => ({ pendingErrors: dedupeErrors([...cur.pendingErrors, ...hookErrors]).slice(-MAX_PENDING_ERRORS) }));
      }
      lock = await acquireSessionLock(sessionId, { waitMs: budgetMs == null ? 10000 : Math.min(2000, budgetMs / 4) });
      if (lock == null) {
        finish('deferred', 'session-busy');
        return;
      }
      let lockTouchedAt = Date.now();
      const keepLock = () => {
        if (lock == null || Date.now() - lockTouchedAt < LOCK_KEEPALIVE_MS) return;
        lock.touch();
        lockTouchedAt = Date.now();
      };
      const read = readEvents(transcript);
      // A file that could not be read looks empty, and an empty file must not be taken for a rewound cursor.
      if (read.unreadable) {
        finish('failed', 'no-transcript');
        break locked;
      }
      events = read.events;
      const toLine = read.lastCompleteLine;
      // Returns past the tail: no cursor, usage state, errors, timeline, quota or flush until the file shows activity.
      if (!(await sessionHasActivity(sessionId, events))) {
        finish('deferred', 'no-activity');
        return;
      }
      const loaded = loadSessionState(sessionId);
      state = live ? loaded : auditState(loaded);
      // One account per session: the saved binding, else the first log or transcript answer, saved once by a live run.
      let boundAccount = state.accountKey;
      if (boundAccount == null && live) {
        const found = resolveSessionAccount(sessionId, { events, transcriptPath: transcript });
        if (found != null && saveSessionState(sessionId, { accountKey: found.key, accountSource: found.source })) boundAccount = found.key;
      }
      if (boundAccount != null && billingConfig != null) {
        try {
          billingFields = resolveBilling({ config: billingConfig, account: boundAccount });
          identity = accountStamp({ sessionId, config: billingConfig, account: boundAccount });
        } catch { errors.push('collector:billing'); }
      }
      const start = sessionStartOf(events);
      // Only a live run knows the host that is running now; an audit replays sessions from any past version.
      const version = live ? hostVersionOf(events) : null;
      if (version != null) { try { rememberHostVersion(version); } catch { /* best-effort */ } }
      cwd = hookCwd
        || (start != null && isPlain(start.data.context) ? nonEmpty(start.data.context.cwd) : null)
        || headCwd();

      // Step 5: cursor check and establishment.
      const requested = Number.isInteger(options.startCursor) && options.startCursor >= 0 ? options.startCursor : null;
      // The hold keeps the cursor and emits nothing; only a live session reports it (an audit reads a fixed range).
      const holdMismatch = () => {
        skipped.cursorMismatch = true;
        if (live) recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
        finish('deferred', 'cursor-mismatch');
      };
      let cursor = 0;
      if (!live) {
        cursor = requested == null ? 0 : requested;
      } else if (state.cursorLine == null) {
        if (requested != null) {
          cursor = requested;
        } else if (!hasPriorRun(events)) {
          cursor = 0;
        } else {
          let est = null;
          try { est = await establishStart(sessionId, liveSenders, { timeoutMs: cap(3000) }); } catch { est = null; }
          if (est == null || !Number.isInteger(est.startLine) || est.startLine < 0) {
            if (est != null && typeof est.reason === 'string') errors.push(est.reason);
            finish('deferred', 'unestablished');
            break locked;
          }
          cursor = est.startLine;
        }
      } else {
        // The persisted cursor, relocated by its event ids when the line no longer holds that event.
        const located = locateCursor(events, state, toLine);
        if (located.note != null) errors.push(located.note);
        // No surviving anchor at all: the file was replaced, not just trimmed. Counted once, since the next save re-anchors.
        if (located.note === 'cursor-reset') recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
        cursor = requested == null ? located.cursor : Math.max(requested, located.cursor);
      }
      if (cursor > toLine) {
        holdMismatch();
        break locked;
      }

      // Step 7: window, mode and rows (Step 6, the SessionEnd wait, lives in scripts/shutdown-worker.mjs).
      windowEvents = events.filter((e) => e.line > cursor && e.line <= toLine);
      const windowHasShutdown = windowEvents.some((e) => e.type === EVENT_TYPES.SESSION_SHUTDOWN);
      // A cursor first taken from the server (no local one) pins the earliest window stamp as the row floor every later run keeps.
      const establishing = live && state.cursorLine == null && cursor > 0;
      let rowFloorMs = live ? state.usageRowFloorMs : null;
      if (establishing) {
        let lo = Infinity;
        for (const e of windowEvents) {
          const t = e.timestamp == null ? NaN : Date.parse(e.timestamp);
          if (Number.isFinite(t) && t < lo) lo = t;
        }
        // No stamped event yet means no floor to pin, so the establishing run waits for one.
        if (lo === Infinity && PER_CALL_ENABLED && state.usageMode !== 'session_totals') {
          finish('deferred', 'empty-window');
          break locked;
        }
        rowFloorMs = lo === Infinity ? null : lo;
      }
      let mode = state.usageMode;
      let store = { available: false, reason: STORE_REASON.NO_SQLITE, rows: [] };
      if (mode !== 'session_totals' && PER_CALL_ENABLED) {
        store = await readUsageRows(sessionId, { afterRowId: live ? state.lastUsageRowId : 0 });
      }
      let useRows = false;
      let useTotals = false;
      let heldReason = null;
      if (mode === 'per_call') {
        if (store.available) useRows = true;
        else if (isStoreGone(store.reason)) {
          // The database itself is gone: advance with zero tokens and stay per_call, so nothing is billed twice.
          errors.push(`usage-store-gone:${store.reason}`);
          recordIssue({ code: DIAGNOSTIC_CODES.USAGE_STORE_GONE, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
        } else heldReason = store.reason;
      } else if (mode === 'session_totals') {
        useTotals = true;
      } else if (store.available && store.rows.length > 0) {
        mode = 'per_call';
        useRows = true;
      } else if (windowHasShutdown) {
        if (store.available || isDefinitiveReason(store.reason)) {
          mode = 'session_totals';
          useTotals = true;
        } else heldReason = store.reason;
      }
      // A held per_call window must not move the cursor: unread rows would have no window left to attach to.
      if (heldReason != null) {
        skipped.usageHeld = true;
        errors.push(`usage-hold:${heldReason}`);
        finish('deferred', 'usage-hold');
        break locked;
      }

      // Step 8: segments and tokens.
      const rootCache = new Map();
      const remoteCache = new Map();
      const timelineCache = new Map();
      // Thousands of git calls in a long audit must not outlast the lock's stale limit.
      const repoRootOf = (dir) => {
        keepLock();
        return resolveRepoRoot(gitImpl, dir, rootCache, map);
      };
      const branchEntry = (root) => {
        let entry = timelineCache.get(root);
        if (!entry) {
          keepLock();
          let timeline = null;
          let headBranch = '(unknown)';
          try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
          // Always resolve current HEAD too: it is the last fallback for a line the reflog and the session's own
          // context cannot place (otherwise those bill to '(unknown)').
          try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
          entry = { timeline, headBranch };
          timelineCache.set(root, entry);
        }
        return entry;
      };
      // Reflog only; buildSegments falls back to the session's own branch, then to headBranchOf.
      const branchOf = (root, ms) => {
        if (!root) return '(unknown)';
        const entry = branchEntry(root);
        return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : '(unknown)';
      };
      const headBranchOf = (root) => (root ? branchEntry(root).headBranch : '(unknown)');
      const resolveRemote = (root) => {
        if (!root) return null;
        if (remoteCache.has(root)) return remoteCache.get(root);
        // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
        // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
        let r = resolveOriginRemote(gitImpl, root);
        if (!r) r = originFromGitConfig(root);
        if (!r) r = knownOrigin(root, map);
        if (r) { upsertRoot(map, root, r); mapDirty = true; }
        remoteCache.set(root, r);
        return r;
      };
      let works;
      let billed = [];
      let lastRowId = null;
      let nextCalls = null;
      try {
        works = buildSegments(events, { sessionId, fromLine: cursor, toLine, cwd, repoRootOf, branchAt: branchOf, headBranchOf });
        if (useRows) {
          let horizonMs = -Infinity;
          for (const e of events) {
            const t = e.timestamp == null ? NaN : Date.parse(e.timestamp);
            if (Number.isFinite(t) && t > horizonMs) horizonMs = t;
          }
          let idle = false;
          try { idle = Date.now() - fs.statSync(transcript).mtimeMs > FINALIZE_IDLE_MS; } catch { /* keep live */ }
          // A cursor first taken from the server (no local one) may sit past lines already billed elsewhere, so their rows are skipped.
          const allowLate = live && !(state.cursorLine == null && cursor > 0);
          // Without the timeline the Auto slice is simply unmeasured.
          let autoPoints = null;
          try { autoPoints = buildAutoTimeline(events); } catch { errors.push('collector:auto-selection'); }
          const attributed = attributeRows(works, store.rows, events, {
            horizonMs, finalize: lastRunFinished(events) || idle, allowLate, windowFromLine: cursor, windowToLine: toLine,
            floorMs: rowFloorMs == null ? -Infinity : rowFloorMs,
            autoPoints,
            // An audit replays from empty state and never saves it, so it under-counts instead of double-counting.
            lastCalls: live ? state.lastCalls : {},
          });
          if (attributed.coldFailed) {
            errors.push('collector:cold-prefix');
            // Partial counters would ship as measured values.
            for (const w of works) w.cold = null;
          }
          lastRowId = attributed.lastRowId;
          nextCalls = live ? attributed.lastCalls : null;
        } else if (useTotals) {
          const skipIds = live ? new Set(state.reportedShutdownLines.map(shutdownKey)) : new Set();
          billed = attributeShutdowns(works, events, { skipIds }).reported;
        }
      } catch (error) {
        skipped.deltaFailed = true;
        // An audit replays old files on demand; only the live stream's failures say anything about the plugin's health.
        if (live) recordIssue({ code: DIAGNOSTIC_CODES.TRANSCRIPT_PARSE_FAILED, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
        finish('failed', 'delta-failed');
        break locked;
      }
      const left = timeLeft();
      if (left != null && left <= 0) {
        errors.push('budget');
        finish('deferred', 'budget');
        break locked;
      }

      // Step 9: collectors and payloads.
      // Whole-file indexes are built once per run and shared by every segment's collectors.
      const completeById = completionsById(events);
      let toolIndex = null;
      try { toolIndex = buildToolIndex(events); } catch { errors.push('collector:tool-failures'); }
      const ctxBase = { sessionId, cwd, state, allEvents: events, hookErrors, completeById, toolIndex };
      // Identity comes from the whole file on every trigger: the window that named a subagent (its subagent.started)
      // is consumed by whichever checkpoint reaches it first, and a later one would never see it again.
      let subagentList = [];
      let subagentInfo = {};
      try {
        subagentList = collectSubagents(events, { sessionId, state });
        subagentInfo = subagentStateMap(subagentList);
      } catch { errors.push('collector:subagents'); }
      const infoFor = (agentId) => (isPlain(subagentInfo[agentId]) ? subagentInfo[agentId] : (isPlain(state.subagents[agentId]) ? state.subagents[agentId] : {}));
      // The stored name is kept when nothing new resolves; a null never overwrites it.
      let resolved = null;
      try { resolved = resolveSessionName(sessionId, windowEvents, transcript); } catch { errors.push('collector:session-name'); }
      sessionName = resolved != null ? resolved : state.sessionName;
      const instructionsCache = new Map();
      const instructionsFor = (root) => {
        if (instructionsCache.has(root)) return instructionsCache.get(root);
        let found;
        try { found = projectInstructions(root); } catch { found = { project_instructions_status: 'unknown' }; }
        instructionsCache.set(root, found);
        return found;
      };
      const timezone = detectTimezone();
      const surface = clientSurfaceOf(sessionId, transcript, events);
      // Wall clock already billed for this session, as merged [startMs, endMs) intervals. The main stream and
      // every subagent cover the SAME stretch of clock, so a segment bills only the part no earlier one claimed.
      let covered = mergeIntervals(state.coveredIntervals);
      let lastPayload = null;
      let touched = false;
      let emitFailed = false;
      for (const work of works) {
        const seg = work.segment;
        const isSub = seg.agentId != null;
        const resolvedRemote = resolveRemote(seg.repoRoot);
        // A main work is never skipped, or the prefix would have a hole (R-04c): the terminal fallback always names it.
        const remote = resolvedRemote == null ? (localRemote(seg.repoRoot == null ? cwd : seg.repoRoot) || UNKNOWN_REMOTE) : resolvedRemote;
        seg.remote = remote;
        const ctx = { ...ctxBase, isSubagent: isSub };
        let operations;
        try { operations = collectOperations(windowEvents, seg, ctx).operations; } catch {
          operations = emptyOperations();
          errors.push('collector:operations');
        }
        // A failed whole-file index is not rebuilt per segment.
        if (toolIndex != null) {
          try {
            const found = collectToolFailures(windowEvents, seg, ctx);
            operations.failures = found.failures;
          } catch { errors.push('collector:tool-failures'); }
        }
        let code_changes;
        try { code_changes = collectCodeChanges(windowEvents, seg, ctx).code_changes; } catch {
          code_changes = emptyCodeChanges();
          errors.push('collector:code-changes');
        }
        let compactions = 0;
        try { compactions = isSub ? 0 : countCompactions(windowEvents, seg); } catch { errors.push('collector:compactions'); }
        // A subagent's context window is not the session's: its context fields never ship.
        const { stats, activeIntervals } = segmentStats(work, { includeContext: !isSub });
        // Main works run first and keep their full span; subagents bill only the residual.
        const durationSec = Math.round(totalMs(subtractIntervals(activeIntervals, covered)) / 1000);
        // Every main work is emitted, even with zero usage and zero duration (R-04c); a subagent that did nothing is covered by the parent report.
        // A subagent's shutdown share is always emitted: it only exists because that agent billed something.
        if (isSub && work.shutdownShare !== true && stats.token_total === 0 && durationSec === 0 && stats.ai_credits_nano == null && !anyPositive(operations)) continue;
        // The server caps segmentId; an over-long subagent id is swapped for its hash, which is the same on every re-emit.
        const agentKey = isSub && `${sessionId}:${seg.agentId}:${seg.fromLine}-${seg.toLine}`.length > SEGMENT_ID_MAX
          ? crypto.createHash('sha1').update(seg.agentId).digest('hex')
          : seg.agentId;
        const scope = isSub ? `${sessionId}:${agentKey}` : sessionId;
        const info = isSub ? infoFor(seg.agentId) : {};
        const payload = {
          segmentId: `${scope}:${seg.fromLine}-${seg.toLine}`,
          sessionId,
          remote,
          branch: clamp(seg.branch, BRANCH_MAX),
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...identity,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...instructionsFor(seg.repoRoot),
          ...(compactions > 0 ? { compactions } : {}),
          ...(!isSub && surface != null ? { source: surface } : {}),
          ...(isSub ? {
            is_subagent: true,
            agent_id: clamp(seg.agentId, AGENT_NAME_MAX),
            agent_type: clamp(info.agentType == null ? null : info.agentType, AGENT_TYPE_MAX),
            agent_name: clamp(info.agentName == null ? null : info.agentName, AGENT_NAME_MAX),
            spawn_depth: info.spawnDepth == null ? null : info.spawnDepth,
          } : {}),
          ...stats,
          code_changes,
          operations,
          usage_source: mode == null ? 'session_totals' : mode,
          duration_sec: durationSec,
        };
        if (!touched) {
          lock.touch();
          touched = true;
        }
        // Any write failure keeps the cursor put, so the next checkpoint re-emits the same segmentIds.
        try {
          emit(payload);
          if (activeIntervals.length) covered = claimIntervals(covered, activeIntervals);
          lastPayload = payload;
          out.segmentsQueued += 1;
        } catch {
          if (isSub) skipped.emitFailed += 1;
          emitFailed = true;
          break;
        }
      }
      if (emitFailed) {
        finish('failed', 'emit-failed');
        break locked;
      }

      // Step 10: the cursor patch, only after every queue file is complete on disk (R-04f).
      if (live) {
        lock.touch();
        const lastEvent = events.length > 0 ? events[events.length - 1] : null;
        const saved = saveSessionState(sessionId, (cur) => ({
          cursorLine: toLine,
          cursorEvent: lastEvent == null ? null : { id: lastEvent.id, line: lastEvent.line },
          cursorTrail: trailAfter(cur, events, lastEvent),
          usageMode: mode,
          ...(lastRowId == null ? {} : { lastUsageRowId: lastRowId }),
          ...(nextCalls == null ? {} : { lastCalls: nextCalls }),
          ...(establishing && rowFloorMs != null ? { usageRowFloorMs: rowFloorMs } : {}),
          reportedShutdownLines: [...cur.reportedShutdownLines, ...billed].slice(-MAX_SHUTDOWN_REFS),
          coveredIntervals: covered,
          subagents: { ...cur.subagents, ...subagentInfo },
          transcriptPath: transcript,
          cwd: cwd == null ? null : cwd,
          ...(lastPayload == null ? {} : { lastReport: lastPayload, ...(sessionName != null ? { sessionName } : {}) }),
        }));
        if (!saved) {
          errors.push('state-write-failed');
          finish('failed', 'internal');
          break locked;
        }
      }
      consumed = true;
      finish('committed', null);

      // Step 11: replay the last report when only the session name changed.
      if (live && out.segmentsQueued === 0 && sessionName != null && sessionName !== state.sessionName && state.lastReport != null) {
        try {
          emit({ ...state.lastReport, session_name: sessionName });
          namePatch = sessionName;
        } catch { /* best-effort; retried next checkpoint */ }
      }
    }

    // The tail runs after every outcome except a busy lock: errors, timeline, quota, second patch, flush.
    if (state == null) state = live ? loadSessionState(sessionId) : auditState(loadSessionState(sessionId));
    const delivered = new Set();
    let undelivered = [];
    let errorsChanged = false;

    // Step 12: session errors.
    let fresh = [];
    try {
      fresh = collectErrors(consumed ? windowEvents : [], { sessionId, cwd, isSubagent: false, state, allEvents: events, hookErrors });
    } catch { errors.push('collector:errors'); }
    fresh = (Array.isArray(fresh) ? fresh : []).filter(validError).map((e) => ({ ...e, sessionId }));
    if (options.collectSessionErrors) {
      sessionErrors.push(...fresh);
    } else if (live) {
      const candidates = dedupeErrors([...state.pendingErrors, ...fresh]);
      const targets = expandTargets(liveSenders, workspaceState);
      for (const e of candidates) {
        const left = timeLeft();
        if (targets.length === 0 || (left != null && left <= 0)) {
          undelivered.push(e);
          continue;
        }
        const results = await Promise.all(targets.map((s) => postSessionError({ ...e, sessionId }, s, { fetchImpl, timeoutMs: cap(ERROR_POST_TIMEOUT_MS) })));
        if (results.every(isSettledPost)) delivered.add(errorKey(e));
        else undelivered.push(e);
      }
      undelivered = undelivered.slice(-MAX_PENDING_ERRORS);
      const known = new Set(state.pendingErrors.map(errorKey));
      errorsChanged = delivered.size > 0 || undelivered.some((e) => !known.has(errorKey(e)));
    }

    // Step 13: the whole-session timeline, re-posted only when its content changed.
    let nextTimelineHash = null;
    const leftForTimeline = timeLeft();
    if (withTimeline && consumed && live && liveSenders.length > 0 && (leftForTimeline == null || leftForTimeline > 0)) {
      try {
        const timeline = buildTimeline(sessionId, events);
        if (timeline != null && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
          // The sender list is part of the hash so a newly answered workspace still gets the timeline; generated_at never is.
          const senderSig = senders.map((s) => `${s.key}:${s.tenantId}`).sort().join(',');
          const hash = crypto.createHash('sha1')
            .update(JSON.stringify([timeline.periods, timeline.plan_events, timeline.subagents, senderSig]))
            .digest('hex');
          if (hash !== state.timelineHash) {
            const results = await Promise.all(liveSenders.map((s) => postSessionTimeline(timeline, s, { fetchImpl, timeoutMs: cap(ERROR_POST_TIMEOUT_MS) })));
            // Only remembered once every account has an answer that will not change, so a failed post retries next turn.
            if (liveSenders.length === senders.length && results.every(isSettledPost)) nextTimelineHash = hash;
          }
        }
      } catch { errors.push('timeline-failed'); }
    }

    // Step 14: the monthly quota snapshot; the checkpoint never starts the Copilot runtime inline (R-06).
    const leftForQuota = timeLeft();
    if (withQuota && live && liveSenders.length > 0 && (leftForQuota == null || leftForQuota > 1000)) {
      try {
        const quota = readCachedQuota();
        await maybePostUsageSnapshot({ sessions: senders, quota, budgetMs: timeLeft(), fetchImpl });
      } catch { errors.push('quota-failed'); }
    }

    // Step 15: second patch, then the flush with the lock already released.
    if (live && (errorsChanged || nextTimelineHash != null || namePatch != null)) {
      if (lock != null) lock.touch();
      // Errors parked meanwhile by a busy run survive: only what this run delivered is removed.
      saveSessionState(sessionId, (cur) => ({
        ...(errorsChanged ? {
          pendingErrors: dedupeErrors([...cur.pendingErrors.filter((e) => !delivered.has(errorKey(e))), ...undelivered]).slice(-MAX_PENDING_ERRORS),
        } : {}),
        ...(nextTimelineHash == null ? {} : { timelineHash: nextTimelineHash }),
        ...(namePatch == null ? {} : { sessionName: namePatch }),
      }));
    }
    if (mapDirty && live) {
      try { saveRepoMap(map); } catch { /* best-effort */ }
    }
    unlock();

    if (!options.skipFlush) {
      out.flushed = await flushPlans(plans, { fetchImpl, deadline, getAccessToken: deps.getAccessToken, errors });
    }
  };

  try {
    await run();
  } catch (error) {
    out.outcome = 'failed';
    out.reason = 'internal';
    recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
  } finally {
    unlock();
  }
  return out;
}

// Once tracking is off, queued reports are held for this long: a tenant that converts to paid
// inside the window flushes them normally on its first live session; after it they expire.
export { QUEUE_HOLD_MS };

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now = Date.now()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// Queue names are <scope>_<from>-<to>[__<tag>].json (segmentName), so the window parses from the name without a read.
const QUEUE_NAME_RE = /^(.*)_(\d+)-(\d+)(?:__(?:(?!__)[\s\S])*)?\.json$/;

// Sorts by scope (sessionId plus agent), from_line, then to_line, so a narrower window posts before the wider one that supersedes it.
function sortQueueFiles(files) {
  const keyed = files.map((name) => {
    const m = QUEUE_NAME_RE.exec(name);
    return m ? { name, scope: m[1], from: Number(m[2]), to: Number(m[3]) } : { name, scope: name, from: 0, to: 0 };
  });
  keyed.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)
    || a.from - b.from || a.to - b.to || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return keyed.map((k) => k.name);
}

// Returns { flushed, rejected, failed, expired, salvaged, quarantined, workspacePending, deferred, trackingDisabled, lastError } —
// flushed = accepted (2xx), rejected = permanently declined by the server (4xx, e.g. branch not
// linked), failed = transient or reversible (5xx/network/code-less 403, file kept for retry),
// expired = held files past the 3-day window, workspacePending = held until a rule or New folders
// picks a workspace, deferred = files left untouched because deps.deadline passed,
// trackingDisabled = the server said the workspace is dark (audit mode) and the flush stopped.
export async function flushQueue(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : null;
  const now = deps.now == null ? Date.now : deps.now;
  const result = { flushed: 0, rejected: 0, failed: 0, expired: 0, salvaged: 0, quarantined: 0, workspacePending: 0, deferred: 0, trackingDisabled: false, lastError: null };
  const dir = queueDir(session.key);
  const tenants = tenantsOf(session);
  const multiTenant = isMultiTenant(session);
  const workspaceCache = new Map();
  const workspaceOf = (sessionId) => {
    if (!workspaceCache.has(sessionId)) {
      let state = null;
      try { state = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
      workspaceCache.set(sessionId, state);
    }
    return workspaceCache.get(sessionId);
  };
  const isMember = (tenantId) => tenants != null && tenants.some((t) => t.id === tenantId);

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire. Several workspaces go dark per tenant below.
  const trackingState = readTrackingState(session.key);
  const darkThisFlush = new Set();
  if (!multiTenant && !isLiveTrackingAllowed(trackingState)) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result);
    return result;
  }

  // A 401 is authentication, not a verdict on the payload, so it must not count as a permanent
  // rejection — that would delete queued analytics that were never actually refused. Renew once
  // for the whole flush and retry; if renewal fails, keep every file for the next attempt.
  let current = session;
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    if (deadline != null && now() >= deadline) return null;
    renewed = true;
    const next = await getAccessToken({}, { account: session.key, forceRefresh: true }).catch(() => null);
    if (next && next !== current.token) { current = { ...current, token: next }; return current; }
    return null;
  };

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    files = sortQueueFiles(fs.readdirSync(dir));
  } catch {
    return result;
  }

  // Indexed rather than for..of: a released held file adds its per-tenant copies to this same pass.
  for (let index = 0; index < files.length; index++) {
    // Budget spent: leave the rest untouched for the next flush.
    if (deadline != null && now() >= deadline) {
      result.deferred = files.length - index;
      break;
    }
    const file = files[index];
    // Only queued payloads. Skips the `.tmp` of a writer that died mid-write and the `.corrupt`
    // files quarantined below, neither of which is ever postable; pruneStale expires both.
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const { value, salvaged } = readJsonSalvaged(filePath);
    const entry = unwrapQueueFile(value);
    const payload = entry.payload;
    // Nothing recoverable, or what came back is not a postable payload. Quarantine rather than
    // `continue`: an unparseable file used to be re-read on every flush forever, invisibly, and
    // the session's analytics were lost without a signal. A cleanly parsed payload is posted
    // exactly as before — the server stays the judge of its contents.
    if (payload == null || (salvaged && payload.segmentId == null)) {
      result.quarantined += 1;
      recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FILE_QUARANTINED, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
      try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
      continue;
    }
    if (salvaged) result.salvaged += 1;

    let mtimeMs = null;
    const ageMs = () => {
      if (mtimeMs == null) {
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { mtimeMs = Date.now(); }
      }
      return Date.now() - mtimeMs;
    };
    // Past the hold window a multi-workspace retry expires instead of failing forever.
    const failOrExpire = () => {
      if (multiTenant && ageMs() > QUEUE_HOLD_MS) {
        try { fs.unlinkSync(filePath); result.expired += 1; return; } catch { /* counted failed */ }
      }
      result.failed += 1;
    };

    // A held or unstamped file is expanded into per-tenant copies, which this same pass posts.
    if (multiTenant && (entry.hold != null || entry.tenantId == null)) {
      let released;
      // A corrupt held file must not break the whole flush.
      try { released = releaseHeldFile(filePath, session, workspaceOf(payload.sessionId)); } catch { result.failed += 1; continue; }
      // Re-sorts the unvisited tail with the copies so a narrower window still posts before a wider one.
      if (released.written.length > 0) {
        const tail = files.slice(index + 1);
        const added = released.written.filter((name) => tail.indexOf(name) === -1);
        files = files.slice(0, index + 1).concat(sortQueueFiles(tail.concat(added)));
      }
      if (released.expired) result.expired += 1;
      else if (!released.deleted) result.workspacePending += 1;
      continue;
    }
    // A held file on a now single-workspace account waits out the hold window.
    if (entry.hold != null) {
      if (ageMs() <= QUEUE_HOLD_MS) {
        result.workspacePending += 1;
      } else {
        try { fs.unlinkSync(filePath); result.expired += 1; } catch { /* best-effort */ }
      }
      continue;
    }

    // A stamp for a workspace the account has left is held for it, never re-routed; old servers send no header.
    if (entry.tenantId != null && tenants != null && !isMember(entry.tenantId)) {
      if (ageMs() <= QUEUE_HOLD_MS) {
        result.workspacePending += 1;
      } else {
        try { fs.unlinkSync(filePath); result.expired += 1; } catch { /* best-effort */ }
      }
      continue;
    }
    // One or unknown workspaces post headerless, whatever the file was stamped with.
    const tenantId = multiTenant ? entry.tenantId : null;
    // A dark tenant's reports are dropped, not retried.
    if (multiTenant && (darkThisFlush.has(tenantId) || isTenantDark(trackingState, tenantId))) {
      try { fs.unlinkSync(filePath); result.rejected += 1; } catch { /* best-effort */ }
      continue;
    }

    // With a deadline each request is capped by what is left of it; without one postJson keeps its own default.
    const postDeps = deadline == null ? { fetchImpl } : { fetchImpl, timeoutMs: Math.max(1, Math.min(3000, deadline - now())) };
    try {
      let res = await postJson(reportUrl, { ...current, tenantId }, payload, postDeps);
      // 401 only: a 403 is authenticated-but-not-permitted, which no new token resolves.
      if (res.status === 401) {
        const next = await renewToken();
        if (next) res = await postJson(reportUrl, { ...next, tenantId }, payload, postDeps);
      }
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status === 401) {
        // Still unauthenticated after a renewal attempt — keep the file; the payload was
        // never judged, and re-linking should let it through later.
        failOrExpire();
        result.lastError = `HTTP ${res.status}`;
      } else if (res.status === 403) {
        // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
        // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
        // flush if the tenant converts within the window, and expire after it. A code-less 403
        // (seat revoked, deactivated user) is reversible: keep the file, count it failed. With several
        // workspaces only that tenant goes dark: its files are dropped and the account keeps flushing.
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON body */ }
        if (body != null && body.code === 'TRACKING_DISABLED' && multiTenant) {
          try { markTenantDark(session.key, tenantId); } catch { /* best-effort */ }
          darkThisFlush.add(tenantId);
          result.rejected += 1;
          result.lastError = body.message == null ? 'HTTP 403' : body.message;
          try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
          continue;
        }
        if (body != null && body.code === 'TRACKING_DISABLED') {
          try { markTrackingDisabled(session.key, body.message == null ? null : body.message); } catch { /* best-effort */ }
          result.trackingDisabled = true;
          result.lastError = body.message == null ? 'HTTP 403' : body.message;
          sweepHeldQueue(dir, result);
          break;
        }
        failOrExpire();
        result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        try {
          const body = await res.json();
          result.lastError = body == null || body.message == null ? `HTTP ${res.status}` : body.message;
        } catch {
          result.lastError = `HTTP ${res.status}`;
        }
        fs.unlinkSync(filePath);
      } else {
        failOrExpire(); // keep for retry
        recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.CHECKPOINT, httpStatus: res.status });
      }
    } catch {
      failOrExpire(); // keep file for retry on network error / throw
    }
  }

  return result;
}
