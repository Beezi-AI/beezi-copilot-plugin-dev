import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
// A namespace import: resolveSessionId is Plan 06's, and a named import of a missing export would fail this module's link.
import * as sessionsModule from './sessions.mjs';
import {
  getAuthentication as _getAuthentication,
  getAccessToken as _getAccessToken,
  INTERACTIVE_REFRESH_WAIT_MS,
} from './token.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { runCheckpoint as _runCheckpoint, flushQueue as _flushQueue } from './checkpoint.mjs';
import { listSessionFiles as _listSessionFiles, readSessionHead } from './transcript-index-copilot.mjs';
import { listVscodeSessions } from './vscode-chat-session.mjs';
import { runVscodeCheckpoint, vscodeCursorOf } from './vscode-checkpoint.mjs';
import { readEvents } from './copilot-events.mjs';
import { isUsableSessionId, loadSessionState } from './session-state.mjs';
import { buildTimeline as _buildTimeline } from './session-timeline-copilot.mjs';
import { beeziHome } from './paths.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import {
  loadLedger as _loadLedger,
  saveLedger as _saveLedger,
  isImported,
  markImported,
  markUnreadable,
  wasUnreadable,
  markComplete,
  isComplete,
  ledgerDelivered,
} from './audit-ledger.mjs';
import {
  flushBackfillChunks as _flushBackfillChunks,
  completeBackfill as _completeBackfill,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from './audit-flush.mjs';
import {
  fetchCoverage as _fetchCoverage,
  loadCoverageCheckpoints as _loadCoverageCheckpoints,
  saveCoverageCheckpoints as _saveCoverageCheckpoints,
  recordCoverageCheckpoint,
  checkpointLineFor,
  checkpointUsageSourceFor,
  currentBinding,
  decideReplay,
  ReplayDecision,
  DeferReason,
} from './session-coverage.mjs';
import { ENDPOINTS, apiBase } from './config.mjs';
import { postJson as _postJson } from './http.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { isMultiTenant, tenantsOf } from './workspace.mjs';
import { createRouteContext, planSessionRoutes, waitingRoutes, usesRules } from './workspace-rules.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { whoami as _whoami } from './whoami.mjs';
import {
  readTrackingState,
  matchesIdentity,
  isLiveTrackingAllowed,
  isTenantDark,
  markBackfillCompleted,
  recordWhoami,
  linkedAtMs,
  TrackingMode,
} from './tracking.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { resolveBilling } from './billing.mjs';
import { accountStamp } from './identity-stamp.mjs';
import { resolveSessionAccount } from './session-account-copilot.mjs';
import { buildAccountSyncPayload } from './account-sync.mjs';
import { UserError } from './friendly-error.mjs';

// §11 R-17: Plan 04's validator is the only session-id check; scripts and the watcher import this alias.
export { isUsableSessionId as isSafeSessionId } from './session-state.mjs';

// Repeatable history sync (/beezi-staging-sync) rather than the one-time pull driven by /beezi-staging-login.
export const SYNC_MODE = 'sync';

// A session file touched this recently is probably open: replaying it would re-segment lines on different boundaries than the next live report.
export const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

// A file this big is read twice over (segments, timeline) and would put the process into the hundreds of MB.
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export const HISTORY_LEASE_MS = 10 * 60 * 1000;

const FOLLOWUP_CONCURRENCY = 4;
const AUDIT_TIMEOUT_MS = 60000;
const LEASE_RENEW_EVERY_MS = 60000;
const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// ── The leased lock (history run, watcher election) ────────────────────────────────────────────

const LEASE_CAP_MS = 30 * 60 * 1000;
const LEASE_TAKEOVER_GRACE_MS = 60 * 1000;
const LEASE_UNPARSEABLE_FREE_MS = 15 * 1000;

export function leaseFile(name) {
  return path.join(beeziHome(), 'locks', `${name}.lease`);
}

// Read state of a lease file: missing, unparseable (with its mtime), or a normalized lease.
function inspectLease(name) {
  const file = leaseFile(name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? { state: 'missing' } : { state: 'bad', mtimeMs: Date.now() };
  }
  try {
    const raw = JSON.parse(text);
    if (raw == null || typeof raw !== 'object' || typeof raw.token !== 'string' || raw.token === '') throw new Error('shape');
    return {
      state: 'ok',
      lease: {
        token: raw.token,
        pid: Number.isInteger(raw.pid) ? raw.pid : null,
        hostname: typeof raw.hostname === 'string' ? raw.hostname : null,
        renewedAt: typeof raw.renewedAt === 'number' && isFinite(raw.renewedAt) ? raw.renewedAt : 0,
        leaseMs: typeof raw.leaseMs === 'number' && raw.leaseMs > 0 ? Math.min(raw.leaseMs, LEASE_CAP_MS) : LEASE_CAP_MS,
      },
    };
  } catch {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* vanished */ }
    return { state: 'bad', mtimeMs };
  }
}

// { token, pid, hostname, renewedAt, leaseMs } or null when the file is missing or unreadable.
export function readLease(name) {
  const seen = inspectLease(name);
  return seen.state === 'ok' ? seen.lease : null;
}

