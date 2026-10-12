// What one backfill chunk response means: per-session verdicts, the counter it moves, a halt, or a retry shape.
import { BackfillHalt, BackfillSessionStatus } from '../contract/history.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';

// Bisection depth guard: ceil(log2(50)) = 6 splits isolate any single poison session; anything
// deeper is a pathological server, not a payload problem.
export const MAX_BISECT_DEPTH = 8;

// Statuses that say "not now", never "not this payload": the chunk stays pending for a later run. A 409 is a proxy or a
// concurrent upsert, retried like the live queue does.
const RETRYABLE_4XX = [408, 409, 425, 429];

export function isRetryableStatus(status) {
  return status >= 500 || RETRYABLE_4XX.indexOf(status) !== -1;
}

// One split session's verdict from two of its parts: any unjudged part keeps it pending, a mix of judged ones is partial.
export function combinePartStatus(a, b) {
  if (a === b) return a;
  if (a === BackfillSessionStatus.FAILED || b === BackfillSessionStatus.FAILED) return BackfillSessionStatus.FAILED;
  if (a === BackfillSessionStatus.UNATTRIBUTED || b === BackfillSessionStatus.UNATTRIBUTED) return BackfillSessionStatus.UNATTRIBUTED;
  return BackfillSessionStatus.PARTIAL;
}

// A rejected chunk's reason: the body's message, else its non-blank text, else the bare status.
export function rejectionReason(status, message, raw) {
  if (message != null) return message;
  const excerpt = raw.slice(0, 200);
  return excerpt.trim() === '' ? `HTTP ${status}` : excerpt;
}

// A session's { status, reason } after one more verdict; a split session folds part by part and the reason follows the part that decided the status.
export function foldSessionVerdict(existing, status, reason) {
  const own = reason == null ? null : reason;
  if (existing == null) return { status, reason: own };
  const combined = combinePartStatus(existing.status, status);
  const decidedByThisPart = combined === status && combined !== existing.status;
  const preferred = decidedByThisPart ? own : existing.reason;
  const fallback = decidedByThisPart ? existing.reason : own;
  return { status: combined, reason: preferred == null ? fallback : preferred };
}

// A judged 2xx body's totals and per-session verdicts: a session is accepted unless errors[] names it; the server's
// `skipped` already includes the errored items, so the counters are not disjoint.
export function judgeAcceptedChunk(chunk, body) {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const errorsBySession = new Map();
  for (const entry of errors) {
    if (entry == null || !entry.sessionId) continue;
    const existing = errorsBySession.get(entry.sessionId);
    errorsBySession.set(entry.sessionId, [...(existing == null ? [] : existing), entry]);
  }
  const sentBySession = new Map();
  for (const report of chunk.reports) {
    const count = sentBySession.get(report.sessionId);
    sentBySession.set(report.sessionId, (count == null ? 0 : count) + 1);
  }
  const sessions = [];
  for (const sessionId of new Set(chunk.sessionIds)) {
    const sessionErrorList = errorsBySession.get(sessionId);
    const failedSegments = sessionErrorList == null ? 0 : sessionErrorList.length;
    const sentCount = sentBySession.get(sessionId);
    const sent = sentCount == null ? 0 : sentCount;
    const firstError = sessionErrorList == null ? undefined : sessionErrorList[0];
    const reason = firstError == null || firstError.reason == null ? null : firstError.reason;
    if (failedSegments === 0) sessions.push({ sessionId, status: BackfillSessionStatus.ACCEPTED, reason: null });
    else if (failedSegments >= sent) sessions.push({ sessionId, status: BackfillSessionStatus.REJECTED, reason });
    else sessions.push({ sessionId, status: BackfillSessionStatus.PARTIAL, reason });
  }
  return {
    stored: body.stored == null ? 0 : body.stored,
    skipped: body.skipped == null ? 0 : body.skipped,
    timelines: body.timelines == null ? 0 : body.timelines,
    itemErrors: errors.length,
    sessions,
  };
}

// The chunk's halves at the session boundary nearest the midpoint, each with its own reports and timelines.
export function bisectChunk(chunk) {
  const ids = [...new Set(chunk.sessionIds)];
  const splitIds = new Set(ids.slice(0, Math.ceil(ids.length / 2)));
  const first = { reports: [], sessionIds: [], timelines: [] };
  const second = { reports: [], sessionIds: [], timelines: [] };
  for (const report of chunk.reports) {
    (splitIds.has(report.sessionId) ? first : second).reports.push(report);
  }
  for (const timeline of (chunk.timelines == null ? [] : chunk.timelines)) {
    (splitIds.has(timeline.sessionId) ? first : second).timelines.push(timeline);
  }
  first.sessionIds = chunk.sessionIds.filter((id) => splitIds.has(id));
  second.sessionIds = chunk.sessionIds.filter((id) => !splitIds.has(id));
  return [first, second];
}

