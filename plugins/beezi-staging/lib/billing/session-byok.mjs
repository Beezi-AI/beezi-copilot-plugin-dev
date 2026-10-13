// Owns the one BYOK verdict per session, shared by the live checkpoint and history so a report is never sent
// `unknown` live and `subscription` on /beezi-staging-sync. BYOK usage is sent `billing_source: unknown`.
import { isByokProvider } from '../sources/app/app-db.mjs';
import { byokProviderNames, usesProviderModel } from '../sources/cli/byok-providers.mjs';
import { copilotAuthEnv } from '../sources/cli/copilot-identity.mjs';

// → boolean. The app's provider row decides an app session. Otherwise a session that selected or ran a model of a
// providers.json provider is BYOK: named providers are additive, so a session mixing Copilot and BYOK models counts as
// BYOK whole (one report carries one billing source). Otherwise only the session's own hook may read its env
// (COPILOT_PROVIDER_BASE_URL); another process's env says nothing about the session, so it is not BYOK.
// input: { appFacts (appSessionFacts() or null), events, ownProcess, env, providerNames (test seam) }. Never throws.
export function sessionByok({ appFacts = null, events = [], ownProcess = false, env = process.env, providerNames = byokProviderNames } = {}) {
  try {
    if (appFacts != null) return isByokProvider(appFacts.providerId);
    if (usesProviderModel(events, providerNames({ env }))) return true;
    return ownProcess === true && copilotAuthEnv(env).byok === true;
  } catch {
    return false;
  }
}
