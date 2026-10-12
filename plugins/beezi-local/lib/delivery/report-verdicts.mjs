// What one /sessions/report answer means (classifyReportResponse) and what it does to its queued file (applyResponse).
// Pure: queue-flush applies the verdicts, and session-errors settles its own posts by the same classes.

export const REPORT_OUTCOME = Object.freeze({
  DELIVERED: 'delivered',
  RENEW: 'renew',
  FORBIDDEN: 'forbidden',
  NOT_CONNECTED: 'not-connected',
  RETRY: 'retry',
  QUARANTINE: 'quarantine',
});

// Statuses that say nothing against the payload itself: a missing route, a proxy, a throttle or a conflict.
const RETRY_STATUSES = [404, 405, 408, 409, 425, 429];
const NOT_CONNECTED_RE = /repository is not connected/i;

// The server's message as one string (validation messages arrive as an array), or null when it sent none.
function messageOf(body) {
  if (body == null || typeof body !== 'object') return null;
  const m = body.message;
  if (typeof m === 'string' && m !== '') return m;
  if (Array.isArray(m)) {
    const parts = m.filter((part) => typeof part === 'string' && part !== '');
    return parts.length > 0 ? parts.join('; ') : null;
  }
  return null;
}

// The server's message, else the bare status.
export function errorText(status, body) {
  const message = messageOf(body);
  return message == null ? `HTTP ${status}` : message;
}

// What one /sessions/report answer means for its queued file; body is the parsed JSON or null.
export function classifyReportResponse(status, body) {
  if (status >= 200 && status < 300) return REPORT_OUTCOME.DELIVERED;
  if (status === 401) return REPORT_OUTCOME.RENEW;
  if (status === 403) return REPORT_OUTCOME.FORBIDDEN;
  if (status === 404 && NOT_CONNECTED_RE.test(errorText(status, body))) return REPORT_OUTCOME.NOT_CONNECTED;
  if (status >= 400 && status < 500 && RETRY_STATUSES.indexOf(status) === -1) return REPORT_OUTCOME.QUARANTINE;
  return REPORT_OUTCOME.RETRY;
}

export const FileAction = Object.freeze({ DELETE: 'delete', REJECT: 'reject', KEEP: 'keep' });

const NO_VERDICT = Object.freeze({
  file: FileAction.KEEP, whenMoved: false, counts: {}, countsIfStuck: {}, lastError: null, issue: false,
  markTenantDark: false, disableTracking: false, disableMessage: null, stopOnRetryAfter: false, refused: false,
});

// What a classified answer does: the file action, the counters (only once the file moved when whenMoved, else
// countsIfStuck on a failure other than a vanished file), lastError, the diagnostic, tenant or account darkening and stops.
// refused = every later post under the same token and tenant gets this answer too (a dead token, a code-less 403).
export function applyResponse(outcome, { status, body, multiTenant }) {
  if (outcome === REPORT_OUTCOME.DELIVERED) return { ...NO_VERDICT, file: FileAction.DELETE, counts: { flushed: 1 } };
  // Still unauthenticated after a renewal attempt — keep the file; the payload was
  // never judged, and re-linking should let it through later.
  if (outcome === REPORT_OUTCOME.RENEW) return { ...NO_VERDICT, counts: { failed: 1 }, lastError: `HTTP ${status}`, refused: true };
  if (outcome === REPORT_OUTCOME.FORBIDDEN) {
    // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
    // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
    // flush if the tenant converts within the window, and expire after it. A code-less 403
    // (seat revoked, deactivated user) is reversible: keep the file, count it failed. With several
    // workspaces only that tenant goes dark: its files are dropped and the account keeps flushing.
    const disabled = body != null && body.code === 'TRACKING_DISABLED';
    const lastError = errorText(status, body);
    if (disabled && multiTenant) return { ...NO_VERDICT, file: FileAction.DELETE, counts: { rejected: 1 }, lastError, markTenantDark: true };
    if (disabled) return { ...NO_VERDICT, lastError, disableTracking: true, disableMessage: messageOf(body) };
    return { ...NO_VERDICT, counts: { failed: 1 }, lastError, refused: true };
  }
  // The server's verdict on non-repo work: dropping it is final by design.
  if (outcome === REPORT_OUTCOME.NOT_CONNECTED) {
    return { ...NO_VERDICT, file: FileAction.DELETE, whenMoved: true, counts: { rejected: 1 }, lastError: errorText(status, body) };
  }
  // <name>.json.rejected: every flusher, older builds included, posts only names ending in .json.
  if (outcome === REPORT_OUTCOME.QUARANTINE) {
    return { ...NO_VERDICT, file: FileAction.REJECT, whenMoved: true, counts: { rejected: 1 }, countsIfStuck: { failed: 1 }, lastError: errorText(status, body), issue: true };
  }
  // Keep for retry; a Retry-After stops the pass so the rest waits for the next flush.
  return { ...NO_VERDICT, counts: { failed: 1 }, issue: true, stopOnRetryAfter: true };
}
