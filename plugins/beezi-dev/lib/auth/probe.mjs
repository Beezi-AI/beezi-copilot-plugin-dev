// The portal's verdict on one account's token, as SessionStart reads it.
import { probeIdentity, PROBE_OUTCOMES } from './whoami.mjs';

// The portal's verdict on the token, kept at full resolution. 401 is a verdict on the
// credential and one refresh may fix it; 403 is a verdict on the account and no refresh can;
// anything else is a check we could not run, which stays silent. Nothing here ever discards
// credentials — that is the loop that used to delete a refreshable session.
// `who` carries the tenant's tracking policy for the rest of the hook; originMismatch (only when set) says the token was kept
// from another API origin, which no refresh fixes.
export async function probeToken(session, deps) {
  const probe = await probeIdentity(session, deps);
  return {
    outcome: probe.outcome,
    reason: probe.reason == null ? null : probe.reason,
    who: probe.outcome === PROBE_OUTCOMES.AUTHENTICATED ? { valid: true, ...probe.identity } : null,
    ...(probe.originMismatch === true ? { originMismatch: true } : {}),
  };
}