// A verdict that marks every session of the chunk, moves one counter and either continues or halts the run.
function verdict(status, reason, counter, lastError, { halt = null, goOn = true } = {}) {
  return { mark: status == null ? null : { status, reason }, counter, halt, lastError, goOn };
}

// A thrown POST, after its in-run retry: never judged, so retryable.
export function transportFailure(kind) {
  return verdict(BackfillSessionStatus.FAILED, kind, 'retryableFailures', kind);
}

// A credential pinned to another API origin was never sent: every chunk would be refused the same way, and only a
// new login clears it, so the run halts with the sessions pending.
export function reauthFailure() {
  const reason = AUTH_STATES.REAUTH_REQUIRED;
  return verdict(BackfillSessionStatus.FAILED, reason, 'retryableFailures', reason, { halt: BackfillHalt.FORBIDDEN, goOn: false });
}

// → a verdict { mark, counter, halt, lastError, goOn } (plus `accepted` for a judged 2xx), or { retry } / { split } for a reshaped resend.
// `response` is the body read once: { code, message, raw, body }.
export function interpretChunkResponse(status, response, chunk, depth) {
  const { code, message, raw, body } = response;
  const httpStatus = `HTTP ${status}`;
  const said = message == null ? httpStatus : message;

  if (status >= 200 && status < 300) {
    // The server accepted the chunk but we cannot attribute it — never ledger an outcome
    // we did not receive, and never seal on top of one.
    if (!body || !Array.isArray(body.errors)) {
      return verdict(BackfillSessionStatus.UNATTRIBUTED, 'unreadable-response', 'unattributed', 'unreadable-response');
    }
    return { mark: null, counter: null, halt: null, lastError: null, goOn: true, accepted: judgeAcceptedChunk(chunk, body) };
  }
  // Still unauthenticated after a renewal attempt — never judged, so retryable; every later chunk would get the same answer,
  // so the run halts instead of posting them all.
  if (status === 401) return verdict(BackfillSessionStatus.FAILED, httpStatus, 'retryableFailures', httpStatus, { halt: BackfillHalt.FORBIDDEN, goOn: false });
  if (status === 403) return forbiddenVerdict(code, said);
  if (status === 404 || status === 405) {
    // Old server without the backfill routes — nothing may be ledgered off this run.
    return verdict(BackfillSessionStatus.FAILED, httpStatus, 'retryableFailures', httpStatus, { halt: BackfillHalt.UNSUPPORTED_SERVER, goOn: false });
  }
  if (status === 400 && chunk.timelines != null && chunk.timelines.length && raw.includes('timelines')) {
    // A server predating the in-band timelines 400s the whole chunk on the unknown field
    // (forbidNonWhitelisted). Retry once without them — losing timelines beats losing the
    // usage, and the next login (post-deploy) delivers nothing new only because the ledger
    // already sealed these sessions; acceptable for a deploy-order violation.
    return { retry: { ...chunk, timelines: [] } };
  }
  if (status === 400 && new Set(chunk.sessionIds).size > 1 && depth < MAX_BISECT_DEPTH) {
    // Whole-chunk validation failure: one malformed field anywhere 400s all 50 sessions; isolate the poison session
    // instead of losing (or endlessly resending) the innocent ones.
    return { split: bisectChunk(chunk) };
  }
  // 5xx (after its in-run retry), 408, 409, 425 and 429: never a verdict on the payload.
  if (isRetryableStatus(status)) return verdict(BackfillSessionStatus.FAILED, httpStatus, 'retryableFailures', httpStatus);
  // 400 single-session floor, 413, and the rest of the permanent 4xx family.
  return verdict(BackfillSessionStatus.REJECTED, rejectionReason(status, message, raw), 'permanentRejections', said);
}

// Only the coded 403s are actionable; a code-less 403 (seat revoked, deactivated user) must never read as "the pull is
// done" or "tracking is off".
function forbiddenVerdict(code, said) {
  if (code === 'BACKFILL_ALREADY_COMPLETED') return verdict(null, null, null, said, { halt: BackfillHalt.ALREADY_COMPLETED, goOn: false });
  // TRACKING_DISABLED should be unreachable here (the backfill routes are ungated); defensively treat it as not-allowed.
  if (code === 'BACKFILL_NOT_ALLOWED' || code === 'TRACKING_DISABLED') return verdict(null, null, null, said, { halt: BackfillHalt.NOT_ALLOWED, goOn: false });
  return verdict(BackfillSessionStatus.FAILED, said, 'retryableFailures', said, { halt: BackfillHalt.FORBIDDEN, goOn: false });
}
