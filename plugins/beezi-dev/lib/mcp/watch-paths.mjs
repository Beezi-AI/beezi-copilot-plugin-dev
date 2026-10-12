// The three capture paths of one watcher pass (due, fresh, history) and the per-pass bookkeeping they share.
// pass: { ctx, nowMs, summary, record, dirty, sessions, entries, recipients, routeCtx }; a path returns 'stopped' | 'lost' | null.
import { loadSessionState, vscodeCursorOf } from '../state/session-state.mjs';
import { storeObservation, settlementKey, isSettled, markSettled } from '../state/watcher-record.mjs';
import { loadLedger, isComplete } from '../state/ledger.mjs';
import { readTrackingState } from '../state/tracking.mjs';
import { listAccounts, AccountStatus } from '../accounts/index-store.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { establishStart } from '../delivery/coverage.mjs';
import { runAnyCheckpoint } from '../pipeline/run-any-checkpoint.mjs';
import { runAudit, planHistoryRuns } from '../history/history-run.mjs';
import { SYNC_MODE } from '../contract/history.mjs';
import { noHook, historySettlements, laggingReplays, settledByAll } from './watch-planner.mjs';
import { recipientsFor, sessionCwd } from './watch-recipients.mjs';
import { finiteNumber } from '../core/guards.mjs';
import { yieldToLoop } from '../core/async.mjs';

const MAX_ESTABLISH_PER_PASS = 2;
const CHECKPOINT_BUDGET_MS = 8000;
const HISTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_PER_PASS = 50;
const MAX_LOGGED_REASONS = 500;
const MAX_ATTEMPTS = 500;

export function messageOf(error) {
  return error != null && typeof error.message === 'string' && error.message !== '' ? error.message : 'unknown error';
}

export function failStep(pass, step, error) {
  pass.summary.errors += 1;
  pass.ctx.say(`watcher ${step} failed: ${messageOf(error)}`);
}

// Logs a session's reason once per change; the memory of logged reasons is bounded.
function noteReason(pass, id, reason) {
  const { reasons, say } = pass.ctx;
  if (reasons.get(id) === reason) return;
  if (reasons.size >= MAX_LOGGED_REASONS) reasons.clear();
  reasons.set(id, reason);
  say(`watcher: ${id} ${reason}`);
}

// A run that settled nothing; the planner cools the session down and queues it behind the rest. The memory is bounded.
function noteAttempt(pass, id) {
  const { attempts } = pass.ctx;
  if (attempts.size >= MAX_ATTEMPTS && !attempts.has(id)) attempts.clear();
  attempts.set(id, Date.now());
}

function cursorAfterRun(entry) {
  return entry.kind === 'vscode' ? vscodeCursorOf(entry.sessionId) : loadSessionState(entry.sessionId).cursorLine;
}

// Counts the engine's answer and records what it settled. → whether the run committed.
function recordOutcome(pass, entry, result) {
  const id = entry.sessionId;
  const { summary } = pass;
  if (result != null && result.outcome === 'committed') {
    pass.ctx.reasons.delete(id);
    pass.ctx.attempts.delete(id);
    summary.committed += 1;
    // The observation taken BEFORE the run (never a fresh stat), so a file that grew meanwhile stays due; zero segments still count.
    storeObservation(pass.record, entry, { at: Date.now(), cursorAfter: cursorAfterRun(entry) });
    pass.dirty = true;
    return true;
  }
  // No activity yet: the pre-run observation is recorded with no cursor, so the session is retried only once its file changes.
  if (result != null && result.reason === 'no-activity') {
    pass.ctx.attempts.delete(id);
    storeObservation(pass.record, entry, { at: Date.now(), cursorAfter: null });
    pass.dirty = true;
    summary.deferred += 1;
    noteReason(pass, id, result.reason);
    return false;
  }
  // Deferred or failed: nothing is recorded, so the session stays due (a deferred window with no reports is not consumed, not empty).
  noteAttempt(pass, id);
  if (result != null && result.outcome === 'failed') summary.errors += 1;
  else summary.deferred += 1;
  noteReason(pass, id, result == null ? 'no result' : (result.reason == null ? result.outcome : result.reason));
  return false;
}

