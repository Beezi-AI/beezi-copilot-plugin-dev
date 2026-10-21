// POSTs planned backfill chunks with token renewal, gzip with a plain fallback, one in-run retry and halts, and seals the pull.
import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { isOriginMismatch, postJson } from '../platform/http.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { getAccessToken as _getAccessToken } from '../auth/token.mjs';
import { sleep as _sleep } from '../core/async.mjs';
import { BackfillSessionStatus } from '../contract/history.mjs';
import { planChunks, countSplitParts } from './chunk-planner.mjs';
import { gzipJson } from '../platform/gzip-body.mjs';
import { foldSessionVerdict, interpretChunkResponse, isCodedForbidden, reauthFailure, transportFailure } from './chunk-verdicts.mjs';

// postJson's 3s default exists to protect the 10s hook budget. The audit is a foreground command
// and the server ingests a chunk's reports sequentially, which is seconds to tens of seconds.
const DEFAULT_BACKFILL_TIMEOUT_MS = 60_000;

// One in-run retry for transport-level failures (stale keep-alive socket, momentary server or
// DB blip): the chunk is idempotent server-side, and the fresh dial escapes a dead pooled
// connection. A second failure defers the sessions to the next login.
const RETRY_BACKOFF_MS = 500;

// Read a response body ONCE as text, then opportunistically as JSON. Never throws. The Nest
// error filter only covers requests that reach the router — an over-limit or malformed body is
// answered by Express itself with an HTML page, so `code`/`message` are null there and `raw`
// carries a capped excerpt for the summary line.
export async function readResponseBody(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    return { code: null, message: null, raw: '' };
  }
  try {
    const body = JSON.parse(raw);
    const bodyMessage = body == null ? undefined : body.message;
    const message = Array.isArray(bodyMessage) ? bodyMessage[0] : (bodyMessage == null ? null : bodyMessage);
    return { code: body == null || body.code == null ? null : body.code, message, raw: raw.slice(0, 2000), body };
  } catch {
    return { code: null, message: null, raw: raw.slice(0, 2000) };
  }
}

function newFlushResult() {
  return {
    chunks: 0,
    stored: 0,
    skipped: 0,
    timelines: 0,
    // Timelines this run deliberately abandoned to save the usage they rode with. Counted so the
    // summary can say the sessions landed but their timelines did not, instead of leaving an
    // unexplained gap between offered and attached.
    timelinesDropped: 0,
    itemErrors: 0,
    retryableFailures: 0,
    permanentRejections: 0,
    unattributed: 0,
    bySession: new Map(),
    halt: null,
    lastError: null,
  };
}

// POST the planned chunks and derive per-session verdicts from the real backfill contract:
// 2xx bodies carry chunk totals plus errors[{sessionId, segmentId, reason}] — a session is
// accepted unless it appears there.
//
// sessionGroups: [{ sessionId, reports: payload[], timeline? }] — order preserved.
// Returns { chunks, stored, skipped, timelines, timelinesDropped, itemErrors, retryableFailures,
//           permanentRejections, unattributed, bySession: Map, halt, lastError }.
export async function flushBackfillChunks(sessionGroups, session, deps = {}, options = {}) {
  const result = newFlushResult();
  const chunks = planChunks(sessionGroups, options);
  if (chunks.length === 0) return result;
  const flush = createFlush(result, session, deps, options);
  const onChunk = deps.onChunk == null ? (() => {}) : deps.onChunk;

  // Parts of each split session not yet judged by a run that went on past them.
  const partsLeft = countSplitParts(chunks);
  for (const chunk of chunks) {
    result.chunks += 1;
    const goOn = await sendChunk(flush, chunk);
    onChunk({ ...result, sent: result.chunks, total: chunks.length });
    if (!goOn) break;
    if (chunk.partialOf != null) partsLeft.set(chunk.partialOf, partsLeft.get(chunk.partialOf) - 1);
  }

  // A halt before every part was judged keeps the split session pending, so its accepted parts never ledger it whole.
  for (const [sessionId, left] of partsLeft) {
    if (left > 0 && result.bySession.has(sessionId)) setSession(result, sessionId, BackfillSessionStatus.FAILED, result.lastError);
  }
  return result;
}

