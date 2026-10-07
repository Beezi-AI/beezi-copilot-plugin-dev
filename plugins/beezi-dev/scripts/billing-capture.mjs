import { parseArgs, reconcileBillingConfig, declarePlan, ReconcileOutcome } from '../lib/billing-capture.mjs';
import { billingStatus, planLabel, BillingSource } from '../lib/billing.mjs';
import { defaultSession, sessionFor } from '../lib/sessions.mjs';
import { parseAccountFlag, getAccount, getDefaultKey } from '../lib/accounts.mjs';
import { parseCommandTargets, parseTenantFlags } from '../lib/workspace.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { checkInteractive } from '../lib/mode-guard.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The skills parse these lines and never show them: source, plan (n/a when the source is unknown), plan-source, identity.
function machineLines(config) {
  const status = billingStatus({ config });
  const plan = status.source === BillingSource.SUBSCRIPTION ? (status.plan == null ? 'unknown' : status.plan) : 'n/a';
  return [`source=${status.source}`, `plan=${plan}`, `plan-source=${status.planSource}`, `identity=${status.identity.status}`];
}

// Report the freshly reconciled account to the portal, once per target workspace. Forced — the user just
// asked for a re-read or declared a plan, and neither should wait for the hash to drift. Silent throughout:
// an unlinked or offline machine has no token or no route and this script must keep working, so nothing
// here can change the command's output or its exit code.
async function reportAccount(account, tenantIds, via) {
  let session = null;
  try { session = account ? await sessionFor(account) : await defaultSession(); } catch { session = null; }
  if (!session) return;
  for (const tenantId of tenantIds) {
    try {
      await syncAccountIfNeeded({ ...session, tenantId }, { force: true, via: via == null ? 'billing-capture' : via });
    } catch { /* best-effort */ }
  }
}

// The session's target workspaces; none while its ask is unanswered, so only the local capture runs.
function captureTargets(rest, row) {
  try {
    return parseCommandTargets(rest, row);
  } catch (error) {
    if (error == null || error.workspaceRequired !== true) throw error;
    return { argv: parseTenantFlags(rest, row).argv, tenantIds: [] };
  }
}

async function run() {
  const { account: beeziAccount, rest } = await parseAccountFlag(process.argv.slice(2));
  // Offline or unlinked still works: no row means no tenant, and --tenant then says why.
  let row = null;
  try { row = await getAccount(beeziAccount || await getDefaultKey()); } catch { row = null; }
  const { argv, tenantIds } = captureTargets(rest, row);
  const parsed = parseArgs(argv);

  if (parsed.fromCopilot) {
    // The same file-only capture SessionStart runs: observed plan for the live GitHub identity, and identity-change detection.
    const { config, outcome, changes } = reconcileBillingConfig();
    const status = billingStatus({ config });
    if (outcome === ReconcileOutcome.NO_SIGNAL) console.log('Beezi: no Copilot sign-in found on this machine; nothing captured.');
    else if (status.plan != null) console.log(`✓ Beezi billing: Copilot ${planLabel(status.plan)}.`);
    else console.log('✓ Beezi billing: Copilot plan unknown on this machine.');
    for (const line of changes) console.log(line);
    for (const line of machineLines(config)) console.log(line);
    // After the reconcile, so the check-in carries the identity this run just resolved.
    await reportAccount(beeziAccount, tenantIds, parsed.via);
    return;
  }

  // --plan persists a user answer, so an unattended session must not reach the write (a guessed answer is not consent).
  const verdict = await checkInteractive({ purpose: 'saving your Copilot plan', requireWrite: true });
  if (verdict != null && verdict.ok === false) {
    console.log(`✗ ${verdict.message}`);
    return;
  }
  const { config } = declarePlan(parsed.clear ? 'clear' : parsed.plan);
  console.log(parsed.clear ? '✓ Beezi: cleared your declared Copilot plan.' : `✓ Beezi: saved your Copilot plan (${planLabel(parsed.plan)}).`);
  for (const line of machineLines(config)) console.log(line);
  // The user just declared how this machine pays — that answer is what the check-in exists to carry.
  await reportAccount(beeziAccount, tenantIds, parsed.via);
}

run().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