async function checkpointOne(pass, item, inputExtra, options) {
  const { entry, state } = item;
  pass.summary.checkpointed += 1;
  let result = null;
  try {
    result = await runAnyCheckpoint(
      entry,
      { cwd: sessionCwd(state, entry.transcriptPath), trigger: 'watcher', budgetMs: CHECKPOINT_BUDGET_MS, ...inputExtra },
      options,
    );
  } catch (error) {
    pass.summary.errors += 1;
    noteAttempt(pass, entry.sessionId);
    noteReason(pass, entry.sessionId, `checkpoint threw: ${messageOf(error)}`);
    return false;
  }
  return recordOutcome(pass, entry, result);
}

// Path A: established sessions, an ordinary incremental checkpoint (routing and the live gate are the engine's).
export async function runDuePath(pass, due) {
  for (const item of due) {
    if (!pass.ctx.alive()) return 'stopped';
    const noHookYet = noHook(item.prior);
    await checkpointOne(pass, item, { withTimeline: noHookYet, withQuota: noHookYet }, {});
    await yieldToLoop();
  }
  return pass.ctx.renew() ? null : 'lost';
}

// The hook-less path's lagging recipients: their audit runs, after the established run committed.
async function replayLagging(pass, item, start, recipients) {
  for (const { options } of laggingReplays(start, recipients)) {
    if (!pass.ctx.alive()) return;
    let result = null;
    try {
      result = await runAnyCheckpoint(item.entry, { cwd: sessionCwd(item.state, item.entry.transcriptPath), trigger: 'watcher', budgetMs: CHECKPOINT_BUDGET_MS }, options);
    } catch (error) {
      failStep(pass, 'lagging replay', error);
      continue;
    }
    if (result == null || result.outcome !== 'committed') noteReason(pass, item.entry.sessionId, `lagging replay: ${result == null ? 'no result' : result.reason}`);
  }
}

// Path B: unestablished and active (history refuses these, so every hook-less Agent Host session lands here); the start line comes from the shared coverage rule.
export async function runFreshPath(pass, fresh) {
  for (const item of fresh.slice(0, MAX_ESTABLISH_PER_PASS)) {
    if (!pass.ctx.alive()) return 'stopped';
    const id = item.entry.sessionId;
    const recipients = recipientsFor(item, pass.recipients, pass.routeCtx);
    let start = null;
    try { start = await establishStart(id, recipients, { timeoutMs: 5000 }); } catch { start = null; }
    if (start == null || !Number.isInteger(start.startLine)) {
      pass.summary.deferred += 1;
      noteAttempt(pass, id);
      noteReason(pass, id, `establish deferred: ${start != null && start.reason != null ? start.reason : 'no answer'}`);
      continue;
    }
    // In live mode the engine starts at max(startCursor, state.cursorLine ?? 0), so a cursor a hook wrote meanwhile is never walked back.
    const ok = await checkpointOne(pass, item, { withTimeline: true, withQuota: noHook(item.prior) }, { startCursor: start.startLine });
    if (ok) {
      pass.summary.established += 1;
      await replayLagging(pass, item, start, recipients);
    }
    await yieldToLoop();
  }
  return pass.ctx.renew() ? null : 'lost';
}

// The account's one-time backfill is sealed: the local flag for a single-workspace account, every reached workspace's ledger otherwise.
function backfillSealed(row, identity, plan) {
  if (!isMultiTenant(row)) {
    const tracking = readTrackingState(row.key);
    return tracking != null && tracking.backfillCompleted === true;
  }
  return plan.runs.length > 0 && plan.runs.every((run) => isComplete(loadLedger(row.key, identity, run.tenantId)));
}

// The account's history pass is due and some live recipient belongs to it.
function historyDue(pass, row) {
  const last = finiteNumber(pass.record.historyAt[row.key]);
  if (last !== null && Date.now() - last < HISTORY_INTERVAL_MS) return false;
  return pass.recipients.some((r) => r.key === row.key);
}

// The account's live workspaces (null for a one-workspace account): each settles history on its own key.
function liveTenantIds(pass, row) {
  return pass.recipients.filter((r) => r.key === row.key).map((r) => r.tenantId);
}

// Each run takes only the batch sessions its workspace has not settled yet. → [{ run, result }] for the runs executed.
async function runHistoryRuns(pass, row, historyPlan, batch) {
  const executed = [];
  for (const run of historyPlan.runs) {
    if (!pass.ctx.alive()) break;
    const key = settlementKey(row.key, run.tenantId);
    const ids = batch.filter((entry) => !isSettled(pass.record, key, entry)).map((entry) => entry.sessionId);
    if (ids.length === 0) continue;
    const result = await runAudit(
      { onProgress: () => { pass.ctx.renew(); } },
      { account: row.key, tenantId: run.tenantId, sessionRoutes: run.sessionRoutes, excludedSessionIds: run.excludedSessionIds, mode: SYNC_MODE, onlySessionIds: ids },
    );
    executed.push({ run, result });
  }
  return executed;
}