// The flush's transport state: resolved seams, the target URL and the current (possibly renewed) session.
function createFlush(result, session, deps, options) {
  // /beezi-staging-sync posts the identical wire shape to a repeatable route that never seals the pull.
  const endpointPath = options.endpoint == null ? ENDPOINTS.sessionsBackfill : options.endpoint;
  return {
    result,
    session,
    renewed: false,
    renewSession: deps.renewSession == null ? null : deps.renewSession,
    // Shared with the run's other flushes: a chunk goes out gzipped only while it is enabled.
    compression: deps.compression == null ? null : deps.compression,
    // Set before each attempt; true sends plain JSON whatever the shared flag says.
    sendPlain: false,
    // Whether the latest post went out gzipped; one flush posts strictly one request at a time.
    lastPostCompressed: false,
    url: `${apiBase()}${endpointPath}`,
    postJsonImpl: deps.postJsonImpl == null ? postJson : deps.postJsonImpl,
    getAccessToken: deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken,
    fetchImpl: deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl,
    sleep: deps.sleep == null ? _sleep : deps.sleep,
    timeoutMs: options.timeoutMs == null ? DEFAULT_BACKFILL_TIMEOUT_MS : options.timeoutMs,
  };
}

// A 401 is authentication, not a verdict on the payload. Renew once for the whole flush and retry;
// if renewal fails, the remaining chunks count as failed and stay eligible for a re-run.
async function renewToken(flush) {
  if (flush.renewSession != null) return renewThroughRun(flush);
  if (flush.renewed) return null;
  flush.renewed = true;
  const next = await flush.getAccessToken({}, { account: flush.session.key, forceRefresh: true }).catch(() => null);
  if (next && next !== flush.session.token) { flush.session = { ...flush.session, token: next }; return flush.session; }
  return null;
}

// The run's shared single-flight renewal bounds refreshes itself, so no per-flush guard applies.
async function renewThroughRun(flush) {
  const next = await flush.renewSession(flush.session).catch(() => null);
  if (next == null || next.token === flush.session.token) return null;
  flush.session = next;
  return next;
}

// `timelines` is omitted when empty so a chunk without them stays byte-identical to the wire
// shape that predates it.
function post(flush, chunk) {
  const body = { sessions: chunk.reports };
  if (chunk.timelines != null && chunk.timelines.length) body.timelines = chunk.timelines;
  flush.lastPostCompressed = !flush.sendPlain && flush.compression != null && flush.compression.enabled === true;
  const postDeps = { fetchImpl: flush.fetchImpl, timeoutMs: flush.timeoutMs };
  if (flush.lastPostCompressed) postDeps.gzip = gzipJson;
  return flush.postJsonImpl(flush.url, flush.session, body, postDeps);
}

// `state.renewedHere` caps a chunk at one run renewal across both attempts of postWithRetry.
async function postRenewing(flush, chunk, state) {
  let attempt = await post(flush, chunk);
  if (attempt.status === 401 && !state.renewedHere) {
    const next = await renewToken(flush);
    if (next) {
      state.renewedHere = flush.renewSession != null;
      attempt = await post(flush, chunk);
    }
  }
  return attempt;
}

// A gzipped attempt that failed in transit or drew a 5xx is retried plain, standing in for gzip.
function fallBackIfCompressed(flush, state) {
  if (!flush.lastPostCompressed) return;
  state.plain = true;
  state.fellBack = true;
}

