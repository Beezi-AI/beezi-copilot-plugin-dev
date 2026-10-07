import path from 'path';
import { beeziHome } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { listSessionFiles, readSessionHead } from './transcript-index-copilot.mjs';
import { isUsableSessionId, loadSessionState } from './session-state.mjs';
import { runCheckpoint } from './checkpoint.mjs';
import { runVscodeCheckpoint, vscodeCursorOf } from './vscode-checkpoint.mjs';
import { listVscodeSessions } from './vscode-chat-session.mjs';
import { establishStart } from './session-coverage.mjs';
import {
  runAudit,
  planHistoryRuns,
  acquireLease,
  readLease,
  leaseHolderAlive,
  SYNC_MODE,
  ACTIVE_SESSION_WINDOW_MS,
  MAX_TRANSCRIPT_BYTES,
} from './session-audit.mjs';
import { linkedSessions } from './sessions.mjs';
import { listAccounts, AccountStatus } from './accounts.mjs';
import { readTrackingState, allowsLiveFor } from './tracking.mjs';
import { createRouteContext, routeForDir, usesRules } from './workspace-rules.mjs';
import { accountRowFor, isMultiTenant, tenantsOf, readSessionWorkspace, resolveTargets } from './workspace.mjs';
import { loadLedger, isComplete } from './audit-ledger.mjs';
import { recordIssue } from './telemetry.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';

// MCP-server session watcher: session-agnostic (the process has no session id), every report comes from the checkpoint engine, and it never touches stdout (JSON-RPC): all output goes through `log`.

export const WATCHER_ENV_VAR = 'BEEZI_COPILOT_WATCHER';

const FALSE_VALUES = ['0', 'false', 'no', 'off', 'disabled'];

const TICK_MS = 20000;
const ELECTION_NAME = 'watcher-election';
// 4.5 ticks, so a renew never races its own expiry.
const ELECTION_LEASE_MS = 90000;
const SESSION_COOLDOWN_MS = 60000;
const MAX_SESSIONS_PER_PASS = 5;
const MAX_ESTABLISH_PER_PASS = 2;
const CHECKPOINT_BUDGET_MS = 8000;
const HOOK_QUIET_MS = 5 * 60 * 1000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HISTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_PER_PASS = 50;
const MAX_OBSERVATIONS = 2000;
// The scan stamp is written at least this often even when nothing else changed.
const STATUS_SAVE_MS = 60000;
const MAX_LOGGED_REASONS = 500;
const WATERMARK_VERSION = 1;

// False only for an explicit off value (trimmed, any case).
export function isWatcherEnabled(env) {
  const raw = env == null ? undefined : env[WATCHER_ENV_VAR];
  if (typeof raw !== 'string') return true;
  return FALSE_VALUES.indexOf(raw.trim().toLowerCase()) === -1;
}

// ── The observation watermark ──────────────────────────────────────────────────────────────────

// Data-root level, outside state/, so pruneStale never deletes it; it records what was last SEEN, never which lines to read.
function watcherFile() {
  return path.join(beeziHome(), 'watcher.json');
}

