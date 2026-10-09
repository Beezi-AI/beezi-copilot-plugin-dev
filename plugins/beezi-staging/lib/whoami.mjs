import { apiBase, ENDPOINTS } from './config.mjs';
import { authHeaders } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { AUTH_REASONS } from './auth-state.mjs';

// What the portal said about this token. 401 and 403 are NOT the same answer: 401 is a verdict
// on the credential (one refresh may fix it), 403 is a verdict on the account (a seat, a tenant,
// a restriction — refreshing cannot fix it), and 503 OAUTH_VERIFICATION_UNAVAILABLE means the
// portal could not reach its verifier at all. Collapsing them is what let a permissions refusal
// and a verification outage delete a healthy session (findings 1, 2).
export const PROBE_OUTCOMES = Object.freeze({
  AUTHENTICATED: 'authenticated',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  UNAVAILABLE: 'unavailable',
});

// The API's "I could not complete verification" code; never a verdict on the credential.
const VERIFICATION_UNAVAILABLE = 'OAUTH_VERIFICATION_UNAVAILABLE';

// A tenant id becomes the X-Beezi-Tenant header and a file-name tag; the portal's ids are UUIDs.
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DISPLAY_MAX = 60;
// Control characters, line breaks, quotes, backticks, backslashes and angle brackets become spaces.
const DISPLAY_SPACE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029`"\u201c\u201d\u201e\u201f\\<>]+/g;
// Zero-width, bidi and Unicode tag characters: invisible to a person but read by a model, so dropped.
const DISPLAY_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

// Server-supplied names reach model-visible instructions and CLI output. The result holds no character that can
// close a quoted span or start a line, is at most `max` long (null = uncapped), and is null when nothing is left.
export function displayText(value, max = DISPLAY_MAX) {
  if (typeof value !== 'string') return null;
  let text = value.replace(DISPLAY_INVISIBLE, '').replace(DISPLAY_SPACE, ' ').replace(/\s+/g, ' ').trim();
  if (max != null && text.length > max) text = text.slice(0, max).replace(/[\ud800-\udbff]$/, '').trim();
  return text === '' ? null : text;
}

function tenantIdOrNull(value) {
  return typeof value === 'string' && TENANT_ID.test(value) ? value : null;
}

// Resolve the stored access token against the portal. Returns
// { outcome, httpStatus, identity } — identity is the whoami body's fields on AUTHENTICATED
// and null otherwise. httpStatus is null when the request never reached a response.
export async function probeIdentity(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const base = deps.base == null ? apiBase() : deps.base;
  let res;
  try {
    res = await fetchImpl(`${base}${ENDPOINTS.whoami}`, {
      headers: authHeaders(session),
    });
  } catch {
    // No response at all, so there is no status to preserve — its own reason says which.
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
    let code = null;
    try { const body = await res.json(); code = body == null ? null : body.code; } catch { /* keep null */ }
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
  let body = {};
  try { body = await res.json(); } catch { /* keep {} */ }
  return {
    outcome: PROBE_OUTCOMES.AUTHENTICATED,
    httpStatus: res.status,
    identity: {
      email: body.email == null ? null : body.email,
      name: displayText(body.name),
      tenantId: tenantIdOrNull(body.tenantId),
      tenantName: displayText(body.tenantName),
      tenantTier: body.tenantTier == null ? null : body.tenantTier,
      trackingMode: body.trackingMode == null ? null : body.trackingMode,
      backfillCompleted: body.backfillCompleted === true,
      tenants: parseTenants(body.tenants),
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