// A thrown fetch or a 5xx gets ONE immediate in-run retry after a short backoff → { res } or { transportError }, or
// { originMismatch } at once for a credential pinned to another API origin, which no retry changes.
async function postWithRetry(flush, chunk, state) {
  let res;
  let transportError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    transportError = null;
    flush.sendPlain = state.plain;
    try {
      res = await postRenewing(flush, chunk, state);
    } catch (error) {
      if (isOriginMismatch(error)) return { originMismatch: true };
      fallBackIfCompressed(flush, state);
      // A timeout and a socket reset need different follow-up (a 60s stall points at the
      // server, a reset at the connection) — keep them apart in the ledger and summary.
      transportError = error != null && error.name === 'AbortError' ? 'timeout' : 'network';
      if (attempt === 0) await flush.sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (res.status >= 500 && attempt === 0) {
      fallBackIfCompressed(flush, state);
      // Drain the body so the pooled socket is clean before the retry.
      try { await res.text(); } catch { /* best-effort */ }
      await flush.sleep(RETRY_BACKOFF_MS);
      continue;
    }
    break;
  }
  return { res, transportError };
}

// One chunk, one verdict (true goes on, false halts); `plain` covers its retries, resends and splits, `fellBack` marks a gzip stand-in.
async function sendChunk(flush, chunk, depth = 0, plain = false, fellBack = false) {
  const state = { plain, fellBack, renewedHere: false };
  const { res, transportError, originMismatch } = await postWithRetry(flush, chunk, state);
  if (originMismatch) return applyVerdict(flush.result, chunk, reauthFailure());
  if (transportError) return applyVerdict(flush.result, chunk, transportFailure(transportError));
  const response = await readResponseBody(res);
  if (refusedGzip(flush, res.status, response.code)) return sendChunk(flush, chunk, depth, true, true);
  // A plain request standing in for a refused or failed gzip one landed: plain JSON for the rest of the run.
  if (state.fellBack && res.status >= 200 && res.status < 300) flush.compression.enabled = false;
  const verdict = interpretChunkResponse(res.status, response, chunk, depth);
  if (verdict.retry) {
    flush.result.timelinesDropped += chunk.timelines.length;
    return sendChunk(flush, verdict.retry, depth, state.plain);
  }
  if (verdict.split) {
    const goOn = await sendChunk(flush, verdict.split[0], depth + 1, state.plain);
    if (!goOn) return false;
    return sendChunk(flush, verdict.split[1], depth + 1, state.plain);
  }
  return applyVerdict(flush.result, chunk, verdict);
}

// Any 4xx to a gzip body but a 401, a 429 or an API-coded 403 may be a proxy's doing: the chunk is resent plain once.
function refusedGzip(flush, status, code) {
  if (!flush.lastPostCompressed || status < 400 || status >= 500 || status === 401 || status === 429) return false;
  return !(status === 403 && isCodedForbidden(code));
}

function applyVerdict(result, chunk, verdict) {
  if (verdict.mark != null) {
    for (const sessionId of chunk.sessionIds) setSession(result, sessionId, verdict.mark.status, verdict.mark.reason);
  }
  if (verdict.accepted != null) mergeAccepted(result, verdict.accepted);
  if (verdict.counter != null) result[verdict.counter] += 1;
  if (verdict.halt != null) result.halt = verdict.halt;
  if (verdict.lastError != null) result.lastError = verdict.lastError;
  return verdict.goOn;
}

function mergeAccepted(result, accepted) {
  result.stored += accepted.stored;
  result.skipped += accepted.skipped;
  result.timelines += accepted.timelines;
  result.itemErrors += accepted.itemErrors;
  for (const s of accepted.sessions) setSession(result, s.sessionId, s.status, s.reason);
}

function setSession(result, sessionId, status, reason) {
  result.bySession.set(sessionId, foldSessionVerdict(result.bySession.get(sessionId), status, reason));
}

// Seal this user's pull for the calling tool. Idempotent server-side (snapshot_taken_at is
// COALESCEd), so retrying a lost response is safe.
export async function completeBackfill(session, deps = {}, options = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_BACKFILL_TIMEOUT_MS : options.timeoutMs;
  const url = `${apiBase()}${ENDPOINTS.sessionsBackfillComplete}`;
  try {
    const res = await postJsonImpl(url, session, {}, { fetchImpl, timeoutMs });
    if (res.status >= 200 && res.status < 300) return { completed: true, code: null };
    const { code, message } = await readResponseBody(res);
    return { completed: false, code, reason: message == null ? `HTTP ${res.status}` : message };
  } catch {
    return { completed: false, code: null, reason: 'network' };
  }
}
