// sync.mjs (/beezi-local-sync): repeatable upload of what Beezi is missing, per linked account and routed workspace.
import { planHistoryRuns } from '../../history/history-run.mjs';
import { createRunCache } from '../../history/run-cache.mjs';
import { SYNC_MODE } from '../../contract/history.mjs';
import { parseAccountFlag, listAccounts, getAccount, AccountStatus } from '../../accounts/index-store.mjs';
import { describeAccount } from '../../accounts/refs.mjs';
import { parseTenantFlags } from '../tenant-flags.mjs';
import { isMultiTenant } from '../../workspace/tenants.mjs';
import { excludedLine, routeSummary, syncOutcome } from '../../ux/history-messages.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { friendlyMessage } from '../../core/errors.mjs';
import { joined as _joined } from '../workspace/joined.mjs';
import { routes as _routes } from '../workspace/routes.mjs';
import { fail, forEachRun, printOutcome, runHistory } from './run-history.mjs';

const REVIEW_FLAGS = ['--review', '--review-routes'];

// --account/--tenant only scope a sync and --review/--review-routes list Step 1 first; --since would hide half-uploaded
// old sessions and --force has no seal to force past. Refused before anything is read, the accounts index included.
function refuseFlags(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account' || arg === '--tenant') { i += 1; continue; }
    if (REVIEW_FLAGS.indexOf(arg) !== -1) continue;
    if (arg === '--since') {
      fail('Beezi: /beezi-local-sync takes no --since. It uploads exactly what Beezi is missing, wherever in your history those sessions ran. Run it with no flags.');
    }
    if (arg === '--force') {
      fail('Beezi: /beezi-local-sync takes no --force. There is no one-time seal to force past — sync resumes each session from where Beezi already has it. Run it with no flags.');
    }
    if (arg.startsWith('--')) fail(`Beezi: /beezi-local-sync takes no flags (got ${arg}). Run it with no flags.`);
  }
}

// One account/workspace run; a refusal marks the exit code and returns, so the runs after it still go.
async function syncOne(runCache, account, tenantId, sessionRoutes, excludedSessionIds = null, excludedLabel = null) {
  const result = await runHistory({ account, tenantId, sessionRoutes, excludedSessionIds, mode: SYNC_MODE }, runCache);
  if (excludedLabel != null && result.excluded > 0) console.log(excludedLine(excludedLabel, result.excluded));
  if (printOutcome(syncOutcome(result)) !== 0) process.exitCode = 1;
}

// One account: a single headerless run, the --tenant override, or one run per routed workspace.
async function syncAccount(row, rest, several, deps) {
  const override = parseTenantFlags(rest, row).tenantIds;
  // One git cache for every workspace's run of this account, so each session's git correlation runs once.
  const runCache = (deps.createRunCache == null ? createRunCache : deps.createRunCache)();
  if (!isMultiTenant(row)) {
    if (several) console.log(`\n— ${describeAccount(row)} —`);
    const { excludedSessionIds } = planHistoryRuns(row).runs[0];
    await syncOne(runCache, row.key, null, null, excludedSessionIds, excludedSessionIds == null ? null : describeAccount(row));
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  if (override.length > 0) {
    await forEachRun(row, override.map((tenantId) => ({ tenantId })), (run) => syncOne(runCache, row.key, run.tenantId, null));
    return;
  }
  const plan = planHistoryRuns(row);
  if (plan.scanned === 0) {
    console.log(`\n✓ Beezi (${describeAccount(row)}): no Copilot sessions found on this machine.`);
    return;
  }
  const summary = routeSummary(row, plan);
  if (summary != null) console.log(`\n${summary}`);
  await forEachRun(row, plan.runs, (run) => syncOne(runCache, row.key, run.tenantId, run.sessionRoutes));
}

// One listing as a <tag> block; a failed one shows its ✗ line inside and counts as nothing to ask, so the sync still runs.
async function listing(tag, print) {
  console.log(`<${tag}>`);
  let total = 0;
  try {
    total = await print();
  } catch (error) {
    console.log(`✗ ${friendlyMessage(error)}`);
  }
  console.log(`</${tag}>`);
  return total;
}

// /beezi-local-sync Step 1 in the same call: <joined> stops the review when it asks (a J answer can give a place a rule, so
// routes would be stale), else <routes>; --review-routes starts at routes. Prints review=<n> last and returns n.
async function syncReview(flag, account, deps) {
  const argv = account == null ? [] : ['--account', account];
  const cx = { deferUpload: true, deps };
  const joined = deps.joined == null ? _joined : deps.joined;
  const routes = deps.routes == null ? _routes : deps.routes;
  let review = flag === '--review' ? await listing('joined', () => joined(argv, cx)) : 0;
  if (review === 0) review = await listing('routes', () => routes(argv, cx));
  console.log(machineLine([['review', review]]));
  return review;
}

export async function runSync(argv, deps = {}) {
  refuseFlags(argv);
  const reviewFlags = argv.filter((arg) => REVIEW_FLAGS.indexOf(arg) !== -1);
  if (reviewFlags.length > 1) fail('Beezi: pass --review or --review-routes, not both.');
  const { account, rest } = await parseAccountFlag(argv.filter((arg) => REVIEW_FLAGS.indexOf(arg) === -1));
  // Something waits for an answer: the skill asks, then runs the next step itself.
  if (reviewFlags.length === 1 && (await syncReview(reviewFlags[0], account, deps)) > 0) return;
  const rows = account != null
    ? [(await getAccount(account)) || { key: account }]
    : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (rows.length === 0) fail('Beezi: this machine is not linked. Run /beezi-local-login first.');
  if (rows.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <key> when several accounts are linked.');
  }
  for (const row of rows) await syncAccount(row, rest, rows.length > 1, deps);
  // After the uploads: the worker takes any workspace still owed its past sessions (a --defer-upload rule left its marker).
  const start = deps.startHistoryWorker == null ? startHistoryWorker : deps.startHistoryWorker;
  for (const row of rows) await start(row.key);
}
