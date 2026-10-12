import { updateAccount } from '../accounts/index-store.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from '../auth/token.mjs';
import { probeIdentity as _probeIdentity, PROBE_OUTCOMES } from '../auth/whoami.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../contract/auth-states.mjs';
import { DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { recordAuthResult as _recordAuthResult } from '../auth/diagnostics.mjs';
import {
  authStatusLines, FORBIDDEN_STATUS_LINES, VERIFICATION_UNAVAILABLE_STATUS_LINES,
} from './auth-messages.mjs';

// Signs the account in, checks it with the server and saves its identity; `lines` say what is wrong ([] when ok).
export async function accountHealth(account, deps = {}) {
  const fail = (lines) => ({ ok: false, lines, identity: null });
  if (account.status === 'revoked') return fail(['  Revoked — run /beezi-dev-login and sign in as this account.']);
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;
  const probeIdentity = deps.probeIdentity == null ? _probeIdentity : deps.probeIdentity;
  const waitMs = deps.waitMs == null ? INTERACTIVE_REFRESH_WAIT_MS : deps.waitMs;
  const recordAuthResultImpl = deps.recordAuthResult == null ? _recordAuthResult : deps.recordAuthResult;

  const auth = await getAuthentication(deps, { account: account.key, waitMs });
  if (auth.authState !== AUTH_STATES.READY) return fail(authStatusLines(auth));

  const probeSession = (a) => pinnedTo({ key: account.key, token: a.accessToken, clientId: a.clientId || account.clientId }, a);
  let probe = await probeIdentity(probeSession(auth), deps);
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED && probe.originMismatch !== true) {
    // The server's word beats this client's expiry estimate for an opaque token — but only a
    // real 401 earns the retry. A 403 or a 503 is never a reason to spend a refresh grant.
    const retry = await getAuthentication(deps, { account: account.key, forceRefresh: true, waitMs });
    if (retry.authState !== AUTH_STATES.READY) return fail(authStatusLines(retry));
    probe = await probeIdentity(probeSession(retry), deps);
  }
  if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
    recordAuthResultImpl(
      { authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.FORBIDDEN },
      { account: account.key, source: DIAGNOSTIC_SOURCES.ME },
    );
    return fail(FORBIDDEN_STATUS_LINES);
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE) {
    if (probe.reason != null) {
      recordAuthResultImpl(
        { authState: AUTH_STATES.UNAVAILABLE, reason: probe.reason },
        { account: account.key, source: DIAGNOSTIC_SOURCES.ME },
      );
    }
    return fail(probe.verificationUnavailable
      ? VERIFICATION_UNAVAILABLE_STATUS_LINES
      : ['Beezi: could not reach the server to check your link. Check your connection and try again.']);
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    return fail([
      'Beezi: the server no longer accepts this machine’s authorization.',
      '  Your saved authorization is still here — run /beezi-dev-login to authorize this machine again.',
    ]);
  }

  const who = probe.identity;
  await updateAccount(account.key, who, deps);
  return { ok: true, lines: [], identity: who };
}
