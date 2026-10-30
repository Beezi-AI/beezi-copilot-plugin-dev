// Bounded HTTP with a timeout: an authenticated POST of a JSON body, an authenticated JSON exchange, and an
// unauthenticated GET returning parsed JSON. All throw on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-headers.mjs';
import { resolveFetch } from './compat-fetch.mjs';
import { resolveAbortController } from './compat-abort.mjs';

const DEFAULT_TIMEOUT_MS = 3000;

export const ORIGIN_MISMATCH = 'ORIGIN_MISMATCH';

// A refused send to another origin: an auth state only a new login clears, never a transport failure.
export function isOriginMismatch(error) {
  return error != null && error.code === ORIGIN_MISMATCH;
}

// A credential that recorded its API origin is sent only there; one without it (older logins) is not pinned.
export function refusesOrigin(url, session) {
  const pinned = session == null ? null : session.apiOrigin;
  return typeof pinned === 'string' && pinned !== '' && new URL(String(url)).origin !== pinned;
}

export function assertTokenOrigin(url, session) {
  if (!refusesOrigin(url, session)) return;
  const error = new Error(`Refusing to send the Beezi credential outside ${session.apiOrigin}.`);
  error.code = ORIGIN_MISMATCH;
  throw error;
}

// Bearer and machine headers; with `url`, the credential's origin pin is checked first.
export function authHeaders(session, url) {
  if (session == null || typeof session.token !== 'string' || !session.token) {
    throw new TypeError('An authenticated account session is required.');
  }
  if (url != null) assertTokenOrigin(url, session);
  const headers = { Authorization: `Bearer ${session.token}`, ...machineHeaders(session.clientId) };
  if (typeof session.tenantId === 'string' && session.tenantId) headers['X-Beezi-Tenant'] = session.tenantId;
  return headers;
}

function timeoutError() {
  const error = new Error('The operation timed out.');
  error.name = 'AbortError';
  return error;
}

// Runs `run(signal)` under one timer that aborts the signal and rejects, so neither a transport that ignores the
// signal nor a body read past the headers outlives the timeout.
async function withTimeout(deps, run) {
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  let timer = null;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function fetchOf(deps) {
  return deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
}

// The timeout covers the headers only: the caller reads the body of the returned response. A redirect is an error:
// an authenticated call never follows one.
export async function postJson(url, session, body, deps = {}) {
  const fetchImpl = fetchOf(deps);
  const headers = { ...authHeaders(session, url), 'Content-Type': 'application/json' };
  // History passes its gzip encoder so live posts never load zlib; it runs before the timer starts.
  const gzipped = deps.gzip == null ? null : await deps.gzip(body);
  if (gzipped != null) headers['Content-Encoding'] = 'gzip';
  return withTimeout(deps, (signal) => fetchImpl(url, {
    method: 'POST',
    headers,
    body: gzipped == null ? JSON.stringify(body) : gzipped,
    redirect: 'error',
    signal,
  }));
}

// Authenticated GET (or POST of `request.body`) whose timeout covers the headers AND the body read.
// → { status, ok, body }, body null when the response is not JSON.
export async function requestJson(url, session, request = {}, deps = {}) {
  const fetchImpl = fetchOf(deps);
  const headers = authHeaders(session, url);
  const init = request.body === undefined
    ? { method: 'GET', headers, redirect: 'error' }
    : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), redirect: 'error' };
  return withTimeout(deps, async (signal) => {
    const res = await fetchImpl(url, { ...init, signal });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, ok: res.ok, body: parsed };
  });
}

// Bounded, UNAUTHENTICATED GET returning parsed JSON.
//
// Deliberately takes no token and sends no machineHeaders(): its only caller reads a PUBLIC
// marketplace manifest from raw.githubusercontent.com, and this plugin's bearer token must never
// leave the Beezi API host. The absent token parameter is the guarantee — do not add one.
// Throws on network error, timeout, non-2xx, or a body that is not JSON; the caller catches.
export async function getJson(url, deps = {}) {
  const fetchImpl = fetchOf(deps);
  return withTimeout(deps, async (signal) => {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal,
    });
    if (res == null || res.status < 200 || res.status >= 300) {
      throw new Error(`GET failed with status ${res == null ? 'none' : res.status}`);
    }
    return await res.json();
  });
}
