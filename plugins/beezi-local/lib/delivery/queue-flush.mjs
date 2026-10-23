// Drains account report queues to /sessions/report: entry triage, posts with one token renewal, per-answer verdicts.
import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from '../auth/token.mjs';
import { queueDir } from '../config/paths.mjs';
import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { isOriginMismatch, postJson } from '../platform/http.mjs';
import { retryAfterMs } from '../telemetry/transport.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { readJsonSalvaged } from '../platform/fs-store.mjs';
import { isLiveTrackingAllowed, isTenantDark, markTenantDark, markTrackingDisabled, matchesIdentity, readTrackingState } from '../state/tracking.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { tenantsOf, isMultiTenant } from '../workspace/tenants.mjs';
import { unwrapQueueFile, releaseHeldFile, sortQueueFiles, sweepHeldQueue, waitOrExpire, REJECTED_SUFFIX } from './queue-files.mjs';
import { FlushSkip, countPostable, noteError, noteRefusal, noteRetry, noteSettled, noteTransport, runGuarded } from './flush-guard.mjs';
import { coverageLookup, coveredWindow } from './rejected-reposts.mjs';
import { FileAction, REPORT_OUTCOME, applyResponse, classifyReportResponse, errorText } from './report-verdicts.mjs';
import { reportForWire } from '../core/anon-target.mjs';

// The lastError of a pass skipped because another process holds the account's flush lock.
export const FLUSH_BUSY_ERROR = 'another Beezi process is delivering them';

function emptyFlushResult() {
  return { flushed: 0, rejected: 0, failed: 0, expired: 0, salvaged: 0, quarantined: 0, workspacePending: 0, deferred: 0, trackingDisabled: false, lastError: null };
}

// Drains each planned account's queue inside the deadline; returns the accepted count, pushing 'flush-failed' into errors.
export async function flushPlans(plans, { fetchImpl, deadline = null, getAccessToken, errors }) {
  let flushed = 0;
  for (const p of plans) {
    if (!p.session.token) continue;
    if (deadline != null && Date.now() >= deadline) break;
    try {
      flushed += (await flushQueue(p.session, { fetchImpl, deadline, now: Date.now, getAccessToken })).flushed;
    } catch { errors.push('flush-failed'); }
  }
  return flushed;
}

const REPORT_POST_TIMEOUT_MS = 3000;

// A post's timeout under the flush deadline: its own cap or what is left of the deadline; null once none is left.
export function postTimeoutMs(deadline, nowMs) {
  if (deadline == null) return REPORT_POST_TIMEOUT_MS;
  const left = deadline - nowMs;
  return left > 0 ? Math.min(REPORT_POST_TIMEOUT_MS, left) : null;
}

export const QueueEntryAction = Object.freeze({ QUARANTINE: 'quarantine', RELEASE: 'release', WAIT: 'wait', DROP_DARK: 'drop-dark', POST: 'post' });

// What the flush does with one unwrapped queue file; facts: { multiTenant, tenants (null = unknown), isDark(tenantId) }.
// → { action } or { action: POST, tenantId } (the header to post under; one or unknown workspaces post headerless).
export function classifyQueueEntry(entry, salvaged, facts) {
  const payload = entry.payload;
  // Nothing recoverable, or what came back is not a postable payload: a cleanly parsed one is posted, the server judges it.
  if (payload == null || (salvaged && payload.segmentId == null)) return { action: QueueEntryAction.QUARANTINE };
  // A held or unstamped file is expanded into per-tenant copies, which this same pass posts.
  if (facts.multiTenant && (entry.hold != null || entry.tenantId == null)) return { action: QueueEntryAction.RELEASE };
  // A held file on a now single-workspace account waits out the hold window.
  if (entry.hold != null) return { action: QueueEntryAction.WAIT };
  // A stamp for a workspace the account has left is held for it, never re-routed; old servers send no header.
  if (entry.tenantId != null && facts.tenants != null && !facts.tenants.some((t) => t.id === entry.tenantId)) return { action: QueueEntryAction.WAIT };
  const tenantId = facts.multiTenant ? entry.tenantId : null;
  // A dark tenant's reports are dropped, not retried.
  if (facts.multiTenant && facts.isDark(tenantId)) return { action: QueueEntryAction.DROP_DARK };
  return { action: QueueEntryAction.POST, tenantId };
}

