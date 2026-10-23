import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { isOriginMismatch, requestJson } from '../platform/http.mjs';
import { AUTH_REASONS } from '../contract/auth-states.mjs';
import { displayText } from '../core/text.mjs';
import { parseAnonymization, parsePastSessions } from '../core/anon-target.mjs';

// What the portal said about this token. 401 and 403 are NOT the same answer: 401 is a verdict
// on the credential (one refresh may fix it), 403 is a verdict on the account (a seat, a tenant,
// a restriction — refreshing cannot fix it), and 503 OAUTH_VERIFICATION_UNAVAILABLE means the
// portal could not reach its verifier at all. Collapsing them is what let a permissions refusal
// and a verification outage delete a healthy session.
export const PROBE_OUTCOMES = Object.freeze({
  AUTHENTICATED: 'authenticated',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  UNAVAILABLE: 'unavailable',
});

// Interactive callers (login, sync) wait this long; SessionStart passes its own, shorter cap.
const PROBE_TIMEOUT_MS = 10000;

// The API's "I could not complete verification" code; never a verdict on the credential.
const VERIFICATION_UNAVAILABLE = 'OAUTH_VERIFICATION_UNAVAILABLE';

// A tenant id becomes the X-Beezi-Tenant header and a file-name tag; the portal's ids are UUIDs.
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function tenantIdOrNull(value) {
  return typeof value === 'string' && TENANT_ID.test(value) ? value : null;
}

// Resolve the stored access token against the portal. Returns
// { outcome, httpStatus, identity } — identity is the whoami body's fields on AUTHENTICATED
// and null otherwise. httpStatus is null when the request never reached a response.
export async function probeIdentity(session, deps = {}) {
  const base = deps.base == null ? apiBase() : deps.base;
  const timeoutMs = deps.timeoutMs == null ? PROBE_TIMEOUT_MS : deps.timeoutMs;
  let res;
  try {
    res = await requestJson(`${base}${ENDPOINTS.whoami}`, session, {}, { fetchImpl: deps.fetchImpl, timeoutMs });
  } catch (error) {
    // A credential pinned to another API origin was never sent: only a new login clears it, and no refresh helps.
    if (isOriginMismatch(error)) {
      return { outcome: PROBE_OUTCOMES.UNAUTHORIZED, httpStatus: null, identity: null, reason: AUTH_REASONS.UNAUTHORIZED, originMismatch: true };
    }
    // No response at all (or none in time), so there is no status to preserve — its own reason says which.
    return {
      outcome: PROBE_OUTCOMES.UNAVAILABLE, httpStatus: null, identity: null,
      reason: AUTH_REASONS.PROBE_UNREACHABLE,
    };
  }
  if (res.status === 401) {
    return {
      outcome: PROBE_OUTCOMES.UNAUTHORIZED, httpStatus: 401, identity: null,
      reason: AUTH_REASONS.UNAUTHORIZED,
    };
  }
  if (res.status === 403) {
    return {
      outcome: PROBE_OUTCOMES.FORBIDDEN, httpStatus: 403, identity: null,
      reason: AUTH_REASONS.FORBIDDEN,
    };
  }
  if (!res.ok) {
    const code = res.body == null ? null : res.body.code;
    const verificationUnavailable = code === VERIFICATION_UNAVAILABLE;
    // The reason a diagnostic carries, so "the server could not check" and "we were rate
    // limited" stay distinguishable from an ordinary 5xx in the evidence trail.
    let reason = null;
    if (verificationUnavailable) reason = AUTH_REASONS.VERIFICATION_UNAVAILABLE;
    else if (res.status === 429) reason = AUTH_REASONS.RATE_LIMITED;
    return {
      outcome: PROBE_OUTCOMES.UNAVAILABLE,
      httpStatus: res.status,
      identity: null,
      verificationUnavailable,
      reason,
    };
  }
  const body = res.body == null ? {} : res.body;
  const tenantId = tenantIdOrNull(body.tenantId);
  return {
    outcome: PROBE_OUTCOMES.AUTHENTICATED,
    httpStatus: res.status,
    identity: {
      email: body.email == null ? null : body.email,
      name: displayText(body.name),
      tenantId,
      tenantName: displayText(body.tenantName),
      tenantTier: body.tenantTier == null ? null : body.tenantTier,
      trackingMode: body.trackingMode == null ? null : body.trackingMode,
      backfillCompleted: body.backfillCompleted === true,
      tenants: parseTenants(body.tenants),
      anonymization: parseAnonymization(body.anonymization, tenantId),
      pastSessions: parsePastSessions(body.pastSessions),
    },
  };
}

// Absent list → null (unknown, old server), never []; entries whose id is not a plain id are dropped.
function parseTenants(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t) => t != null && tenantIdOrNull(t.id) != null)
    .map((t) => ({
      id: t.id,
      name: displayText(t.name),
      role: displayText(t.role),
      type: displayText(t.type),
      joinedAt: typeof t.joinedAt === 'string' && Number.isFinite(Date.parse(t.joinedAt)) ? t.joinedAt : null,
      anonymization: parseAnonymization(t.anonymization, t.id),
      pastSessions: parsePastSessions(t.pastSessions),
    }));
}

// Compatibility shape for the many callers that only ask "is this token good": { valid: true,
// … } | { valid: false } | null (offline/unknown). It cannot express forbidden-vs-unauthorized
// -vs-unavailable — every user-facing decision reads probeIdentity instead.
export async function whoami(session, deps = {}) {
  const probe = await probeIdentity(session, deps);
  if (probe.outcome === PROBE_OUTCOMES.AUTHENTICATED) return { valid: true, ...probe.identity };
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE) return null;
  return { valid: false };
}
