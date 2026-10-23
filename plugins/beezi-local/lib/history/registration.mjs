// The run's one identity snapshot and the account check-in history reports need before they can resolve.
import { ENDPOINTS, apiBase } from '../config/api.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { buildAccountSyncPayload } from '../billing/account-sync.mjs';
import { AUDIT_TIMEOUT_MS } from '../contract/history.mjs';
import { anonymizeAccountSync } from '../core/anonymize-payload.mjs';
import { attempt, identityFor } from './identity-apply.mjs';

// Sets run.billingSnapshot; false (with result.reason set) when the registration failed.
export async function registerAccount(run) {
  let snapshot = null;
  try { snapshot = readBillingConfig(); } catch { snapshot = null; }
  const { stamp } = identityFor(snapshot);
  run.billingSnapshot = snapshot;
  const built = attempt(() => buildAccountSyncPayload({ config: snapshot }), {});
  // Hashed with the run's key while accounts are hidden, so it names the same account as the reports' account_uuid.
  const registration = run.anonKinds.indexOf('accounts') === -1 ? built : anonymizeAccountSync(built, run.anonKey);
  // History reports can only resolve their account after it is registered for this workspace, and the reply is verified.
  if (run.dryRun || (stamp.account_uuid == null && stamp.account_email == null)) return true;
  return postRegistration(run, registration);
}

async function postRegistration(run, registration) {
  const { result } = run;
  const register = (as) => run.io.postJson(`${apiBase()}${ENDPOINTS.accountSync}`, as, registration, { fetchImpl: run.io.fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
  try {
    let res = await register(run.session);
    if (res.status === 401) {
      const renewed = await run.io.getAccessToken({}, { account: run.key, forceRefresh: true }).catch(() => null);
      if (renewed) {
        run.session = { ...run.session, token: renewed };
        res = await register(run.session);
      }
    }
    const accepted = res.status >= 200 && res.status < 300;
    const reply = accepted ? await res.json().catch(() => null) : null;
    if (!accepted || reply == null || reply.accountLinked !== true) {
      result.reason = 'account-registration-failed';
      result.lastError = accepted ? 'account was not linked' : `HTTP ${res.status}`;
      return false;
    }
    return true;
  } catch {
    result.reason = 'account-registration-failed';
    result.lastError = 'network';
    return false;
  }
}
