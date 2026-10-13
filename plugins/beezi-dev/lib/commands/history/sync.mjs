// sync.mjs (/beezi-dev-sync): repeatable upload of what Beezi is missing, per linked account and routed workspace.
import { planHistoryRuns } from '../../history/history-run.mjs';
import { SYNC_MODE } from '../../contract/history.mjs';
import { parseAccountFlag, listAccounts, getAccount, AccountStatus } from '../../accounts/index-store.mjs';
import { describeAccount } from '../../accounts/refs.mjs';
import { parseTenantFlags } from '../tenant-flags.mjs';
import { isMultiTenant } from '../../workspace/tenants.mjs';
import { excludedLine, routeSummary, syncOutcome } from '../../ux/history-messages.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import { fail, forEachRun, printOutcome, runHistory } from './run-history.mjs';

// --account/--tenant only scope a sync; --since would hide half-uploaded old sessions and --force has no seal to force past.
// Refused before anything is read, the accounts index included. --account and --tenant each take a value.
function refuseFlags(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account' || arg === '--tenant') { i += 1; continue; }
    if (arg === '--since') {
      fail('Beezi: /beezi-dev-sync takes no --since. It uploads exactly what Beezi is missing, wherever in your history those sessions ran. Run it with no flags.');
    }
    if (arg === '--force') {
      fail('Beezi: /beezi-dev-sync takes no --force. There is no one-time seal to force past — sync resumes each session from where Beezi already has it. Run it with no flags.');
    }
    if (arg.startsWith('--')) fail(`Beezi: /beezi-dev-sync takes no flags (got ${arg}). Run it with no flags.`);
  }
}

// One account/workspace run; a refusal marks the exit code and returns, so the runs after it still go.
async function syncOne(account, tenantId, sessionRoutes, excludedSessionIds = null, excludedLabel = null) {
  const result = await runHistory({ account, tenantId, sessionRoutes, excludedSessionIds, mode: SYNC_MODE });
  if (excludedLabel != null && result.excluded > 0) console.log(excludedLine(excludedLabel, result.excluded));
  if (printOutcome(syncOutcome(result)) !== 0) process.exitCode = 1;
}

// One account: a single headerless run, the --tenant override, or one run per routed workspace.
async function syncAccount(row, rest, several) {
  const override = parseTenantFlags(rest, row).tenantIds;
  if (!isMultiTenant(row)) {
    if (several) console.log(`\n— ${describeAccount(row)} —`);
    const { excludedSessionIds } = planHistoryRuns(row).runs[0];
    await syncOne(row.key, null, null, excludedSessionIds, excludedSessionIds == null ? null : describeAccount(row));
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  if (override.length > 0) {
    await forEachRun(row, override.map((tenantId) => ({ tenantId })), (run) => syncOne(row.key, run.tenantId, null));
    return;
  }
  const plan = planHistoryRuns(row);
  if (plan.scanned === 0) {
    console.log(`\n✓ Beezi (${describeAccount(row)}): no Copilot sessions found on this machine.`);
    return;
  }
  const summary = routeSummary(row, plan);
  if (summary != null) console.log(`\n${summary}`);
  await forEachRun(row, plan.runs, (run) => syncOne(row.key, run.tenantId, run.sessionRoutes));
}

export async function runSync(argv, deps = {}) {
  refuseFlags(argv);
  const { account, rest } = await parseAccountFlag(argv);
  const rows = account != null
    ? [(await getAccount(account)) || { key: account }]
    : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (rows.length === 0) fail('Beezi: this machine is not linked. Run /beezi-dev-login first.');
  if (rows.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <key> when several accounts are linked.');
  }
  for (const row of rows) await syncAccount(row, rest, rows.length > 1);
  // After the uploads: the worker takes any workspace still owed its past sessions (a --defer-upload rule left its marker).
  const start = deps.startHistoryWorker == null ? startHistoryWorker : deps.startHistoryWorker;
  for (const row of rows) await start(row.key);
}
