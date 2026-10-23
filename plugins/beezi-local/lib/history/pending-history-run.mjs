// The history worker's pass: one run per workspace whose past-sessions offer was accepted, over exactly the sessions the yes accepted.
import fs from 'fs';
import { runAudit as _runAudit, planHistoryRuns as _planHistoryRuns } from './history-run.mjs';
import { createRunCache as _createRunCache } from './run-cache.mjs';
import { isCleanSync } from './run-result.mjs';
import { BACKFILL_MODE, REFUSED_HALTS, REFUSED_REASONS, sessionStartMs } from './offer-scan.mjs';
import { BackfillHalt, SYNC_MODE } from '../contract/history.mjs';
import { readSessionHead as _readSessionHead } from '../sources/cli/session-files.mjs';
import { clearOfferScan as _clearOfferScan } from '../workspace/history-offer-record.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { acceptedOf, pendingHistoryOf, waitingOnRecent, RunOutcome, SettleState } from '../workspace/pending-history.mjs';
import { notePendingAttempt, settlePendingHistory } from '../workspace/settings-store.mjs';
import { AccountStatus, listAccounts } from '../accounts/index-store.mjs';

const REAL_ACCOUNTS = Object.freeze({ AccountStatus, listAccounts, notePendingAttempt, settlePendingHistory });

const isSealed = (result) => result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED;

// One run's meaning for the marker; a session the run found busy waits like a recent one, and a sealed pull has nothing left to take.
export function classifyRun(result, waiting) {
  if (result == null) return RunOutcome.FAILED;
  if (result.reason === 'busy') return RunOutcome.BUSY;
  if (isSealed(result)) return RunOutcome.CLEAN;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (!isCleanSync(result)) return RunOutcome.FAILED;
  return waiting || result.deferredOther > 0 ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

const pick = (value, fallback) => (value == null ? fallback : value);

// The accepted workspace's runAudit options: the sync plan's run (a single workspace runs headerless), or no routes when unrouted.
function runOptions(multi, entry, accepted, plan) {
  let run = plan.runs[0];
  if (multi && accepted.unrouted) run = { tenantId: entry.tenantId, sessionRoutes: null };
  else if (multi) run = plan.runs.find((r) => r.tenantId === entry.tenantId);
  if (run == null) return null;
  const options = {
    tenantId: run.tenantId,
    sessionRoutes: run.sessionRoutes,
    excludedSessionIds: run.excludedSessionIds,
    onlySessionIds: accepted.sessionIds,
    hiddenKinds: accepted.hiddenKinds,
  };
  if (accepted.mode !== BACKFILL_MODE) options.mode = SYNC_MODE;
  return options;
}

// Each consented workspace's runAudit options and accepted scan stamp; options null when its entry carries no accepted sessions or no route reaches it.
function plannedRuns(row, entries, plan) {
  const multi = isMultiTenant(row);
  return (multi ? entries : entries.slice(0, 1)).map((entry) => {
    const accepted = acceptedOf(entry);
    if (accepted == null) return { entry, scannedAt: null, options: null };
    return { entry, scannedAt: accepted.scannedAt, options: runOptions(multi, entry, accepted, plan) };
  });
}

// One workspace's run → { outcome, sent, skipped }; a throwing run is a failed one.
async function runOne(key, entry, options, io, runCache) {
  const result = await io.runAudit({ runCache }, { ...options, account: key }).catch(() => null);
  if (result == null) return { outcome: RunOutcome.FAILED, sent: 0, skipped: 0 };
  const starts = Array.isArray(result.recent) ? result.recent.map((r) => sessionStartMs({ transcriptPath: r.path }, io)) : [];
  return {
    outcome: classifyRun(result, waitingOnRecent(starts, entry.requestedAt)),
    sent: result.sessionsImported || 0,
    skipped: (result.deferredGap || 0) + (result.deferredOverlap || 0) + (result.deferredUsageMode || 0),
  };
}

// Compare-and-clear on the scan the yes accepted, so a scan written since survives; best-effort.
async function clearScan(io, key, tenantId, scannedAt) {
  try { await io.clearOfferScan(key, tenantId, { scannedAt }); } catch { /* best-effort */ }
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
    clearOfferScan: pick(deps.clearOfferScan, _clearOfferScan),
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
  for (const { entry, scannedAt, options } of plannedRuns(row, entries, io.planHistoryRuns(row))) {
    // Busy once, busy for the rest of the pass; a workspace with no run to make settles as refused.
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.REFUSED, sent: 0, skipped: 0 };
    if (!busy && options != null) run = await runOne(key, entry, options, io, runCache);
    busy = run.outcome === RunOutcome.BUSY;
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: io.now() });
    if (state === SettleState.CLEARED || state === SettleState.GAVE_UP) await clearScan(io, key, entry.tenantId, scannedAt);
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}
