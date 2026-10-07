import { refreshQuota } from '../lib/quota-copilot.mjs';
import { recordQuotaObservation } from '../lib/usage-report-copilot.mjs';
import { reconcileBillingConfig } from '../lib/billing-capture.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached entry point: one bounded Copilot quota probe, recorded for every linked account. It prints
// nothing and never fails loudly. BEEZI_COPILOT_PROBE=1 means this runs inside a probe child, where it
// must never recurse into another probe.
async function main() {
  if (process.env.BEEZI_COPILOT_PROBE === '1') return;
  const quota = await refreshQuota({ budgetMs: 20000 });
  // The probe also cached the runtime's account and plan; recording it now lets the next report carry it.
  reconcileBillingConfig();
  if (quota) await recordQuotaObservation(quota);
}

main().catch(() => {}).then(() => exitClean(0)).catch(() => exitClean(0));
