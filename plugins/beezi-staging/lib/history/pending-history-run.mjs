// The history worker's pass: one sync-mode run per workspace a rule change owes its past sessions, settled on the pending marker.
import fs from 'fs';
import { runAudit as _runAudit, planHistoryRuns as _planHistoryRuns } from './history-run.mjs';
import { createRunCache as _createRunCache } from './run-cache.mjs';
import { isCleanSync } from './run-result.mjs';
import { BackfillHalt, SYNC_MODE } from '../contract/history.mjs';
import { readSessionHead as _readSessionHead } from '../sources/cli/session-files.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { pendingHistoryOf, waitingOnRecent, RunOutcome } from '../workspace/pending-history.mjs';
import { notePendingAttempt, settlePendingHistory } from '../workspace/settings-store.mjs';
import { AccountStatus, listAccounts } from '../accounts/index-store.mjs';

const REAL_ACCOUNTS = Object.freeze({ AccountStatus, listAccounts, notePendingAttempt, settlePendingHistory });

const REFUSED_REASONS = ['audit-only', 'workspace-required'];
const REFUSED_HALTS = [BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];

// One sync-mode run's meaning for the marker; a session the run found busy waits like a recent one.
export function classifyRun(result, waiting) {
  if (result == null) return RunOutcome.FAILED;
  if (result.reason === 'busy') return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (!isCleanSync(result)) return RunOutcome.FAILED;
  return waiting || result.deferredOther > 0 ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

const pick = (value, fallback) => (value == null ? fallback : value);

// A recent session's start in ms: the CLI head, else the file's birth time (a VS Code chat file has no head); null when neither
// is known (counted as after the request). Some filesystems report a 0 birth time, which stays unknown.
function startedAtMs(recent, io) {
  try {
    const head = io.readSessionHead(recent.path);
    const ms = head == null ? NaN : Date.parse(head.startedAt);
    if (Number.isFinite(ms)) return ms;
    const born = io.stat(recent.path).birthtimeMs;
    return Number.isFinite(born) && born > 0 ? born : null;
  } catch {
    return null;
  }
}

// Each pending workspace's runAudit options, from the sync plan; null when no route reaches it.
function plannedRuns(row, entries, plan) {
  const optionsOf = (run) => ({ tenantId: run.tenantId, sessionRoutes: run.sessionRoutes, excludedSessionIds: run.excludedSessionIds });
  if (!isMultiTenant(row)) return entries.slice(0, 1).map((entry) => ({ entry, options: optionsOf(plan.runs[0]) }));
  return entries.map((entry) => {
    const run = plan.runs.find((r) => r.tenantId === entry.tenantId);
    return { entry, options: run == null ? null : optionsOf(run) };
  });
}

// One workspace's run → { outcome, sent, skipped }; a throwing run is a failed one.
async function runOne(key, entry, options, io, runCache) {
  const result = await io.runAudit({ runCache }, { ...options, account: key, mode: SYNC_MODE }).catch(() => null);
  if (result == null) return { outcome: RunOutcome.FAILED, sent: 0, skipped: 0 };
  const starts = Array.isArray(result.recent) ? result.recent.map((r) => startedAtMs(r, io)) : [];
  return {
    outcome: classifyRun(result, waitingOnRecent(starts, entry.requestedAt)),
    sent: result.sessionsImported || 0,
    skipped: (result.deferredGap || 0) + (result.deferredOverlap || 0) + (result.deferredUsageMode || 0),
  };
}

// Runs every pending workspace of one account once and settles each entry → [{ tenantId, outcome, state }].
export async function runPendingHistory(key, deps = {}) {
  const io = {
    accounts: pick(deps.accounts, REAL_ACCOUNTS),
    runAudit: pick(deps.runAudit, _runAudit),
    planHistoryRuns: pick(deps.planHistoryRuns, _planHistoryRuns),
    createRunCache: pick(deps.createRunCache, _createRunCache),
    readSessionHead: pick(deps.readSessionHead, _readSessionHead),
    stat: pick(deps.statImpl, (file) => fs.statSync(file)),
    now: pick(deps.now, () => Date.now()),
  };
  const { accounts } = io;
  // Taken before the row is read, so a request refreshed after this read is never counted as covered.
  const plannedAtMs = io.now();
  const row = (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
  if (row == null) return [];
  const entries = pendingHistoryOf(row);
  if (entries.length === 0) return [];
  await accounts.notePendingAttempt(key, entries.map((e) => e.tenantId), new Date(plannedAtMs).toISOString());
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const runCache = io.createRunCache();
  const done = [];
  let busy = false;
  for (const { entry, options } of plannedRuns(row, entries, io.planHistoryRuns(row))) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.CLEAN, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      run = await runOne(key, entry, options, io, runCache);
      busy = run.outcome === RunOutcome.BUSY;
    }
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: io.now() });
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}
