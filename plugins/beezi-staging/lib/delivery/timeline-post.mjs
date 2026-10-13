// Owns the live session-timeline POST to the portal.
import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { postJson } from '../platform/http.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';

export async function postSessionTimeline(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !Array.isArray(payload.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  try {
    // timeoutMs is undefined for every hook caller, so postJson keeps its 3s default.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionsTimeline}`, session, payload, { fetchImpl, timeoutMs: deps.timeoutMs });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
