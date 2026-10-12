// One history run (backfill or sync) for one account and workspace, under the history lease: the stages in order.
import {
  getAuthentication as _getAuthentication,
  getAccessToken as _getAccessToken,
} from '../auth/token.mjs';
import { sessionFor as _sessionFor } from '../auth/recipients.mjs';
import { runCheckpoint as _runCheckpoint } from '../pipeline/cli-checkpoint.mjs';
import { flushQueue as _flushQueue } from '../delivery/queue-flush.mjs';
import { runVscodeCheckpoint } from '../pipeline/vscode-checkpoint.mjs';
import { listSessionFiles as _listSessionFiles } from '../sources/cli/session-files.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { buildTimeline } from '../capture/timeline.mjs';
import { readTimelineMarkers } from '../state/timeline-markers.mjs';
import { acquireLease } from '../platform/lease.mjs';
import { yieldToLoop } from '../core/async.mjs';
import {
  loadLedger as _loadLedger,
  saveLedger as _saveLedger,
  markUnreadable,
  wasUnreadable,
} from '../state/ledger.mjs';
import { flushBackfillChunks as _flushBackfillChunks, completeBackfill as _completeBackfill } from './backfill-transport.mjs';
import { fetchCoverage as _fetchCoverage } from '../delivery/coverage.mjs';
import { loadCoverageCheckpoints as _loadCoverageCheckpoints, saveCoverageCheckpoints as _saveCoverageCheckpoints } from '../state/coverage-record.mjs';
import { currentBinding, checkpointUsageSourceFor } from '../state/coverage-record.mjs';
import { postJson as _postJson } from '../platform/http.mjs';
import { postSessionError as _postSessionError } from '../delivery/session-errors.mjs';
import { isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { planSessionRoutes, waitingRoutes } from './history-routing.mjs';
import { usesRules } from '../workspace/rule-model.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { whoami as _whoami } from '../auth/whoami.mjs';
import { readTrackingState, isLiveTrackingAllowed, isTenantDark, markBackfillCompleted, recordWhoami } from '../state/tracking.mjs';
import { AUDIT_TIMEOUT_MS, BackfillHalt, SYNC_MODE } from '../contract/history.mjs';
import { newResult, countOf, addCounters, classifyReplay } from './run-result.mjs';
import { shouldFinalize } from './seal-policy.mjs';
import { runPreamble } from './preamble.mjs';
import { attemptHead, cwdReader, proveStartLines, selectCandidates, usableEntries, withVscodeEntries } from './candidates.mjs';
import { registerAccount } from './registration.mjs';
import { stampHistoryReports } from './identity-apply.mjs';
import { readSessionFacts } from './session-facts.mjs';
import { createBatchQueue, loseLease, progress, renewLease, sealLocally } from './batch-dispatch.mjs';

export const HISTORY_LEASE_MS = 10 * 60 * 1000;

const LEASE_RENEW_EVERY_MS = 60000;

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

// Backfill uploads every past session then seals the one-time pull; sync replays only what coverage says is missing and never seals.
export async function runAudit(deps = {}, options = {}) {
  // One leased lock for backfill, sync and the watcher's history pass, renewed as the run proceeds.
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

const pick = (value, fallback) => (value == null ? fallback : value);

// The real timeline reads its session's hook markers; an injected one gets only the id and events.
const _buildTimeline = (sessionId, events) => buildTimeline(sessionId, events, readTimelineMarkers(sessionId));

// Every seam runAudit accepts, defaulted to the real module.
function resolveIo(deps) {
  return {
    getAuthentication: pick(deps.getAuthentication, _getAuthentication),
    getAccessToken: pick(deps.getAccessToken, _getAccessToken),
    sessionFor: pick(deps.sessionFor, _sessionFor),
    listSessionFiles: pick(deps.listSessionFiles, _listSessionFiles),
    runCheckpoint: pick(deps.runCheckpointImpl, _runCheckpoint),
    flushBackfillChunks: pick(deps.flushBackfillChunksImpl, _flushBackfillChunks),
    completeBackfill: pick(deps.completeBackfillImpl, _completeBackfill),
    loadLedger: pick(deps.loadLedgerImpl, _loadLedger),
    saveLedger: pick(deps.saveLedgerImpl, _saveLedger),
    fetchCoverage: pick(deps.fetchCoverageImpl, _fetchCoverage),
    loadCoverage: pick(deps.loadCoverageCheckpointsImpl, _loadCoverageCheckpoints),
    saveCoverage: pick(deps.saveCoverageCheckpointsImpl, _saveCoverageCheckpoints),
    flushQueue: pick(deps.flushQueueImpl, _flushQueue),
    buildTimeline: pick(deps.buildTimelineImpl, _buildTimeline),
    postSessionError: pick(deps.postSessionErrorImpl, _postSessionError),
    postJson: pick(deps.postJsonImpl, _postJson),
    readTracking: pick(deps.readTrackingStateImpl, readTrackingState),
    markCompleted: pick(deps.markBackfillCompletedImpl, markBackfillCompleted),
    whoami: pick(deps.whoamiImpl, _whoami),
    recordWhoami: pick(deps.recordWhoamiImpl, recordWhoami),
    fetchImpl: deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl,
    onProgress: pick(deps.onProgress, () => {}),
    env: pick(deps.env, process.env),
    now: pick(deps.now, () => Date.now()),
  };
}

// preamble → candidates → coverage → registration → replay loop → finalize.
async function runAuditLeased(lease, deps, options) {
  const run = { lease, deps, options, io: resolveIo(deps), result: newResult(), syncMode: options.mode === SYNC_MODE, dryRun: options.dryRun === true };
  const { result } = run;
  if (!(await runPreamble(run))) return result;

  let candidates = await selectCandidates(run);
  // The coverage record is kept in BOTH modes: an accepted backfill writes its checkpoint too, which later saves a sync from the usage-mode deferral.
  run.coverageRecord = run.io.loadCoverage(run.key, currentBinding(run.identity, run.ledgerTenant));
  run.coverageDirty = false;
  const proven = await proveStartLines(run, candidates);
  candidates = proven.candidates;
  result.candidates = candidates.length;

  if (candidates.length === 0) {
    result.ok = true;
    // A previous run delivered everything but its finalize POST was lost: retry the seal here, or the pull stays open forever.
    await finalize(run);
    return result;
  }
  if (!(await registerAccount(run))) return result;

  // Error follow-ups hit a tracking-gated route: a dark workspace would take one 403 per session. Timelines are exempt (they ride in the chunks).
  run.followupsAllowed = run.multi ? !isTenantDark(run.tracking, run.tenantId) : (!run.trackingValid || isLiveTrackingAllowed(run.tracking));
  result.followupsAllowed = run.followupsAllowed;
  await replayCandidates(run, candidates, proven.startCursors);

  result.ok = true;
  // A run whose lease was taken away reports what it delivered and stops; it must not seal.
  if (result.halt === BackfillHalt.LOCK_LOST) return result;
  await finalize(run);
  return result;
}

async function finalize(run) {
  const { result } = run;
  if (!shouldFinalize(result, run.options)) return;
  // Ownership is re-checked immediately before the one irreversible act in this file.
  if (!run.lease.verify().ok) {
    result.lastError = 'the history lease was taken over — the pull was not sealed';
    return;
  }
  const sealed = await run.io.completeBackfill(run.session, { fetchImpl: run.io.fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
  if (sealed.completed || sealed.code === 'BACKFILL_ALREADY_COMPLETED') {
    result.finalized = true;
    sealLocally(run);
  } else {
    result.lastError = sealed.reason == null ? result.lastError : sealed.reason;
  }
}

// Parsing stays strictly sequential: one transcript in memory at a time.
async function replayCandidates(run, candidates, startCursors) {
  run.total = candidates.length;
  run.processed = 0;
  run.halted = false;
  run.lastRenewAt = run.io.now();
  // sessionId → what the follow-up phase needs once the server confirms the session landed.
  run.followups = new Map();
  run.unreadableDirty = false;
  const queue = createBatchQueue(run);
  for (const entry of candidates) {
    if (run.halted) break;
    await yieldToLoop();
    // A long run of already-current sessions can go a while without a dispatch; renew so the lease never expires while alive.
    if (run.io.now() - run.lastRenewAt >= LEASE_RENEW_EVERY_MS) {
      if (!renewLease(run)) { loseLease(run); break; }
      progress(run);
    }
    // Pass startCursor every time: history must never depend on a hook's local cursor. Backfill always starts at line 0.
    const group = await replayOne(run, entry, run.syncMode ? startCursors.get(entry.sessionId) : 0);
    if (group != null) await queue.add(group);
  }
  await queue.drain();

  // A run can hit unreadable sessions and dispatch nothing at all, so these cannot ride on the per-dispatch save; a dry run writes nothing.
  if (run.unreadableDirty && !run.dryRun) {
    try { run.io.saveLedger(run.key, run.ledger, run.ledgerTenant); } catch { /* best-effort */ }
  }
  if (run.coverageDirty) run.io.saveCoverage(run.key, run.coverageRecord);
}

// The first failure earns a retry and holds the pull open; a second one does not, so a permanently unreadable file cannot block the seal forever.
function noteUnreadable(run, sessionId) {
  if (!wasUnreadable(run.ledger, sessionId)) run.result.retriableUnreadable += 1;
  markUnreadable(run.ledger, sessionId);
  run.unreadableDirty = true;
}

// One candidate through its engine → the group to upload, or null when it settled, deferred or failed.
async function replayOne(run, entry, startCursor) {
  const { result } = run;
  const id = entry.sessionId;
  const reports = [];
  let checkpoint = null;
  try {
    checkpoint = await runEngine(run, entry, startCursor, reports);
  } catch {
    // One unreadable session must not end the run, but it is not silent either.
    result.unreadable += 1;
    noteUnreadable(run, id);
    run.processed += 1;
    return null;
  }
  run.processed += 1;
  const sessionErrors = checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors;
  const readPriorMode = () => {
    const state = loadSessionState(id);
    return state.usageMode != null ? state.usageMode : checkpointUsageSourceFor(run.coverageRecord, id);
  };
  const verdict = classifyReplay(checkpoint, reports, startCursor, readPriorMode);
  addCounters(result, verdict.counters);
  if (verdict.unreadable) noteUnreadable(run, id);
  if (verdict.settled) result.settledIds.push(id);
  if (verdict.upload == null) return null;

  // A VS Code chat file has no CLI event stream: its checkpoint stamped the reports and it has no timeline.
  const facts = entry.kind === 'vscode' ? null : await readSessionFacts(entry);
  await stampHistoryReports(reports, entry, run.billingSnapshot, facts);
  const timeline = buildSessionTimeline(run, entry, facts);
  const usageSource = reports.map((r) => r.usage_source).find((s) => s === 'per_call' || s === 'session_totals');
  run.followups.set(id, { sessionErrors });
  return { sessionId: id, reports, timeline, parentMaxLine: verdict.upload.parentMaxLine, usageSource: usageSource == null ? null : usageSource };
}

// A VS Code chat file has no CLI head: its folder is the cwd, and the VS Code checkpoint stamps its own account.
function runEngine(run, entry, startCursor, reports) {
  const isVscode = entry.kind === 'vscode';
  const head = isVscode ? { cwd: entry.folder } : attemptHead(entry.transcriptPath);
  return (isVscode ? runVscodeCheckpoint : run.io.runCheckpoint)(
    {
      sessionId: entry.sessionId,
      transcriptPath: entry.transcriptPath,
      ...(isVscode ? { file: entry.transcriptPath } : {}),
      cwd: head.cwd == null ? null : head.cwd,
      trigger: 'audit',
      withTimeline: false,
      withQuota: false,
    },
    { fetchImpl: run.io.fetchImpl },
    {
      sessions: [run.session],
      sink: (payload) => reports.push(payload),
      skipFlush: true,
      collectSessionErrors: true,
      persistState: false,
      skipLiveTrackingGate: true,
      startCursor,
    },
  );
}

// Timeline travels with the session's own chunk, from its own lines only. Best-effort: a failure never blocks the upload.
function buildSessionTimeline(run, entry, facts) {
  try {
    const built = facts == null ? null : run.io.buildTimeline(entry.sessionId, facts.events);
    if (built != null && (countOf(built.periods) > 0 || countOf(built.subagents) > 0 || countOf(built.plan_events) > 0)) {
      run.result.timelinesOffered += 1;
      return built;
    }
  } catch { /* best-effort */ }
  return null;
}