// Posts one payload; a 401 renews the flush's token once and posts again. null = the deadline is spent. Throws on transport failure.
export async function postWithRenew(send, auth, tenantId, payload) {
  let res = await send({ ...auth.current(), tenantId }, payload);
  // 401 only: a 403 is authenticated-but-not-permitted, which no new token resolves.
  if (res != null && res.status === 401) {
    const next = await auth.renew();
    const again = next == null ? null : await send({ ...next, tenantId }, payload);
    if (again != null) res = again;
  }
  return res;
}

// A 401 is authentication, not a verdict on the payload, so it must not count as a permanent
// rejection — that would delete queued analytics that were never actually refused. Renew once
// for the whole flush and retry; if renewal fails, keep every file for the next attempt.
function createRenewal(session, getAccessToken, deadline, now) {
  let current = session;
  let renewed = false;
  const renew = async () => {
    if (renewed) return null;
    if (deadline != null && now() >= deadline) return null;
    renewed = true;
    const next = await getAccessToken({}, { account: session.key, forceRefresh: true }).catch(() => null);
    if (next && next !== current.token) { current = { ...current, token: next }; return current; }
    return null;
  };
  return { current: () => current, renew };
}

async function readBody(res) {
  try { return await res.json(); } catch { return null; }
}

function retryAfterOf(res) {
  const header = res.headers == null || typeof res.headers.get !== 'function' ? null : res.headers.get('retry-after');
  return retryAfterMs(header);
}

const MOVE = Object.freeze({ DONE: 'done', GONE: 'gone', STUCK: 'stuck' });

// A re-posted .json.rejected file that is refused again simply stays where it is.
function moveFile(filePath, action) {
  try {
    if (action === FileAction.DELETE) fs.unlinkSync(filePath);
    else if (action === FileAction.REJECT && !filePath.endsWith(REJECTED_SUFFIX)) fs.renameSync(filePath, `${filePath}${REJECTED_SUFFIX}`);
    else if (action === FileAction.REJECT) fs.statSync(filePath);
    return MOVE.DONE;
  } catch (error) {
    return error != null && error.code === 'ENOENT' ? MOVE.GONE : MOVE.STUCK;
  }
}

function dropFile(filePath, result) {
  try { fs.unlinkSync(filePath); result.rejected += 1; } catch { /* best-effort */ }
}

function addCounts(result, counts) {
  for (const c of Object.keys(counts)) result[c] += counts[c];
}

// Applies one answer's verdict to the account, the file and the counters; true stops the pass.
function settle(run, index, filePath, verdict, tenantId, res) {
  const { result, session } = run;
  if (verdict.markTenantDark) {
    try { markTenantDark(session.key, tenantId); } catch { /* best-effort */ }
    run.darkThisFlush.add(tenantId);
  }
  if (verdict.disableTracking) {
    try { markTrackingDisabled(session.key, verdict.disableMessage); } catch { /* best-effort */ }
  }
  const moved = moveFile(filePath, verdict.file);
  if (verdict.file === FileAction.REJECT && moved === MOVE.DONE) run.pass.reposts.handled(path.basename(filePath));
  if (verdict.whenMoved && moved !== MOVE.DONE) {
    if (moved === MOVE.STUCK) addCounts(result, verdict.countsIfStuck);
    return false;
  }
  addCounts(result, verdict.counts);
  if (verdict.lastError != null) result.lastError = verdict.lastError;
  if (verdict.issue) recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR, source: DIAGNOSTIC_SOURCES.CHECKPOINT, httpStatus: res.status });
  if (verdict.disableTracking) {
    result.trackingDisabled = true;
    sweepHeldQueue(run.dir, result);
    return true;
  }
  const retryAfter = verdict.stopOnRetryAfter ? retryAfterOf(res) : null;
  if (retryAfter != null) {
    run.pass.retryAfterMs = retryAfter;
    result.deferred += run.files.length - index - 1;
    return true;
  }
  return false;
}

// Tallies one answer for the account's health; true when it is the second retry in a row, which stops the pass.
function tallyAnswer(pass, outcome, verdict, status, body) {
  if (outcome === REPORT_OUTCOME.RETRY) return noteRetry(pass, errorText(status, body), status);
  noteSettled(pass);
  if (outcome !== REPORT_OUTCOME.DELIVERED) noteError(pass, verdict.lastError == null ? errorText(status, body) : verdict.lastError, status);
  if (verdict.refused) noteRefusal(pass);
  return false;
}