function isPlain(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function number(value) {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function emptyWatermark() {
  return { version: WATERMARK_VERSION, sessions: {}, housekeepingAt: null, lastScanAt: null, historyAt: {}, updatedAt: null };
}

// Any other version is discarded rather than migrated.
function loadWatermark() {
  let raw = null;
  try { raw = readJson(watcherFile(), null); } catch { raw = null; }
  if (!isPlain(raw) || raw.version !== WATERMARK_VERSION) return emptyWatermark();
  return {
    version: WATERMARK_VERSION,
    sessions: isPlain(raw.sessions) ? raw.sessions : {},
    housekeepingAt: number(raw.housekeepingAt),
    lastScanAt: number(raw.lastScanAt),
    historyAt: isPlain(raw.historyAt) ? raw.historyAt : {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function saveWatermark(record) {
  try {
    writeJsonSecure(watcherFile(), { ...record, updatedAt: new Date().toISOString() });
  } catch { /* a watermark that could not be saved costs one repeated read next pass */ }
}

// The stored observation of a session, or null when it has no usable mtime.
function observationFor(record, sessionId) {
  if (!Object.prototype.hasOwnProperty.call(record.sessions, sessionId)) return null;
  const entry = record.sessions[sessionId];
  return isPlain(entry) && number(entry.mtimeMs) !== null ? entry : null;
}

function keptField(entry, field) {
  return isPlain(entry) && number(entry[field]) !== null ? entry[field] : null;
}

// Bounded and cleaned: evict the oldest observation first, and drop sessions no longer listed. Returns whether anything went.
function trimWatermark(record, listedIds) {
  let changed = false;
  for (const id of Object.keys(record.sessions)) {
    if (!listedIds.has(id)) { delete record.sessions[id]; changed = true; }
  }
  const ids = Object.keys(record.sessions);
  if (ids.length > MAX_OBSERVATIONS) {
    const at = (id) => (isPlain(record.sessions[id]) && number(record.sessions[id].at) !== null ? record.sessions[id].at : 0);
    ids.sort((a, b) => at(a) - at(b));
    for (let i = 0; i < ids.length - MAX_OBSERVATIONS; i += 1) delete record.sessions[ids[i]];
    changed = true;
  }
  return changed;
}

// ── Status for /beezi-staging-status ───────────────────────────────────────────────────────────────────

// Synchronous, takes no lock, never throws; null when the watcher is off or has left no trace.
export function readWatcherStatus() {
  try {
    if (!isWatcherEnabled(process.env)) return null;
    const record = readJson(watcherFile(), null);
    const lease = readLease(ELECTION_NAME);
    if (!isPlain(record) && lease == null) return null;
    const lastScanAt = isPlain(record) ? number(record.lastScanAt) : null;
    const running = lease != null && Date.now() - lease.renewedAt <= ELECTION_LEASE_MS && leaseHolderAlive(lease);
    return { running, lastScanAt, electedPid: lease == null ? null : lease.pid };
  } catch {
    return null;
  }
}

// ── Planning (pure over the scan and the watermark) ────────────────────────────────────────────

function changedSince(prior, entry) {
  if (prior == null) return true;
  if (entry.mtimeMs > prior.mtimeMs) return true;
  // `!==` rather than `>`: a shrink is also a change, so the engine gets to report a cursor mismatch (V-43).
  return number(prior.size) !== null && entry.size !== prior.size;
}

// due = established and changed past cooldown; fresh = unestablished and active; quiet = unestablished, changed and idle. Hook deference only reduces load.
function planPass({ entries, record, nowMs, readState, isExcluded }) {
  const candidates = [];
  const fresh = [];
  const quiet = [];
  const hookStamps = [];
  const oversizeNew = [];
  let cooling = 0;
  let hookActive = 0;

  for (const entry of entries) {
    const id = entry.sessionId;
    const prior = observationFor(record, id);
    if (entry.size > MAX_TRANSCRIPT_BYTES) {
      if (prior == null || keptField(prior, 'oversizeAt') === null) oversizeNew.push(entry);
      continue;
    }
    if (!changedSince(prior, entry)) continue;
    const active = nowMs - entry.mtimeMs <= ACTIVE_SESSION_WINDOW_MS;
    // A machine with thousands of old sessions stays at one stat each: no state read for an idle, never-seen session.
    if (!active && prior == null) { quiet.push({ entry, prior, state: null }); continue; }
    const state = readState(entry);
    if (!Number.isInteger(state.cursorLine)) {
      (active ? fresh : quiet).push({ entry, prior, state });
      continue;
    }
    let hookSeenAt = prior == null ? null : keptField(prior, 'hookSeenAt');
    // A hook advanced the cursor since the watcher last did.
    if (prior != null && Number.isInteger(prior.cursorAfter) && state.cursorLine > prior.cursorAfter) {
      hookSeenAt = nowMs;
      hookStamps.push([id, nowMs]);
    }
    if (hookSeenAt !== null && nowMs - hookSeenAt < HOOK_QUIET_MS) { hookActive += 1; continue; }
    if (prior != null && number(prior.at) !== null && nowMs - prior.at < SESSION_COOLDOWN_MS) { cooling += 1; continue; }
    candidates.push({ entry, prior, state });
  }

  // An excluded session is dropped before the per-pass slice, so it never takes a slot from a tracked one; it is re-judged every pass, so removing the rule resumes capture.
  const kept = (items) => items.filter((item) => !isExcluded(item));
  const due = kept(candidates);
  const freshKept = kept(fresh);

  const lastAt = (item) => (item.prior != null && number(item.prior.at) !== null ? item.prior.at : 0);
  // Oldest observation first, for fairness.
  due.sort((a, b) => lastAt(a) - lastAt(b));
  freshKept.sort((a, b) => lastAt(a) - lastAt(b) || a.entry.mtimeMs - b.entry.mtimeMs);
  return { due: due.slice(0, MAX_SESSIONS_PER_PASS), fresh: freshKept, quiet, cooling, hookActive, hookStamps, oversizeNew };
}

// ── Helpers for one pass ───────────────────────────────────────────────────────────────────────

// VS Code Local-agent sessions as scan entries: no transcriptPath (nothing here reads VS Code's transcript), the chat file and folder instead.
function vscodeEntries(cliIds) {
  const out = [];
  for (const s of listVscodeSessions()) {
    if (!isUsableSessionId(s.sessionId) || cliIds.has(s.sessionId)) continue;
    out.push({ sessionId: s.sessionId, transcriptPath: null, file: s.file, folder: s.folder, mtimeMs: s.mtimeMs, size: s.size, kind: 'vscode' });
  }
  return out;
}

// What planning reads of a session: a VS Code one's cursor is its own (requests reported), its cwd the folder it was opened in.
function readStateFor(entry) {
  if (entry.kind !== 'vscode') return loadSessionState(entry.sessionId);
  const v = loadSessionState(entry.sessionId).vscode;
  return { cursorLine: v == null ? null : v.cursor, cwd: entry.folder || (v == null ? null : v.cwd) };
}

function cursorAfterRun(entry) {
  return entry.kind === 'vscode' ? vscodeCursorOf(entry.sessionId) : loadSessionState(entry.sessionId).cursorLine;
}

function messageOf(error) {
  return error != null && typeof error.message === 'string' && error.message !== '' ? error.message : 'unknown error';
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function headCwd(transcriptPath) {
  try {
    const head = readSessionHead(transcriptPath);
    return head == null ? null : nonEmpty(head.cwd);
  } catch {
    return null;
  }
}

function yieldToLoop() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// The recipients a session still sends to: a recipient it excludes (no target, no held ask) gets no coverage request.
// A session SessionStart never bound resolves against the route the checkpoint's bind fallback would give it from the same folder (never written here).
function recipientsFor(item, recipients, routeCtx) {
  const id = item.entry.sessionId;
  let state = null;
  try { state = readSessionWorkspace(id); } catch { /* unreadable = unanswered */ }
  if (state == null) {
    try {
      const cwd = nonEmpty(item.state == null ? null : item.state.cwd) || headCwd(item.entry.transcriptPath);
      if (cwd != null) {
        const route = {};
        let any = false;
        for (const recipient of recipients) {
          if (!usesRules(recipient)) continue;
          any = true;
          route[recipient.key] = routeForDir(recipient, cwd, routeCtx);
        }
        if (any) state = { cwd, route };
      }
    } catch { /* no known folder: every recipient, as before */ }
  }
  return recipients.filter((recipient) => {
    const resolved = resolveTargets(recipient, state);
    const tenantId = recipient.tenantId == null ? null : recipient.tenantId;
    return resolved.targets.includes(tenantId) || (resolved.pendingAsk && resolved.askTenants.includes(tenantId));
  });
}

// One session per workspace live tracking is on for; the row comes from accountRowFor since linked sessions may lack `tenants`, and a missing tracking cache reads as allowed.
function liveRecipients(sessions) {
  const out = [];
  for (const session of sessions) {
    try {
      const row = accountRowFor(session);
      const tracking = readTrackingState(session.key);
      const view = { ...session, tenants: row.tenants };
      if (isMultiTenant(row)) {
        for (const tenant of tenantsOf(row) || []) {
          if (allowsLiveFor({ ...view, tenantId: tenant.id }, tracking)) out.push({ ...session, tenantId: tenant.id });
        }
      } else if (allowsLiveFor({ ...view, tenantId: null }, tracking)) {
        out.push({ ...session, tenantId: null });
      }
    } catch { /* an account whose state cannot be read is skipped this pass */ }
  }
  return out;
}

// Lazy import of Plan 06's housekeeping so the watcher stays loadable without it.
async function housekeeping() {
  const mod = await import('./session-start.mjs');
  if (typeof mod.runHousekeeping !== 'function') return;
  await mod.runHousekeeping({ budgetMs: 10000, reason: 'watcher' });
}

// The account's one-time backfill is sealed: the local flag for a single-workspace account, every reached workspace's ledger otherwise.
function backfillSealed(row, identity, plan) {
  if (!isMultiTenant(row)) {
    const tracking = readTrackingState(row.key);
    return tracking != null && tracking.backfillCompleted === true;
  }
  return plan.runs.length > 0 && plan.runs.every((run) => isComplete(loadLedger(row.key, identity, run.tenantId)));
}

// ── One pass ───────────────────────────────────────────────────────────────────────────────────

// ctx: { say, alive(), renew(), reasons: Map, savedAt }. Never throws: each step has its own try/catch that counts an error.
async function runWatchPass(ctx) {
  const { say, alive, renew } = ctx;
  const nowMs = Date.now();
  const summary = { reason: null, checkpointed: 0, committed: 0, established: 0, deferred: 0, cooling: 0, hookActive: 0, errors: 0 };
  const record = loadWatermark();
  let dirty = false;

  const fail = (step, error) => {
    summary.errors += 1;
    say(`watcher ${step} failed: ${messageOf(error)}`);
  };
  const finish = (reason) => {
    summary.reason = reason;
    if (dirty || Date.now() - ctx.savedAt >= STATUS_SAVE_MS) {
      saveWatermark(record);
      ctx.savedAt = Date.now();
    }
    if (summary.checkpointed + summary.deferred + summary.cooling + summary.hookActive + summary.errors > 0) {
      say(
        `watcher pass: checkpointed=${summary.checkpointed} committed=${summary.committed} established=${summary.established} `
          + `deferred=${summary.deferred} cooling=${summary.cooling} hookActive=${summary.hookActive} errors=${summary.errors}`,
      );
    }
    return summary;
  };
  const noteReason = (id, reason) => {
    if (ctx.reasons.get(id) === reason) return;
    if (ctx.reasons.size >= MAX_LOGGED_REASONS) ctx.reasons.clear();
    ctx.reasons.set(id, reason);
    say(`watcher: ${id} ${reason}`);
  };

  // 1. Housekeeping runs before the link check: an unlinked machine still accumulates state, and where SessionStart never fires this is the only housekeeping.
  if (record.housekeepingAt === null || nowMs - record.housekeepingAt >= HOUSEKEEPING_INTERVAL_MS) {
    try { await housekeeping(); } catch (error) { fail('housekeeping', error); }
    record.housekeepingAt = Date.now();
    dirty = true;
    if (!alive()) return finish('stopped');
  }

  // 2. Link check. Silent when nothing is linked: the MCP server must not be disturbed by a machine that is not signed in.
  let sessions = [];
  try { sessions = await linkedSessions(); } catch { sessions = []; }
  if (!Array.isArray(sessions) || sessions.length === 0) return finish('unlinked');
  if (!alive()) return finish('stopped');

  // 3. Scan: stat only, every root.
  let entries = [];
  try {
    entries = listSessionFiles().filter((entry) => entry != null && isUsableSessionId(entry.sessionId));
    entries = entries.concat(vscodeEntries(new Set(entries.map((entry) => entry.sessionId))));
  } catch (error) {
    fail('scan', error);
    return finish('scan-failed');
  }
  record.lastScanAt = Date.now();
  await yieldToLoop();
  if (!renew()) return finish('lost');

  // Live capture (paths A and B) only when some linked account still allows it.
  const recipients = liveRecipients(sessions);
  const live = recipients.length > 0;
  const routeCtx = createRouteContext();

  // 4. Plan.
  const plan = planPass({
    entries, record, nowMs, readState: readStateFor,
    isExcluded: (item) => live && recipientsFor(item, recipients, routeCtx).length === 0,
  });
  summary.cooling = plan.cooling;
  summary.hookActive = plan.hookActive;
  for (const [id, at] of plan.hookStamps) {
    if (isPlain(record.sessions[id])) { record.sessions[id].hookSeenAt = at; dirty = true; }
  }
  for (const entry of plan.oversizeNew) {
    say(`watcher: ${entry.sessionId} events.jsonl over 64 MB — not captured by the watcher`);
    const prior = record.sessions[entry.sessionId];
    record.sessions[entry.sessionId] = {
      mtimeMs: entry.mtimeMs, size: entry.size, at: nowMs, cursorAfter: keptField(prior, 'cursorAfter'), hookSeenAt: keptField(prior, 'hookSeenAt'), oversizeAt: nowMs,
    };
    dirty = true;
  }

  // Sessions that never showed hook activity (Agent Host) get their timeline and quota snapshot from the watcher (V-02 default: not every hook fires there).
  const noHook = (prior) => prior == null || keptField(prior, 'hookSeenAt') === null;

  const checkpointOne = async (item, inputExtra, options) => {
    const { entry, prior, state } = item;
    const id = entry.sessionId;
    summary.checkpointed += 1;
    let result = null;
    try {
      result = await (entry.kind === 'vscode' ? runVscodeCheckpoint : runCheckpoint)(
        {
          sessionId: id,
          transcriptPath: entry.transcriptPath,
          ...(entry.kind === 'vscode' ? { file: entry.file } : {}),
          cwd: nonEmpty(state.cwd) || headCwd(entry.transcriptPath),
          trigger: 'watcher',
          budgetMs: CHECKPOINT_BUDGET_MS,
          ...inputExtra,
        },
        {},
        options,
      );
    } catch (error) {
      summary.errors += 1;
      noteReason(id, `checkpoint threw: ${messageOf(error)}`);
      return false;
    }
    if (result != null && result.outcome === 'committed') {
      ctx.reasons.delete(id);
      summary.committed += 1;
      // The observation taken BEFORE the run (never a fresh stat), so a file that grew meanwhile stays due; zero segments still count.
      const stored = record.sessions[id];
      record.sessions[id] = {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        at: Date.now(),
        cursorAfter: cursorAfterRun(entry),
        hookSeenAt: keptField(stored, 'hookSeenAt'),
        oversizeAt: keptField(stored, 'oversizeAt'),
      };
      dirty = true;
      return true;
    }
    // No activity yet: the pre-run observation is recorded with no cursor, so the session is retried only once its file changes.
    if (result != null && result.reason === 'no-activity') {
      const stored = record.sessions[id];
      record.sessions[id] = {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        at: Date.now(),
        cursorAfter: null,
        hookSeenAt: keptField(stored, 'hookSeenAt'),
        oversizeAt: keptField(stored, 'oversizeAt'),
      };
      dirty = true;
      summary.deferred += 1;
      noteReason(id, result.reason);
      return false;
    }
    // Deferred or failed: nothing is recorded, so the session stays due (a deferred window with no reports is not consumed, not empty).
    if (result != null && result.outcome === 'failed') summary.errors += 1;
    else summary.deferred += 1;
    noteReason(id, result == null ? 'no result' : (result.reason == null ? result.outcome : result.reason));
    return false;
  };

  // Path A: established sessions, an ordinary incremental checkpoint (routing and the live gate are the engine's).
  if (live) {
    for (const item of plan.due) {
      if (!alive()) return finish('stopped');
      const noHookYet = noHook(item.prior);
      await checkpointOne(item, { withTimeline: noHookYet, withQuota: noHookYet }, {});
      await yieldToLoop();
    }
    if (!renew()) return finish('lost');
  }

  // Path B: unestablished and active (history refuses these, so every hook-less Agent Host session lands here); the start line comes from the shared coverage rule.
  if (live && plan.fresh.length > 0) {
    for (const item of plan.fresh.slice(0, MAX_ESTABLISH_PER_PASS)) {
      if (!alive()) return finish('stopped');
      const id = item.entry.sessionId;
      let start = null;
      try { start = await establishStart(id, recipientsFor(item, recipients, routeCtx), { timeoutMs: 5000 }); } catch { start = null; }
      if (start == null || !Number.isInteger(start.startLine)) {
        summary.deferred += 1;
        noteReason(id, `establish deferred: ${start != null && start.reason != null ? start.reason : 'no answer'}`);
        continue;
      }
      // In live mode the engine starts at max(startCursor, state.cursorLine ?? 0), so a cursor a hook wrote meanwhile is never walked back.
      const ok = await checkpointOne(item, { withTimeline: true, withQuota: noHook(item.prior) }, { startCursor: start.startLine });
      if (ok) summary.established += 1;
      await yieldToLoop();
    }
    if (!renew()) return finish('lost');
  }

  // Path C: unestablished and idle is history, so it goes through sync, and only once the login import has sealed: the watcher never performs or front-runs it.
  if (live && plan.quiet.length > 0 && alive()) {
    let rows = [];
    try {
      rows = (await listAccounts()).filter((row) => row.status === AccountStatus.LINKED);
    } catch (error) {
      fail('history', error);
    }
    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
    // Newest quiet sessions are the likeliest to need repair; the rest wait for the next history pass.
    const batch = plan.quiet.map((item) => item.entry).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_HISTORY_PER_PASS);
    const ids = batch.map((entry) => entry.sessionId);
    for (const row of rows) {
      if (!alive()) break;
      const last = number(record.historyAt[row.key]);
      if (last !== null && Date.now() - last < HISTORY_INTERVAL_MS) continue;
      if (!recipients.some((r) => r.key === row.key)) continue;
      try {
        const linked = sessions.find((s) => s.key === row.key);
        const identity = linked != null && linked.clientId != null ? linked.clientId : (row.clientId == null ? null : row.clientId);
        const multi = isMultiTenant(row);
        // Cheap single-workspace gate first: an unsealed account starts as soon as it seals, without re-planning every pass.
        if (!multi && !backfillSealed(row, identity, null)) continue;
        const historyPlan = planHistoryRuns(row, { onlySessionIds: ids });
        if (multi && !backfillSealed(row, identity, historyPlan)) {
          record.historyAt[row.key] = Date.now();
          dirty = true;
          continue;
        }
        const results = [];
        for (const run of historyPlan.runs) {
          if (!alive()) break;
          results.push(await runAudit(
            { onProgress: () => { renew(); } },
            { account: row.key, tenantId: run.tenantId, sessionRoutes: run.sessionRoutes, excludedSessionIds: run.excludedSessionIds, mode: SYNC_MODE, onlySessionIds: ids },
          ));
        }
        // A session leaves the quiet set only when every run that takes it settled it: one workspace deferring keeps it due.
        const settledBy = new Map();
        for (const result of results) {
          for (const id of result.settledIds) settledBy.set(id, (settledBy.get(id) || 0) + 1);
        }
        const needed = (id) => historyPlan.runs.filter((run) => {
          if (run.sessionRoutes == null) return true;
          const route = run.sessionRoutes.get(id);
          return route != null && route.tenantIds.indexOf(run.tenantId) !== -1;
        }).length;
        let settled = 0;
        for (const [id, count] of settledBy) {
          const wanted = needed(id);
          const stat = byId.get(id);
          if (wanted === 0 || count < wanted || stat == null) continue;
          const stored = record.sessions[id];
          record.sessions[id] = {
            mtimeMs: stat.mtimeMs, size: stat.size, at: Date.now(), cursorAfter: null, hookSeenAt: keptField(stored, 'hookSeenAt'), oversizeAt: keptField(stored, 'oversizeAt'),
          };
          settled += 1;
        }
        // A busy history lease is fine: the user's own run covers it.
        record.historyAt[row.key] = Date.now();
        dirty = true;
        const imported = results.reduce((total, result) => total + result.sessionsImported, 0);
        const deferred = results.reduce((total, result) => total + result.deferred, 0);
        const reason = results.map((result) => result.reason).find((r) => r != null);
        say(`watcher history ${row.key}: imported=${imported} settled=${settled} deferred=${deferred} reason=${reason == null ? 'none' : reason}`);
      } catch (error) {
        fail('history', error);
      }
      if (!renew()) return finish('lost');
    }
  }

  if (trimWatermark(record, new Set(entries.map((entry) => entry.sessionId)))) dirty = true;
  return finish(null);
}

// ── The loop ───────────────────────────────────────────────────────────────────────────────────

// → stop(): idempotent and synchronous; a disabled watcher touches no file, lock or timer.
export function startWatcher({ log } = {}) {
  if (!isWatcherEnabled(process.env)) return function stop() {};
  const say = (line) => {
    try { if (typeof log === 'function') log(String(line)); } catch { /* the log is best-effort */ }
  };
  let stopped = false;
  let running = false;
  let timer = null;
  let lease = null;
  const ctx = { say, reasons: new Map(), savedAt: 0, alive: () => !stopped && lease != null, renew: () => renewElection() };

  // Renewed at the top of each tick and between phases of a long pass. A lost lease drops the handle so the rest of the pass stops.
  function renewElection() {
    if (stopped || lease == null) return false;
    const renewed = lease.renew();
    if (renewed.ok) return true;
    if (renewed.reason === 'lost') lease = null;
    return renewed.reason !== 'lost';
  }

  // Two windows elect one watcher; a transient double holder is safe because the engine serializes per session.
  function takeElection() {
    if (lease == null) {
      lease = acquireLease(ELECTION_NAME, { leaseMs: ELECTION_LEASE_MS });
      return lease != null;
    }
    return renewElection();
  }

  function schedule() {
    if (stopped) return;
    // Cleared by stop() and never unref'd, so the caller must stop() on stdin close or the timer keeps an orphaned MCP process alive.
    timer = setTimeout(() => {
      timer = null;
      tick().catch(() => {});
    }, TICK_MS);
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      // Another elected MCP process owns the work; skip quietly.
      if (!takeElection()) return;
      await runWatchPass(ctx);
    } catch (error) {
      say(`watcher pass failed: ${messageOf(error)}`);
      try {
        recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.WATCHER, error });
      } catch { /* consent-gated and best-effort */ }
    } finally {
      running = false;
      schedule();
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // An in-flight pass is not awaited: every await point re-checks alive().
    const held = lease;
    lease = null;
    if (held != null) held.release();
  }

  schedule();
  return stop;
}