// False only for a holder on this host whose pid is gone (ESRCH); EPERM means alive, another host cannot be told.
export function leaseHolderAlive(lease) {
  if (lease == null || lease.pid == null) return false;
  if (lease.hostname !== os.hostname()) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function leaseTakeable(seen, nowMs) {
  if (seen.state === 'missing') return true;
  if (seen.state === 'bad') return nowMs - seen.mtimeMs > LEASE_UNPARSEABLE_FREE_MS;
  // A holder that is gone from this host (a Ctrl-C or a killed shell) frees the lease before it expires.
  if (seen.lease.pid != null && !leaseHolderAlive(seen.lease)) return true;
  const age = nowMs - seen.lease.renewedAt;
  const expired = age > seen.lease.leaseMs || age < -seen.lease.leaseMs;
  if (!expired) return false;
  return !leaseHolderAlive(seen.lease) || age > seen.lease.leaseMs + LEASE_TAKEOVER_GRACE_MS || age < -seen.lease.leaseMs - LEASE_TAKEOVER_GRACE_MS;
}

// Never throws; two takers can interleave unlink and create, and the loser learns on its next renew/verify and stops (I-4, I-8).
export function acquireLease(name, { leaseMs = HISTORY_LEASE_MS } = {}) {
  try {
    const file = leaseFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const token = crypto.randomBytes(16).toString('hex');
    const record = () => ({ token, pid: process.pid, hostname: os.hostname(), renewedAt: Date.now(), leaseMs });
    const create = () => {
      try {
        fs.writeFileSync(file, JSON.stringify(record()), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (!create()) {
      if (!leaseTakeable(inspectLease(name), Date.now())) return null;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') return null;
      }
      if (!create()) return null;
    }
    const owned = () => {
      const held = readLease(name);
      return held != null && held.token === token;
    };
    return {
      token,
      renew() {
        if (!owned()) return { ok: false, reason: 'lost' };
        try {
          writeJsonSecure(file, record());
          return { ok: true };
        } catch {
          return { ok: false, reason: 'write-failed' };
        }
      },
      verify() {
        return owned() ? { ok: true } : { ok: false, reason: 'lost' };
      },
      release() {
        try {
          if (owned()) fs.unlinkSync(file);
        } catch { /* best-effort */ }
      },
    };
  } catch {
    return null;
  }
}

// ── Arguments, small helpers, the seal gate ────────────────────────────────────────────────────

// A plain loop with valued flags; a malformed --since is a UserError the script prints verbatim.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--force') out.force = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--since') out.since = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
  }
  if (out.since != null) {
    const since = String(out.since);
    if (!SINCE_FORMAT.test(since) || Number.isNaN(Date.parse(since))) {
      throw new UserError('Beezi: --since expects a date like 2026-01-31.');
    }
    out.sinceMs = Date.parse(since);
  }
  return out;
}

// Run `worker` over `items` with at most `limit` in flight.
async function mapLimited(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// One macrotask, so the watcher's JSON-RPC channel keeps answering between sessions.
function yieldToLoop() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// The session this command runs inside; a null answer is fine because the active-window skip covers it.
async function currentSessionId(env, deps) {
  try {
    const resolve = deps.resolveSessionIdImpl == null ? sessionsModule.resolveSessionId : deps.resolveSessionIdImpl;
    if (typeof resolve !== 'function') return null;
    const found = await resolve({ env, cwd: process.cwd() });
    const id = found == null ? null : found.sessionId;
    return isUsableSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

// Entries with an unusable session id never reach a path (Plan 02 A6), and are dropped without counting.
function usableEntries(list, only) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry == null || !isUsableSessionId(entry.sessionId)) continue;
    if (only != null && !only.has(entry.sessionId)) continue;
    out.push(entry);
  }
  return out;
}

function readCwdOf(transcriptPath) {
  try {
    const head = readSessionHead(transcriptPath);
    return head == null || head.cwd == null ? null : head.cwd;
  } catch {
    return null;
  }
}

// Copilot CLI session files plus VS Code Local-agent chat sessions (kind 'vscode', transcriptPath = the chat file, folder = its cwd).
function withVscodeEntries(cliEntries) {
  const list = Array.isArray(cliEntries) ? cliEntries : [];
  const ids = new Set(list.map((entry) => (entry == null ? null : entry.sessionId)));
  const out = list.slice();
  for (const s of listVscodeSessions()) {
    if (ids.has(s.sessionId)) continue;
    out.push({ sessionId: s.sessionId, transcriptPath: s.file, mtimeMs: s.mtimeMs, size: s.size, kind: 'vscode', folder: s.folder });
  }
  return out;
}

// readCwd(transcriptPath) for route planning: a VS Code chat file answers with its folder, never through the CLI head reader.
function cwdReader(entries) {
  const folders = new Map();
  for (const entry of entries) if (entry.kind === 'vscode') folders.set(entry.transcriptPath, entry.folder == null ? null : entry.folder);
  return (transcriptPath) => (folders.has(transcriptPath) ? folders.get(transcriptPath) : readCwdOf(transcriptPath));
}

function localCursorOf(entry) {
  if (entry.kind === 'vscode') {
    const cursor = vscodeCursorOf(entry.sessionId);
    return cursor == null ? 0 : cursor;
  }
  const state = loadSessionState(entry.sessionId);
  return Number.isInteger(state.cursorLine) ? state.cursorLine : 0;
}

// A VS Code session is live-covered only when a hook or watcher saved its cursor after the cutoff: audits never persist state, so updatedAt with a vscode block is live evidence.
function vscodeLiveSince(sessionId, cutoffMs) {
  const state = loadSessionState(sessionId);
  if (state.vscode == null || state.updatedAt == null) return false;
  const at = Date.parse(state.updatedAt);
  return isFinite(at) && at > cutoffMs;
}

// Seal only when a re-run could not improve the outcome; per-item errors and unreadable-twice or oversize files never block it, or the seal would deadlock.
export function shouldFinalize(result, options = {}) {
  if (!result.ok) return false;
  // /beezi-staging-sync is repeatable by definition; sealing the one-time pull from it would lock the user out of the command they just ran.
  if (options.mode === SYNC_MODE) return false;
  if (options.dryRun === true) return false;
  if (options.sinceMs != null) return false;
  if (result.halt !== null) return false;
  if (result.reportsFailed > 0) return false;
  if (result.unattributed > 0) return false;
  if (result.permanentRejections > 0) return false;
  // Only the FIRST unreadable failure holds the seal: a permission error reads like transient I/O, so gating on every one would block it forever.
  if (result.retriableUnreadable > 0) return false;
  // Repos still waiting for a rule may yet be routed here, so the one-time pull stays open for them.
  if (result.routeDeferred > 0) return false;
  // A session left for a later run has not been uploaded, and the seal is one-time.
  if (result.deferred > 0) return false;
  return true;
}

// ── Which runs a history pass makes ────────────────────────────────────────────────────────────

// One headerless run for a single-workspace row, else one run per workspace a session route reaches; onlySessionIds narrows the sessions planned, markWaiting flags the Ask-me routes that hold the seal.
export function planHistoryRuns(row, { markWaiting = false, onlySessionIds = null } = {}) {
  const only = onlySessionIds == null ? null : new Set(onlySessionIds);
  const entries = usableEntries(withVscodeEntries(_listSessionFiles()), only);
  const readCwd = cwdReader(entries);
  const counts = { rule: 0, 'new-folders': 0, none: 0, pending: 0 };
  if (!isMultiTenant(row)) {
    const run = { tenantId: null, sessionRoutes: null };
    // One-workspace accounts with rules: sessions a matched rule excludes are skipped by the run, never uploaded.
    if (usesRules(row)) {
      const routes = planSessionRoutes(row, entries, createRouteContext(), { readCwd });
      run.excludedSessionIds = new Set(
        [...routes].filter(([, route]) => route.source === 'rule' && route.tenantIds.length === 0).map(([sessionId]) => sessionId),
      );
    }
    return { scanned: entries.length, counts, runs: [run] };
  }
  const ctx = createRouteContext();
  const routes = planSessionRoutes(row, entries, ctx, { readCwd });
  if (markWaiting) {
    for (const sessionId of waitingRoutes(row, entries, ctx, { routes, readCwd }).keys()) routes.get(sessionId).waiting = true;
  }
  const reached = new Set();
  for (const route of routes.values()) {
    if (counts[route.source] != null) counts[route.source] += 1;
    for (const id of route.tenantIds) reached.add(id);
  }
  const tenantIds = (tenantsOf(row) || []).map((t) => t.id).filter((id) => reached.has(id));
  return { scanned: entries.length, counts, runs: tenantIds.map((tenantId) => ({ tenantId, sessionRoutes: routes })) };
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────

function newResult() {
  return {
    ok: false,
    reason: null,
    halt: null,
    scanned: 0,
    live: 0,
    active: 0,
    liveTracked: 0,
    alreadyImported: 0,
    oversize: 0,
    routedElsewhere: 0,
    routeDeferred: 0,
    // One-workspace runs only: sessions a matched rule excludes from tracking (`excludedSessionIds`).
    excluded: 0,
    candidates: 0,
    plannedChunks: 0,
    plannedReports: 0,
    sessionsImported: 0,
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    reportsRejected: 0,
    reportsFailed: 0,
    itemErrors: 0,
    unattributed: 0,
    permanentRejections: 0,
    timelines: 0,
    timelinesOffered: 0,
    timelinesDropped: 0,
    sessionErrors: 0,
    // Candidates that produced no report, split by cause; `empty` is the benign one, the fallback only after every other cause is ruled out.
    empty: 0,
    // Sessions with no prompt, turn, tool call or usage anywhere in the file: settled like `empty`, never ledgered.
    noActivity: 0,
    noRemote: 0,
    emitFailed: 0,
    unreadable: 0,
    // Unreadable sessions this run holds the pull open for: the ones not already tried once.
    retriableUnreadable: 0,
    noUsageSummary: 0,
    // Sessions left for a later run; the four named causes are part of `deferred`, `deferredOther` is the rest (busy, budget).
    deferred: 0,
    deferredUnavailable: 0,
    deferredGap: 0,
    deferredOverlap: 0,
    deferredUsageMode: 0,
    deferredOther: 0,
    pendingDrained: 0,
    // Sync only: false means the server could not answer, so every candidate was deferred.
    coverageKnown: false,
    followupsAllowed: true,
    upgradeAdvised: false,
    finalized: false,
    lastError: null,
    // Ids with a final answer for now (accepted, partial, rejected, empty, noRemote, oversize); deferred, failed and unreadable are excluded.
    settledIds: [],
  };
}

const sum = (list, pick) => list.reduce((total, item) => total + (typeof pick(item) === 'number' ? pick(item) : 0), 0);
const countOf = (value) => (Array.isArray(value) ? value.length : 0);

// Backfill uploads every past session then seals the one-time pull; sync replays only what coverage says is missing and never seals.
export async function runAudit(deps = {}, options = {}) {
  // One leased lock for backfill, sync and the watcher's history pass (I-8), renewed as the run proceeds.
  const lease = acquireLease('history', { leaseMs: HISTORY_LEASE_MS });
  if (lease == null) {
    const busy = newResult();
    busy.reason = 'busy';
    return busy;
  }
  try {
    return await runAuditLeased(lease, deps, options);
  } finally {
    lease.release();
  }
}

async function runAuditLeased(lease, deps, options) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const sessionFor = deps.sessionFor == null ? sessionsModule.sessionFor : deps.sessionFor;
  const listSessionFiles = deps.listSessionFiles == null ? _listSessionFiles : deps.listSessionFiles;
  const runCheckpoint = deps.runCheckpointImpl == null ? _runCheckpoint : deps.runCheckpointImpl;
  const flushBackfillChunks = deps.flushBackfillChunksImpl == null ? _flushBackfillChunks : deps.flushBackfillChunksImpl;
  const completeBackfill = deps.completeBackfillImpl == null ? _completeBackfill : deps.completeBackfillImpl;
  const loadLedger = deps.loadLedgerImpl == null ? _loadLedger : deps.loadLedgerImpl;
  const saveLedger = deps.saveLedgerImpl == null ? _saveLedger : deps.saveLedgerImpl;
  const fetchCoverage = deps.fetchCoverageImpl == null ? _fetchCoverage : deps.fetchCoverageImpl;
  const loadCoverage = deps.loadCoverageCheckpointsImpl == null ? _loadCoverageCheckpoints : deps.loadCoverageCheckpointsImpl;
  const saveCoverage = deps.saveCoverageCheckpointsImpl == null ? _saveCoverageCheckpoints : deps.saveCoverageCheckpointsImpl;
  const flushQueue = deps.flushQueueImpl == null ? _flushQueue : deps.flushQueueImpl;
  const buildTimeline = deps.buildTimelineImpl == null ? _buildTimeline : deps.buildTimelineImpl;
  const postSessionError = deps.postSessionErrorImpl == null ? _postSessionError : deps.postSessionErrorImpl;
  const postJson = deps.postJsonImpl == null ? _postJson : deps.postJsonImpl;
  const readTracking = deps.readTrackingStateImpl == null ? readTrackingState : deps.readTrackingStateImpl;
  const markCompleted = deps.markBackfillCompletedImpl == null ? markBackfillCompleted : deps.markBackfillCompletedImpl;
  const whoamiImpl = deps.whoamiImpl == null ? _whoami : deps.whoamiImpl;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onProgress = deps.onProgress == null ? (() => {}) : deps.onProgress;
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? (() => Date.now()) : deps.now;

  const result = newResult();
  const syncMode = options.mode === SYNC_MODE;
  const dryRun = options.dryRun === true;

  // Preamble step 2: auth and the account's session. A multi-workspace account never runs headerless.
  if (options.account == null) { result.reason = 'no-account'; return result; }
  const key = options.account;
  const auth = await getAuthentication(deps, { account: key, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  if (auth == null || auth.authState !== AUTH_STATES.READY) {
    result.reason = auth != null && auth.authState === AUTH_STATES.UNLINKED ? 'no-account' : 'auth-unavailable';
    result.authState = auth == null ? null : auth.authState;
    result.authReason = auth == null ? null : auth.reason;
    return result;
  }
  const resolved = await sessionFor(key, { ...deps, getAccessToken: async () => auth.accessToken }).catch(() => null);
  if (resolved == null) { result.reason = 'no-account'; return result; }
  const tenantId = options.tenantId == null ? null : options.tenantId;
  const multi = isMultiTenant(resolved);
  if (multi && tenantId == null) { result.reason = 'workspace-required'; return result; }
  // Each workspace of a multi-workspace account keeps its own ledger and coverage record, so one import never blocks the rest.
  const ledgerTenant = multi ? tenantId : null;
  let session = { ...resolved, token: auth.accessToken, tenantId };
  const identity = session.clientId == null ? null : session.clientId;
  const tracking = readTracking(key);
  const trackingValid = matchesIdentity(tracking, identity);

  // Step 3: the repair pass must not become a way around an audit-only workspace.
  if (syncMode && trackingValid && (multi ? isTenantDark(tracking, tenantId) : !isLiveTrackingAllowed(tracking))) {
    result.ok = true;
    result.reason = 'audit-only';
    result.upgradeAdvised = true;
    return result;
  }

  // Step 4: drain the queue first, or coverage is stale by exactly those segments and a narrow live row lands beside a wide replay.
  if (syncMode) {
    let drained = null;
    try { drained = await flushQueue(session, { fetchImpl }); } catch { drained = null; }
    if (drained == null) {
      result.ok = true;
      result.reason = 'pending-not-drained';
      result.lastError = 'queued reports could not be delivered';
      return result;
    }
    result.pendingDrained = drained.flushed == null ? 0 : drained.flushed;
    if (drained.trackingDisabled === true) {
      result.ok = true;
      result.reason = 'audit-only';
      result.upgradeAdvised = true;
      return result;
    }
    // A quarantined file is set aside on disk and no longer sits in the queue, so it does not stale the coverage answer.
    if (drained.failed > 0 || drained.deferred > 0 || drained.unreadable > 0) {
      result.ok = true;
      result.reason = 'pending-not-drained';
      result.lastError = drained.lastError == null ? 'queued reports could not be delivered' : drained.lastError;
      return result;
    }
  }

  // Step 5: --force skips the local caches only, never the server verdict; the account-wide sealed flag cannot vouch for one of several workspaces.
  if (!syncMode && !options.force && !multi && trackingValid && tracking != null && tracking.backfillCompleted === true) {
    result.ok = true;
    result.reason = 'already-completed';
    result.upgradeAdvised = tracking.trackingMode != null && tracking.trackingMode !== TrackingMode.LIVE;
    return result;
  }
  const who = await whoamiImpl(session, { fetchImpl }).catch(() => null);
  if (who != null && who.valid) {
    // One workspace's answer must not overwrite a multi-workspace account's cache.
    if (!multi) {
      try { recordWhoamiImpl(key, who, identity); } catch { /* best-effort */ }
    }
    if (!syncMode && who.backfillCompleted === true) {
      try { markCompleted(key); } catch { /* best-effort */ }
      result.ok = true;
      result.reason = 'already-completed';
      result.upgradeAdvised = who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE;
      return result;
    }
    if (syncMode && who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE) {
      result.ok = true;
      result.reason = 'audit-only';
      result.upgradeAdvised = true;
      return result;
    }
  }
  const ledger = loadLedger(key, identity, ledgerTenant);
  if (!syncMode && !options.force && isComplete(ledger)) {
    result.ok = true;
    result.reason = 'already-completed';
    return result;
  }

  // Candidates.
  const only = options.onlySessionIds == null ? null : new Set(options.onlySessionIds);
  const all = usableEntries(withVscodeEntries(listSessionFiles()), only);
  result.scanned = all.length;
  const liveId = await currentSessionId(env, deps);

  // Live-tracking workspaces: everything since the machine link was tracked live, and re-sending it would double-count once its cursor was pruned.
  const liveMode = multi
    ? who != null && who.valid && who.trackingMode === TrackingMode.LIVE
    : trackingValid && tracking != null && tracking.trackingMode === TrackingMode.LIVE;
  // Sync keeps post-link sessions in scope on purpose: a session whose hooks died mid-file is what it repairs, and coverage stops it re-sending what landed.
  const linkCutoffMs = liveMode && !syncMode ? linkedAtMs(tracking) : null;
  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;
  const sessionRoutes = options.sessionRoutes == null ? null : options.sessionRoutes;
  const excludedSessionIds = options.excludedSessionIds == null ? null : options.excludedSessionIds;

  let candidates = [];
  for (const entry of all) {
    const id = entry.sessionId;
    if (liveId != null && id === liveId) { result.live += 1; continue; }
    // Filtered before the ledger, so a later rule can still send it here.
    if (sessionRoutes != null) {
      const route = sessionRoutes.get(id);
      if (route == null || route.tenantIds.indexOf(tenantId) === -1) {
        result.routedElsewhere += 1;
        // Holds the seal only for a waiting session this run would take if a rule sent it here (post-link ones are tracked live).
        if (route != null && route.waiting === true && !(linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs)) result.routeDeferred += 1;
        continue;
      }
    }
    // An open VS Code session with no recent live checkpoint is processed here: its settled requests upload, the running one waits.
    if (entry.mtimeMs > activeCutoffMs && (entry.kind !== 'vscode' || vscodeLiveSince(id, activeCutoffMs))) { result.active += 1; continue; }
    if (linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs) { result.liveTracked += 1; continue; }
    // Without a link stamp, a live cursor is the remaining evidence that live tracking already owns the session.
    if (!syncMode && liveMode && linkCutoffMs == null && localCursorOf(entry) > 0) { result.liveTracked += 1; continue; }
    // One-workspace accounts only: a matched Don't-track rule. Never reaches the ledger or the machine-wide watermark, so another account and a removed rule still see it.
    if (excludedSessionIds != null && excludedSessionIds.has(id)) { result.excluded += 1; continue; }
    if (!syncMode && !options.force && isImported(ledger, id)) { result.alreadyImported += 1; continue; }
    if (options.sinceMs != null && entry.mtimeMs < options.sinceMs) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) { result.oversize += 1; result.settledIds.push(id); continue; }
    candidates.push(entry);
  }

  // The coverage record is kept in BOTH modes: an accepted backfill writes its checkpoint too, which later saves a sync from the usage-mode deferral.
  const coverageRecord = loadCoverage(key, currentBinding(identity, ledgerTenant));
  let coverageDirty = false;

  // Sync: ask the server how far each candidate reaches, then keep only sessions whose start line can be proven.
  const startCursors = new Map();
  if (syncMode) {
    if (candidates.length === 0) {
      result.coverageKnown = true;
    } else {
      const coverage = await fetchCoverage(
        candidates.map((entry) => entry.sessionId),
        session,
        { fetchImpl },
        { timeoutMs: AUDIT_TIMEOUT_MS },
      ).catch(() => null);
      result.coverageKnown = coverage !== null;
      const eligible = [];
      for (const entry of candidates) {
        const verdict = decideReplay(entry.sessionId, {
          coverage,
          checkpointLine: checkpointLineFor(coverageRecord, entry.sessionId),
          localCursor: localCursorOf(entry),
          ledgerDelivered: ledgerDelivered(ledger, entry.sessionId),
        });
        if (verdict.decision === ReplayDecision.DEFER) {
          result.deferred += 1;
          if (verdict.reason === DeferReason.UNAVAILABLE) result.deferredUnavailable += 1;
          else result.deferredGap += 1;
          continue;
        }
        startCursors.set(entry.sessionId, verdict.startCursor);
        eligible.push(entry);
      }
      candidates = eligible;
    }
  }
  result.candidates = candidates.length;

  // One identity snapshot per run (R-20, I-2): the check-in and every history report name the same account.
  let stamp = {};
  let billing = {};
  let snapshot = null;
  const attempt = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  if (candidates.length > 0) {
    try { snapshot = readBillingConfig(); } catch { snapshot = null; }
    stamp = attempt(() => accountStamp({ config: snapshot }), {});
    billing = attempt(() => resolveBilling({ config: snapshot }), {});
    const registration = attempt(() => buildAccountSyncPayload({ config: snapshot }), {});

    // History reports can only resolve their account after it is registered for this workspace, and the reply is verified.
    if (!dryRun && (stamp.account_uuid != null || stamp.account_email != null)) {
      const register = (as) => postJson(`${apiBase()}${ENDPOINTS.accountSync}`, as, registration, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
      try {
        let res = await register(session);
        if (res.status === 401) {
          const renewed = await getAccessToken({}, { account: key, forceRefresh: true }).catch(() => null);
          if (renewed) {
            session = { ...session, token: renewed };
            res = await register(session);
          }
        }
        const accepted = res.status >= 200 && res.status < 300;
        const reply = accepted ? await res.json().catch(() => null) : null;
        if (!accepted || reply == null || reply.accountLinked !== true) {
          result.reason = 'account-registration-failed';
          result.lastError = accepted ? 'account was not linked' : `HTTP ${res.status}`;
          return result;
        }
      } catch {
        result.reason = 'account-registration-failed';
        result.lastError = 'network';
        return result;
      }
    }
  }

  const finalize = async () => {
    if (!shouldFinalize(result, options)) return;
    // Ownership is re-checked immediately before the one irreversible act in this file (I-4).
    if (!lease.verify().ok) {
      result.lastError = 'the history lease was taken over — the pull was not sealed';
      return;
    }
    const sealed = await completeBackfill(session, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    if (sealed.completed || sealed.code === 'BACKFILL_ALREADY_COMPLETED') {
      result.finalized = true;
      markComplete(ledger);
      try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
      try { markCompleted(key); } catch { /* best-effort */ }
    } else {
      result.lastError = sealed.reason == null ? result.lastError : sealed.reason;
    }
  };

  if (candidates.length === 0) {
    result.ok = true;
    // A previous run delivered everything but its finalize POST was lost: retry the seal here, or the pull stays open forever.
    await finalize();
    return result;
  }

  // Error follow-ups hit a tracking-gated route: a dark workspace would take one 403 per session. Timelines are exempt (they ride in the chunks).
  const followupsAllowed = multi ? !isTenantDark(tracking, tenantId) : (!trackingValid || isLiveTrackingAllowed(tracking));
  result.followupsAllowed = followupsAllowed;

  // Accumulated but not yet delivered, bounded by the request planner's caps.
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  // sessionId → what the follow-up phase needs once the server confirms the session landed.
  const followups = new Map();
  let processed = 0;
  let halted = false;
  let lastRenewAt = now();

  const renewLease = () => {
    const renewed = lease.renew();
    if (renewed.ok) lastRenewAt = now();
    return renewed.ok === true;
  };
  const loseLease = () => {
    result.halt = BackfillHalt.LOCK_LOST;
    result.lastError = 'the history lease was taken over';
    halted = true;
  };

  const dispatchBatch = async (batch) => {
    if (dryRun) {
      result.plannedReports += sum(batch, (g) => g.reports.length);
      result.plannedChunks += planChunks(batch).length;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }
    // Before any network work, and the batch is dropped unsent on a lost lease so its sessions stay eligible (I-8).
    if (!renewLease()) {
      loseLease();
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }
    result.plannedReports += sum(batch, (g) => g.reports.length);

    const flushed = await flushBackfillChunks(
      batch,
      session,
      { fetchImpl },
      { timeoutMs: AUDIT_TIMEOUT_MS, endpoint: syncMode ? ENDPOINTS.sessionsSync : ENDPOINTS.sessionsBackfill },
    );
    result.plannedChunks += flushed.chunks;
    result.timelinesDropped += flushed.timelinesDropped == null ? 0 : flushed.timelinesDropped;
    result.reportsStored += flushed.stored;
    result.reportsSkipped += flushed.skipped;
    result.timelines += flushed.timelines;
    result.itemErrors += flushed.itemErrors;
    result.unattributed += flushed.unattributed;
    result.permanentRejections += flushed.permanentRejections;
    if (flushed.lastError) result.lastError = flushed.lastError;

    // Follow-ups only for sessions the server accepted — a failed one must stay unledgered so a re-run retries it.
    const landed = [];
    for (const group of batch) {
      const verdict = flushed.bySession.get(group.sessionId);
      const status = verdict == null || verdict.status == null ? BackfillSessionStatus.FAILED : verdict.status;
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        result.sessionsImported += 1;
        landed.push(group.sessionId);
      }
      // ACCEPTED only: a PARTIAL upload would put the checkpoint ahead of the real prefix forever and defer the session for good.
      if (status === BackfillSessionStatus.ACCEPTED && Number.isInteger(group.parentMaxLine) && group.parentMaxLine > 0) {
        recordCoverageCheckpoint(coverageRecord, group.sessionId, group.parentMaxLine, now(), group.usageSource);
        coverageDirty = true;
      }
      if (status === BackfillSessionStatus.REJECTED) {
        result.reportsRejected += group.reports.length;
        result.sessionsRejected += 1;
      }
      if (status === BackfillSessionStatus.FAILED) result.reportsFailed += group.reports.length;
      // Anything the server judged is ledgered, including a rejection: an unconnected repository rejects on every future run too.
      if (
        status === BackfillSessionStatus.ACCEPTED ||
        status === BackfillSessionStatus.PARTIAL ||
        status === BackfillSessionStatus.REJECTED
      ) {
        markImported(ledger, group.sessionId, { outcome: status, reports: group.reports.length });
        result.settledIds.push(group.sessionId);
      } else {
        followups.delete(group.sessionId);
      }
    }
    // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
    try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
    if (coverageDirty) {
      saveCoverage(key, coverageRecord);
      coverageDirty = false;
    }

    if (flushed.halt) {
      result.halt = flushed.halt;
      halted = true;
      // The seal is the one-time import's, so a sync run leaves the local caches exactly as it found them.
      if (!syncMode && flushed.halt === BackfillHalt.ALREADY_COMPLETED) {
        markComplete(ledger);
        try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
        try { markCompleted(key); } catch { /* best-effort */ }
      }
      return;
    }

    if (followupsAllowed) {
      await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
        const followup = followups.get(sessionId);
        followups.delete(sessionId);
        if (!followup) return;
        for (const errorPayload of followup.sessionErrors) {
          const { reported } = await postSessionError(errorPayload, session, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
          if (reported) result.sessionErrors += 1;
        }
      });
    }

    onProgress({ processed, total: candidates.length, ...result });
  };

  // One-deep pipeline: one batch in flight while the next sessions parse; dispatches stay sequential so ledger writes are ordered.
  let inFlight = null;
  const dispatch = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    if (inFlight) await inFlight;
    // A halt discovered by the previous flight drops this batch; its sessions stay unledgered and eligible.
    if (halted) return;
    inFlight = dispatchBatch(batch);
  };

  // The first failure earns a retry and holds the pull open; a second one does not, so a permanently unreadable file cannot block the seal forever.
  let unreadableDirty = false;
  const noteUnreadable = (sessionId) => {
    if (!wasUnreadable(ledger, sessionId)) result.retriableUnreadable += 1;
    markUnreadable(ledger, sessionId);
    unreadableDirty = true;
  };

  // Parsing stays strictly sequential: one transcript in memory at a time.
  for (const entry of candidates) {
    if (halted) break;
    await yieldToLoop();
    // A long run of already-current sessions can go a while without a dispatch; renew so the lease never expires while alive.
    if (now() - lastRenewAt >= LEASE_RENEW_EVERY_MS) {
      if (!renewLease()) { loseLease(); break; }
      onProgress({ processed, total: candidates.length, ...result });
    }
    const id = entry.sessionId;
    // Pass startCursor every time: history must never depend on a hook's local cursor. Backfill always starts at line 0.
    const startCursor = syncMode ? startCursors.get(id) : 0;
    const isVscode = entry.kind === 'vscode';
    // A VS Code chat file has no CLI head: its folder is the cwd, and the VS Code checkpoint stamps its own account.
    const head = isVscode ? { cwd: entry.folder } : attemptHead(entry.transcriptPath);
    const reports = [];
    let checkpoint = null;
    try {
      checkpoint = await (isVscode ? runVscodeCheckpoint : runCheckpoint)(
        {
          sessionId: id,
          transcriptPath: entry.transcriptPath,
          ...(isVscode ? { file: entry.transcriptPath } : {}),
          cwd: head.cwd == null ? null : head.cwd,
          trigger: 'audit',
          withTimeline: false,
          withQuota: false,
        },
        { fetchImpl },
        {
          sessions: [session],
          sink: (payload) => reports.push(payload),
          skipFlush: true,
          collectSessionErrors: true,
          persistState: false,
          skipLiveTrackingGate: true,
          startCursor,
        },
      );
    } catch {
      // One unreadable session must not end the run, but it is not silent either.
      result.unreadable += 1;
      noteUnreadable(id);
      processed += 1;
      continue;
    }
    processed += 1;
    const skipped = checkpoint == null || checkpoint.skipped == null ? {} : checkpoint.skipped;
    const sessionErrors = checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors;

    // Anything that did not commit is not consumed, so it is never `empty` and never ledgered.
    if (checkpoint == null || checkpoint.outcome !== 'committed') {
      const reason = checkpoint == null ? null : checkpoint.reason;
      // runCheckpoint never throws, so an engine crash ('internal') or a file that vanished ('no-transcript') arrives as a failed outcome:
      // the first one holds the seal like any unreadable session, the second lets it through.
      if (checkpoint == null || skipped.deltaFailed || reason === 'internal' || reason === 'no-transcript') {
        result.unreadable += 1;
        noteUnreadable(id);
      } else if (reason === 'no-activity') {
        result.noActivity += 1;
        result.settledIds.push(id);
      } else if (reason === 'cursor-mismatch' || skipped.cursorMismatch) {
        // The file is shorter than the start line (V-43): its stored prefix cannot be trusted against this file.
        result.deferred += 1;
        result.deferredGap += 1;
      } else if (reason === 'usage-hold' || skipped.usageHeld) {
        result.deferred += 1;
        result.deferredUsageMode += 1;
      } else if (checkpoint.outcome === 'deferred') {
        // Busy session, spent budget, no recipients: retried by a later run and holds the seal meanwhile.
        result.deferred += 1;
        result.deferredOther += 1;
      } else {
        // A parent with no usable working directory is reported under the engine's fallback remote, so a failed emit is a real one.
        result.emitFailed += 1;
      }
      continue;
    }

    if (reports.length === 0) {
      // `empty` is the only benign outcome, so it is the fallback only once every reason worth reporting is ruled out.
      if (skipped.emitFailed != null && skipped.emitFailed > 0) result.emitFailed += 1;
      else if (skipped.noRemote != null && skipped.noRemote > 0) { result.noRemote += 1; result.settledIds.push(id); }
      else { result.empty += 1; result.settledIds.push(id); }
      continue;
    }

    // Overlap ban (I-5): parent and subagent reports alike must start after the proven prefix, since subagents share the parent's line space.
    if (startCursor > 0 && reports.some((r) => Number.isInteger(r.from_line) && r.from_line <= startCursor)) {
      result.deferred += 1;
      result.deferredOverlap += 1;
      continue;
    }
    let parentMaxLine = startCursor;
    for (const r of reports) {
      if (r.is_subagent !== true && Number.isInteger(r.to_line) && r.to_line > parentMaxLine) parentMaxLine = r.to_line;
    }

    // Usage-mode rule: lines below the start may hold per-call tokens, so the shutdown totals replay only when the prior mode
    // (local state, else the coverage checkpoint) is known to be session_totals; an unknown prior defers.
    const tokens = sum(reports, (r) => r.token_total);
    const credits = sum(reports, (r) => r.ai_credits_nano);
    const allTotals = reports.every((r) => r.usage_source === 'session_totals');
    if (startCursor > 0 && allTotals && tokens > 0) {
      const state = loadSessionState(id);
      const prior = state.usageMode != null ? state.usageMode : checkpointUsageSourceFor(coverageRecord, id);
      if (prior !== 'session_totals') {
        result.deferred += 1;
        result.deferredUsageMode += 1;
        continue;
      }
    }
    // No session.shutdown in the window: the activity, code changes and timeline are real, so it still uploads without tokens.
    if (allTotals && tokens === 0 && credits === 0) result.noUsageSummary += 1;

    // The session's own account (live binding, else its logs or transcript) wins over the run snapshot's.
    const boundKey = isVscode ? null : loadSessionState(id).accountKey;
    const found = isVscode || boundKey != null ? null : resolveSessionAccount(id, { transcriptPath: entry.transcriptPath });
    const account = boundKey != null ? boundKey : (found == null ? null : found.key);
    // A VS Code report keeps what its checkpoint stamped (its own account, else the current one).
    if (!isVscode && account != null) {
      applyIdentity(reports, {
        stamp: attempt(() => accountStamp({ config: snapshot, account }), {}),
        billing: attempt(() => resolveBilling({ config: snapshot, account }), {}),
      });
    } else if (!isVscode) {
      applyIdentity(reports, { stamp, billing });
    }

    // Timeline travels with the session's own chunk. Best-effort: a failure here never blocks the usage upload.
    let timeline = null;
    try {
      // A VS Code session has no Copilot CLI event stream to build one from.
      const built = isVscode ? null : buildTimeline(id, readEvents(entry.transcriptPath).events);
      if (built != null && (countOf(built.periods) > 0 || countOf(built.subagents) > 0 || countOf(built.plan_events) > 0)) {
        timeline = built;
        result.timelinesOffered += 1;
      }
    } catch { /* best-effort */ }

    const usageSource = reports.map((r) => r.usage_source).find((s) => s === 'per_call' || s === 'session_totals');
    followups.set(id, { sessionErrors });
    pending.push({ sessionId: id, reports, timeline, parentMaxLine, usageSource: usageSource == null ? null : usageSource });
    pendingBytes += Buffer.byteLength(JSON.stringify({ reports, timeline }), 'utf-8');
    pendingItems += reports.length;
    if (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS) await dispatch();
  }
  await dispatch();
  if (inFlight) await inFlight;

  // A run can hit unreadable sessions and dispatch nothing at all, so these cannot ride on the per-dispatch save.
  if (unreadableDirty) {
    try { saveLedger(key, ledger, ledgerTenant); } catch { /* best-effort */ }
  }
  if (coverageDirty) saveCoverage(key, coverageRecord);

  result.ok = true;
  // A run whose lease was taken away reports what it delivered and stops; it must not seal (I-4).
  if (result.halt === BackfillHalt.LOCK_LOST) return result;
  await finalize();
  return result;
}

function attemptHead(transcriptPath) {
  try {
    return readSessionHead(transcriptPath) || {};
  } catch {
    return {};
  }
}

// A bound session takes its own account's stamp and plan; an unbound one takes the run snapshot's (the current account).
function applyIdentity(reports, { stamp, billing }) {
  for (const report of reports) {
    for (const field of ['account_uuid', 'account_email']) {
      if (stamp[field] != null) report[field] = stamp[field];
      else delete report[field];
    }
    for (const field of ['billing_source', 'subscription_type', 'subscription_plan']) {
      if (billing[field] != null) report[field] = billing[field];
      else if (field !== 'billing_source') delete report[field];
    }
  }
}