// Posts one queued payload's wire body and settles the answer; true stops the pass (deadline, transport failure, a stop verdict).
// A private payload with no key to anonymize it is dropped unsent.
async function postFile(run, index, filePath, payload, tenantId) {
  const { result } = run;
  const wire = reportForWire(payload, run.session, tenantId);
  if (wire == null) {
    dropFile(filePath, result);
    return false;
  }
  let res;
  try {
    res = await postWithRenew(run.send, run.auth, tenantId, wire);
  } catch (error) {
    // Transport failure (network, timeout): keep the file and stop; the rest waits for the next flush. A credential pinned
    // to another API origin is an auth state only a new login clears: no backoff, and status says so.
    result.failed += 1;
    result.deferred += run.files.length - index - 1;
    if (isOriginMismatch(error)) {
      result.lastError = AUTH_STATES.REAUTH_REQUIRED;
      noteError(run.pass, AUTH_STATES.REAUTH_REQUIRED, null);
    } else noteTransport(run.pass, error != null && error.name === 'AbortError' ? 'timeout' : 'network');
    return true;
  }
  if (res == null) {
    result.deferred += run.files.length - index;
    return true;
  }
  const delivered = res.status >= 200 && res.status < 300;
  const body = delivered ? null : await readBody(res);
  const outcome = classifyReportResponse(res.status, body);
  const verdict = applyResponse(outcome, { status: res.status, body, multiTenant: run.facts.multiTenant });
  const outage = tallyAnswer(run.pass, outcome, verdict, res.status, body);
  if (settle(run, index, filePath, verdict, tenantId, res)) return true;
  // A refused workspace of several waits for the next flush while the others go on; otherwise the pass stops.
  if (verdict.refused && outcome === REPORT_OUTCOME.FORBIDDEN && run.facts.multiTenant) {
    run.refusedTenants.add(tenantId);
    return false;
  }
  if (!outage && !verdict.refused) return false;
  result.deferred += run.files.length - index - 1;
  return true;
}

// Expands a held file into per-tenant copies and splices them into the unvisited, re-sorted tail of this pass.
function releaseInto(run, index, filePath, payload) {
  const { result } = run;
  let released;
  // A corrupt held file must not break the whole flush.
  try { released = releaseHeldFile(filePath, run.session, run.workspaceOf(payload.sessionId)); } catch { result.failed += 1; return; }
  // Re-sorts the unvisited tail with the copies so a narrower window still posts before a wider one.
  if (released.written.length > 0) {
    const tail = run.files.slice(index + 1);
    const added = released.written.filter((name) => tail.indexOf(name) === -1);
    run.files = run.files.slice(0, index + 1).concat(sortQueueFiles(tail.concat(added)));
  }
  if (released.expired) result.expired += 1;
  else if (!released.deleted) result.workspacePending += 1;
}

