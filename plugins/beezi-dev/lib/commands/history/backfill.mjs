// backfill.mjs: the last step of /beezi-dev-login, the one-time history import per routed workspace (re-running it resumes an interrupted upload).
import { parseArgs } from '../history-args.mjs';
import { planHistoryRuns } from '../../history/history-run.mjs';
import { createRunCache } from '../../history/run-cache.mjs';
import { BackfillHalt, SYNC_MODE } from '../../contract/history.mjs';
import { parseAccountFlag, getAccount } from '../../accounts/index-store.mjs';
import { describeAccount } from '../../accounts/refs.mjs';
import { parseTenantFlags } from '../tenant-flags.mjs';
import { isMultiTenant, joinedAfterLink } from '../../workspace/tenants.mjs';
import { friendlyMessage } from '../../core/errors.mjs';
import { usesRules } from '../../workspace/rule-model.mjs';
import { readTrackingState, matchesIdentity } from '../../state/tracking.mjs';
import { NO_PAST_SESSIONS_LINE, backfillOutcome, excludedLine, joinedOutcome, routeSummary } from '../../ux/history-messages.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import { fail, forEachRun, printOutcome, runHistory } from './run-history.mjs';

// One workspace's run (--dry-run, --since and --force are for manual runs only); returns the exit status instead of exiting mid-loop.
async function backfillOne(runCache, account, tenantId, argv, sessionRoutes, excludedSessionIds = null, excludedLabel = null) {
  const options = parseArgs(argv);
  options.account = account;
  options.tenantId = tenantId;
  options.sessionRoutes = sessionRoutes;
  options.excludedSessionIds = excludedSessionIds;
  const viaLogin = options.via === 'login';
  const result = await runHistory(options, runCache);
  if (excludedLabel != null && result.excluded > 0) console.log(excludedLine(excludedLabel, result.excluded));
  return printOutcome(backfillOutcome(result, { viaLogin, dryRun: options.dryRun, sinceMs: options.sinceMs }));
}

// A workspace joined after this machine linked the account got nothing live before the re-pick, so its
// history resumes from what it already has (sync's coverage check). One that takes no uploads on
// demand (audit-only) gets the one-time import instead, which has no link cutoff there.
async function backfillJoinedOne(runCache, account, tenantId, argv, sessionRoutes) {
  const options = { ...parseArgs(argv), account, tenantId, sessionRoutes, mode: SYNC_MODE };
  const result = await runHistory(options, runCache);
  if (result.reason === 'audit-only' || result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    return backfillOne(runCache, account, tenantId, argv, sessionRoutes);
  }
  // A stop the next run will not clear prints backfillOne's own ✗ line; busy and pending runs get the sync line.
  const complete = result.reason == null && result.halt == null
    && !(result.coverageKnown === false && result.candidates > 0)
    && !(result.reportsFailed > 0) && !(result.deferred > 0);
  return printOutcome(joinedOutcome(result, { dryRun: options.dryRun, complete }));
}

// One or unknown workspaces: one headerless run; returns its exit status.
async function backfillSingle(runCache, account, row, argv) {
  // Already sealed (and not forced): the same test runAudit uses, identity included, so a mismatch still plans the exclusions.
  const tracking = readTrackingState(row.key);
  const sealed = tracking != null && tracking.backfillCompleted === true && matchesIdentity(tracking, row.clientId == null ? null : row.clientId) && !parseArgs(argv).force;
  if (usesRules(row) && !sealed) {
    const { excludedSessionIds } = planHistoryRuns(row).runs[0];
    return backfillOne(runCache, account, null, argv, null, excludedSessionIds, describeAccount(row));
  }
  return backfillOne(runCache, account, null, argv, null);
}

// After the uploads (never on --dry-run): the worker takes any workspace still owed its past sessions, then a failed run exits 1.
async function finish(account, argv, status, deps) {
  const start = deps.startHistoryWorker == null ? startHistoryWorker : deps.startHistoryWorker;
  if (!parseArgs(argv).dryRun) await start(account);
  if (status !== 0) process.exit(status);
}

export async function runBackfill(args, deps = {}) {
  const { account, rest } = await parseAccountFlag(args);
  if (account == null) fail('Beezi: backfill needs --account <key|email|n>. /beezi-dev-login passes it automatically.');
  const row = (await getAccount(account)) || { key: account };
  const { argv, tenantIds: override } = parseTenantFlags(rest, row);
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const runCache = (deps.createRunCache == null ? createRunCache : deps.createRunCache)();
  if (!isMultiTenant(row)) {
    await finish(account, argv, await backfillSingle(runCache, account, row, argv), deps);
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  let runs = override.map((tenantId) => ({ tenantId, sessionRoutes: null }));
  if (runs.length === 0) {
    const plan = planHistoryRuns(row, { markWaiting: true });
    if (plan.scanned === 0) {
      console.log(NO_PAST_SESSIONS_LINE);
      return;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(summary);
    runs = plan.runs;
  }
  const joinedIds = joinedAfterLink(row);
  let status = 0;
  await forEachRun(row, runs, async (run) => {
    // One workspace's exception must not stop the rest.
    try {
      const runner = joinedIds.indexOf(run.tenantId) === -1 ? backfillOne : backfillJoinedOne;
      if (await runner(runCache, account, run.tenantId, argv, run.sessionRoutes) !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  });
  await finish(account, argv, status, deps);
}
