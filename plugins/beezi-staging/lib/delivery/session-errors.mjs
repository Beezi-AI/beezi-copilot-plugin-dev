// Session-error records: their validity and dedupe key, the parked list's cap, and their POSTs to Beezi.
import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { postJson } from '../platform/http.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { isPlain } from '../core/guards.mjs';
import { REPORT_OUTCOME, classifyReportResponse } from './report-verdicts.mjs';

export const MAX_PENDING_ERRORS = 20;

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
export async function postSessionError(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs is undefined for every hook caller, so postJson keeps its 3s default; the bulk
    // import raises it, having no 10s hook budget to protect.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionErrors}`, session, payload, { fetchImpl, timeoutMs: deps.timeoutMs });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}

export function validError(e) {
  return isPlain(e) && typeof e.error === 'string' && e.error !== '';
}

// Matches the server's own row key closely enough to fold a parked error and its fresh twin into one.
export function errorKey(e) {
  return `${e.error}|${e.occurredAt == null ? '' : e.occurredAt}|${e.errorDetails == null ? '' : e.errorDetails}`;
}

// A post that landed, or that a refusing 4xx answered: neither changes on a retry. Auth, a missing route, a proxy, a conflict
// and a throttle keep the error parked, by the same classes as a queued report.
export function isSettledPost(r) {
  if (r.reported === true) return true;
  return typeof r.status === 'number' && classifyReportResponse(r.status, null) === REPORT_OUTCOME.QUARANTINE;
}

export function dedupeErrors(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = errorKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// The parked list after adding `more`: deduped, newest MAX_PENDING_ERRORS kept.
export function parkErrors(pending, more) {
  return dedupeErrors([...pending, ...more]).slice(-MAX_PENDING_ERRORS);
}

// Posts each error to every target while time is left; → { delivered: Set of errorKey, undelivered (newest kept) }.
// An error is delivered once every target settled it; timeLeft() and timeoutMs() are read per error and per post.
export async function deliverErrors(candidates, targets, sessionId, { fetchImpl, timeLeft, timeoutMs }) {
  const delivered = new Set();
  const undelivered = [];
  for (const e of candidates) {
    const left = timeLeft();
    if (targets.length === 0 || (left != null && left <= 0)) {
      undelivered.push(e);
      continue;
    }
    const results = await Promise.all(targets.map((s) => postSessionError({ ...e, sessionId }, s, { fetchImpl, timeoutMs: timeoutMs() })));
    if (results.every(isSettledPost)) delivered.add(errorKey(e));
    else undelivered.push(e);
  }
  return { delivered, undelivered: undelivered.slice(-MAX_PENDING_ERRORS) };
}