// One queue file through triage and, when postable, the post; true stops the pass.
async function flushFile(run, index) {
  const { result } = run;
  const file = run.files[index];
  // Only queued payloads, plus `.json.rejected` ones on the pass that re-posts them after a plugin update. Skips the `.tmp`
  // of a writer that died mid-write and the `.corrupt` files quarantined below; pruneStale expires them.
  const rejected = run.pass.reposts.due(file);
  if (!file.endsWith('.json') && !rejected) return false;
  const filePath = path.join(run.dir, file);
  const { value, salvaged } = readJsonSalvaged(filePath);
  // Another flusher already delivered or moved it.
  if (value == null && !fs.existsSync(filePath)) return false;
  const entry = unwrapQueueFile(value);
  const triage = classifyQueueEntry(entry, salvaged, run.facts);
  if (rejected && !repostable(run, file, filePath, entry.payload, triage)) return false;
  // Quarantine rather than skip: an unparseable file used to be re-read on every flush forever, invisibly,
  // and the session's analytics were lost without a signal.
  if (triage.action === QueueEntryAction.QUARANTINE) {
    result.quarantined += 1;
    recordIssue({ code: DIAGNOSTIC_CODES.QUEUE_FILE_QUARANTINED, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
    try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
    return false;
  }
  if (salvaged) result.salvaged += 1;
  if (triage.action === QueueEntryAction.RELEASE) releaseInto(run, index, filePath, entry.payload);
  else if (triage.action === QueueEntryAction.WAIT) waitOrExpire(filePath, result);
  else if (triage.action === QueueEntryAction.DROP_DARK) dropFile(filePath, result);
  else if (run.refusedTenants.has(triage.tenantId)) result.deferred += 1;
  else return postFile(run, index, filePath, entry.payload, triage.tenantId);
  return false;
}

// A re-post is a plain post or nothing (holds, releases and drops stay with the live queue), and never of a window whose
// lines a sync or a wider replay already delivered: that one is deleted.
function repostable(run, file, filePath, payload, triage) {
  if (triage.action !== QueueEntryAction.POST) {
    run.pass.reposts.handled(file);
    return false;
  }
  if (!coveredWindow(payload, run.coverageLine(triage.tenantId, payload.sessionId))) return true;
  try { fs.unlinkSync(filePath); } catch { /* another flusher took it */ }
  return false;
}

// Returns { flushed, rejected, failed, expired, salvaged, quarantined, workspacePending, deferred, trackingDisabled, lastError } —
// flushed = accepted (2xx), rejected = declined by the server (a not-connected 404 or a dark tenant drops the file;
// any other refusing 4xx renames it to <name>.json.rejected), failed = kept for retry (5xx, throttles, a missing route,
// network, auth), expired = held files past the 3-day window, workspacePending = held until a rule or New folders
// picks a workspace, deferred = files left untouched because deps.deadline passed, a transport failure, Retry-After, a
// second retry answer in a row or a refusal (a dead token, a code-less 403: that workspace only on a several-workspace
// account) stopped the pass, or the pass was skipped (the account is backing off, which deps.ignoreBackoff overrides, or
// another process holds its flush lock: lastError FLUSH_BUSY_ERROR), trackingDisabled = the server said the workspace is
// dark (audit mode) and the flush stopped. lastError is a string or null ('reauth_required' when the credential is pinned
// to another API origin). A file another flusher already took is neither counted nor reported. Every pass updates the
// account's health record (state/health-record.mjs).
export async function flushQueue(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : null;
  const now = deps.now == null ? Date.now : deps.now;
  const result = emptyFlushResult();
  const dir = queueDir(session.key);
  const tenants = tenantsOf(session);
  const multiTenant = isMultiTenant(session);
  const workspaceCache = new Map();
  const workspaceOf = (sessionId) => {
    if (!workspaceCache.has(sessionId)) {
      let state = null;
      try { state = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
      workspaceCache.set(sessionId, state);
    }
    return workspaceCache.get(sessionId);
  };

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for QUEUE_HOLD_MS in case the tenant
  // converts to paid, then expire. A cache another login recorded is not this one's verdict. Several workspaces go dark per tenant below.
  const trackingState = readTrackingState(session.key);
  const darkThisFlush = new Set();
  if (!multiTenant && matchesIdentity(trackingState, session.clientId == null ? null : session.clientId) && !isLiveTrackingAllowed(trackingState)) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result);
    return result;
  }

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;
  // Each request is capped by what is left of the deadline; null = the deadline is spent and nothing is sent.
  const send = (auth, payload) => {
    const timeoutMs = postTimeoutMs(deadline, now());
    return timeoutMs == null ? Promise.resolve(null) : postJson(reportUrl, auth, payload, { fetchImpl, timeoutMs });
  };
  const isDark = (tenantId) => darkThisFlush.has(tenantId) || isTenantDark(trackingState, tenantId);
  const run = { session, result, dir, files: null, facts: { multiTenant, tenants, isDark }, send, workspaceOf, darkThisFlush, deadline, now };
  run.auth = createRenewal(session, getAccessToken, deadline, now);
  run.refusedTenants = new Set();
  run.coverageLine = coverageLookup(session);
  const skipped = await runGuarded(session.key, { now, ignoreBackoff: deps.ignoreBackoff === true, sleep: deps.sleep }, (pass) => drainQueue(run, pass));
  // Backing off, or another process is draining this account: everything waits for a later flush.
  if (skipped != null) result.deferred = countPostable(dir);
  if (skipped === FlushSkip.BUSY) result.lastError = FLUSH_BUSY_ERROR;
  return result;
}

// One pass over the sorted queue; returns at the first stop.
async function drainQueue(run, pass) {
  const { result, deadline, now } = run;
  run.pass = pass;
  try {
    run.files = sortQueueFiles(fs.readdirSync(run.dir));
  } catch {
    return result;
  }
  // Indexed rather than for..of: a released held file adds its per-tenant copies to this same pass.
  for (let index = 0; index < run.files.length; index++) {
    // Budget spent: leave the rest untouched for the next flush.
    if (deadline != null && now() >= deadline) {
      result.deferred += run.files.length - index;
      return result;
    }
    // A holder broken while asleep stops here instead of draining beside its successor.
    if (!pass.heartbeat()) {
      result.deferred += run.files.length - index;
      return result;
    }
    if (await flushFile(run, index)) return result;
  }
  return result;
}