// Records what the account's runs settled, per workspace. → how many settlements are new.
function recordSettlements(pass, row, historyPlan, executed, batch) {
  const byId = new Map(batch.map((entry) => [entry.sessionId, entry]));
  const ids = batch.map((entry) => entry.sessionId);
  let settled = 0;
  for (const [key, id] of historySettlements(row.key, liveTenantIds(pass, row), historyPlan.runs, executed, ids)) {
    const entry = byId.get(id);
    if (entry != null && markSettled(pass.record, key, entry)) settled += 1;
  }
  return settled;
}

// One account's sync of its quiet batch. → false when the account was skipped (not sealed yet), true once it ran.
async function syncAccountHistory(pass, row, batch) {
  const { record } = pass;
  const linked = pass.sessions.find((s) => s.key === row.key);
  const identity = linked != null && linked.clientId != null ? linked.clientId : (row.clientId == null ? null : row.clientId);
  const multi = isMultiTenant(row);
  // Cheap single-workspace gate first: an unsealed account starts as soon as it seals, without re-planning every pass.
  if (!multi && !backfillSealed(row, identity, null)) return false;
  const historyPlan = planHistoryRuns(row, { onlySessionIds: batch.map((entry) => entry.sessionId) });
  if (multi && !backfillSealed(row, identity, historyPlan)) {
    record.historyAt[row.key] = Date.now();
    pass.dirty = true;
    return false;
  }
  const executed = await runHistoryRuns(pass, row, historyPlan, batch);
  const settled = recordSettlements(pass, row, historyPlan, executed, batch);
  // A busy history lease is fine: the user's own run covers it.
  record.historyAt[row.key] = Date.now();
  pass.dirty = true;
  pass.summary.history += 1;
  const results = executed.map((run) => run.result);
  const imported = results.reduce((total, result) => total + result.sessionsImported, 0);
  const deferred = results.reduce((total, result) => total + result.deferred, 0);
  const reason = results.map((result) => result.reason).find((r) => r != null);
  pass.ctx.say(`watcher history ${row.key}: imported=${imported} settled=${settled} deferred=${deferred} reason=${reason == null ? 'none' : reason}`);
  return true;
}

// The quiet sessions this account still has to settle on some live workspace, newest first, at most MAX_HISTORY_PER_PASS.
function accountBatch(pass, row, newestQuiet) {
  const keys = liveTenantIds(pass, row).map((tenantId) => settlementKey(row.key, tenantId));
  return newestQuiet.filter((entry) => keys.some((key) => !isSettled(pass.record, key, entry))).slice(0, MAX_HISTORY_PER_PASS);
}

// A quiet session leaves the history path only once every live recipient of a linked account settled it.
function observeFullySettled(pass, rows, newestQuiet) {
  const linkedKeys = new Set(rows.map((row) => row.key));
  const required = pass.recipients.filter((r) => linkedKeys.has(r.key)).map((r) => settlementKey(r.key, r.tenantId));
  for (const entry of settledByAll(newestQuiet, required, (key, e) => isSettled(pass.record, key, e))) {
    storeObservation(pass.record, entry, { at: Date.now(), cursorAfter: null });
    pass.dirty = true;
  }
}

// Path C: unestablished and idle is history, so it goes through sync, and only once the login import has sealed: the watcher never performs or front-runs it.
export async function runHistoryPath(pass, quiet) {
  let rows = [];
  try {
    rows = (await listAccounts()).filter((row) => row.status === AccountStatus.LINKED);
  } catch (error) {
    failStep(pass, 'history', error);
  }
  // Newest quiet sessions are the likeliest to need repair; the rest wait for the next history pass.
  const newestQuiet = quiet.map((item) => item.entry).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const row of rows) {
    if (!pass.ctx.alive()) break;
    if (!historyDue(pass, row)) continue;
    const batch = accountBatch(pass, row, newestQuiet);
    if (batch.length === 0) continue;
    try {
      if (!(await syncAccountHistory(pass, row, batch))) continue;
    } catch (error) {
      failStep(pass, 'history', error);
    }
    if (!pass.ctx.renew()) return 'lost';
  }
  observeFullySettled(pass, rows, newestQuiet);
  return null;
}
