// VS Code chat requests as billable units: settlement, the reported prefix, model borrowing, usage and the per-request payload.
import { clamp, BRANCH_MAX } from '../contract/report-limits.mjs';
import { BillingSource } from '../contract/billing-vocab.mjs';
import { isByokRequest, requestCodeChanges, requestOperations } from './vscode-signals.mjs';

export const VSCODE_USAGE_SOURCE = 'vscode_request';
const CLIENT_SURFACE = 'vscode';
const DEFAULT_ORIGINATOR = 'GitHub.copilot-chat';
const ORIGINATOR_MAX = 100;
const CLI_VERSION_MAX = 50;
const BYOK_BILLING = Object.freeze({ billing_source: BillingSource.UNKNOWN });
// A newest request still open (pending confirmation, or killed mid-turn) is billed provisionally once its file is this quiet.
export const PROVISIONAL_IDLE_MS = 5 * 60 * 1000;

function iso(ms) {
  return typeof ms === 'number' && isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The request's identity in `reported`; the index stands in only when VS Code wrote no requestId.
export function requestKey(r) {
  return r.requestId != null ? r.requestId : `#${r.index}`;
}

// Billable now: finished, and its usage counters final (the closing save, or a quiet file).
export function isSettled(r, idle) {
  return r.completed === true && (r.elapsedMs != null || idle);
}

// True while the newest request is running or its closing save has not landed yet.
export function newestUnsettled(session) {
  const last = session.requests.length > 0 ? session.requests[session.requests.length - 1] : null;
  return last != null && !(last.completed === true && last.elapsedMs != null);
}

// The reported prefix of an audit or an established start: the first k requests in file order, or null when k overshoots.
export function prefixBase(requests, k) {
  if (k > requests.length) return null;
  return { cursor: k, reported: requests.slice(0, k).map(requestKey) };
}

// The stored prefix of a live session; a server prefix past it (a sync landed meanwhile) counts those requests as reported too.
export function resumedBase(requests, state, requested) {
  let base = { cursor: state.cursor, reported: state.reported.slice() };
  if (requested != null && requested > state.cursor) {
    const ahead = prefixBase(requests, requested);
    if (ahead == null) base = null;
    else base = { cursor: requested, reported: base.reported.concat(ahead.reported.filter((k) => base.reported.indexOf(k) === -1)) };
  }
  return base;
}

// A request's own model: the last round's, else model (resolved, then the requested modelId with 'copilot/' stripped and 'auto' dropped).
export function ownModel(r) {
  return r.roundModel || r.model;
}

// Model per request index, borrowing the nearest earlier request's, else the nearest later one's; null when no request has one.
export function sessionModels(requests) {
  const own = requests.map(ownModel);
  const out = new Array(requests.length).fill(null);
  let prev = null;
  for (let i = 0; i < own.length; i++) {
    if (own[i] != null) prev = own[i];
    out[i] = prev;
  }
  let next = null;
  for (let i = own.length - 1; i >= 0; i--) {
    if (own[i] != null) next = own[i];
    if (out[i] == null) out[i] = next;
  }
  return out.length > 0 && out[0] != null ? out : null;
}

// Lower-bound input: each persisted per-call promptTokens summed (a repeat is the closing save), else the last value.
export function inputTokens(r) {
  const last = r.promptTokens == null ? 0 : r.promptTokens;
  if (!Array.isArray(r.promptTokensSeen)) return last;
  let sum = 0;
  let prev = null;
  for (const v of r.promptTokensSeen) {
    if (!Number.isInteger(v) || v < 0 || v === prev) continue;
    sum += v;
    prev = v;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(sum, last));
}

export function modelUsage(r) {
  const input = inputTokens(r);
  const output = r.outputTokens == null ? 0 : r.outputTokens;
  const usage = {
    token_input: input,
    token_output: output,
    token_cache_read: 0,
    token_cache_creation: 0,
    requests: r.calls != null ? r.calls : (input + output > 0 ? 1 : 0),
  };
  // copilotCredits is in AI credits; the report carries nano AIU, a measured 0 included, an unmeasured one absent.
  if (r.credits != null) usage.ai_credits_nano = Math.min(Number.MAX_SAFE_INTEGER, Math.round(r.credits * 1e9));
  // Without credits, the details multiplier is the premium requests this one user request billed, a measured 0 included.
  else if (r.multiplier != null) usage.premium_requests = r.multiplier;
  return usage;
}

// The window: unreported requests in file order up to the first one still running or not yet final.
export function settledWindow(requests, reported, idle) {
  // A request VS Code never closed (a reload mid-turn) is final once a later one completed: chat runs one request at a time.
  const laterCompleted = [];
  let completedAfter = false;
  for (let i = requests.length - 1; i >= 0; i--) {
    laterCompleted[i] = completedAfter;
    if (requests[i].completed === true) completedAfter = true;
  }
  const seen = new Set(reported);
  const window = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    if (seen.has(requestKey(r))) continue;
    if (!isSettled(r, idle) && !laterCompleted[i]) break;
    window.push(r);
  }
  return window;
}

function hasUsage(r) {
  return (r.credits != null && r.credits > 0) || (r.promptTokens != null && r.promptTokens > 0);
}

// The newest request still open with usage on a quiet file, behind a closed one, whose credits or input tokens outgrew
// emitted[requestKey] { credits, input, line }. → [{ request, credits, input }].
export function provisionalRequests(requests, emitted, idleMs) {
  const n = requests.length;
  const last = n > 0 ? requests[n - 1] : null;
  if (last == null || last.completed === true || !(idleMs >= PROVISIONAL_IDLE_MS) || !hasUsage(last)) return [];
  if (n > 1 && requests[n - 2].completed !== true) return [];
  const key = requestKey(last);
  const credits = last.credits == null ? 0 : last.credits;
  const input = inputTokens(last);
  const prior = emitted != null && Object.prototype.hasOwnProperty.call(emitted, key) ? emitted[key] : null;
  return prior != null && credits <= prior.credits && input <= prior.input ? [] : [{ request: last, credits, input }];
}

// True when every request before `index` is reported, so the next line is the one the request settles on.
export function reportedBefore(requests, index, reported) {
  const seen = new Set(reported);
  return requests.slice(0, index).every((r) => seen.has(requestKey(r)));
}

// The base with each provisional line whose request VS Code has since replaced counted as reported: its provisional numbers
// are final, and the request now at that line takes the next one instead of overwriting them.
export function consumeReplaced(base, requests, emitted) {
  const present = new Set(requests.map(requestKey));
  const reported = base.reported.slice();
  let cursor = base.cursor;
  const orphanAt = (line) => Object.keys(emitted).find((k) => emitted[k].line === line && !present.has(k) && reported.indexOf(k) === -1);
  for (let key = orphanAt(cursor); key != null; key = orphanAt(cursor)) {
    reported.push(key);
    cursor += 1;
  }
  return { cursor, reported };
}

// VS Code's elapsedMs is the request's active time (wall time minus confirmation waits); without the closing save, the wall span.
function durationSec(r) {
  const ms = r.elapsedMs != null ? r.elapsedMs : (r.startedAtMs != null && r.completedAtMs != null ? r.completedAtMs - r.startedAtMs : 0);
  return Math.max(0, Math.round(ms / 1000));
}

// One request's report: header holds the run's shared fields, `at` its 0-based line, branch and model; r.raw adds the signals.
export function buildVscodePayload(r, header, at) {
  const usage = modelUsage(r);
  const line = at.line;
  const raw = r.raw != null && typeof r.raw === 'object' ? r.raw : null;
  return {
    segmentId: `${header.sessionId}:vsc:${line + 1}-${line + 1}`,
    sessionId: header.sessionId,
    remote: header.remote,
    branch: clamp(at.branch, BRANCH_MAX),
    from_line: line + 1,
    to_line: line + 1,
    ...(raw != null && isByokRequest(raw) ? BYOK_BILLING : header.billingFields),
    ...header.identity,
    session_name: header.sessionName,
    ...(header.timezone ? { timezone: header.timezone } : {}),
    ...(header.instructions == null ? {} : header.instructions),
    models: { [at.model]: usage },
    token_total: usage.token_input + usage.token_output,
    token_input: usage.token_input,
    token_output: usage.token_output,
    token_cache: 0,
    duration_sec: durationSec(r),
    started_at: iso(r.startedAtMs),
    ended_at: iso(r.completedAtMs != null ? r.completedAtMs : r.startedAtMs),
    ...(usage.ai_credits_nano > 0 ? { ai_credits_nano: usage.ai_credits_nano } : {}),
    ...(raw == null ? {} : { code_changes: requestCodeChanges(raw), operations: requestOperations(raw) }),
    usage_source: VSCODE_USAGE_SOURCE,
    source: CLIENT_SURFACE,
    originator: clamp(r.agentId || DEFAULT_ORIGINATOR, ORIGINATOR_MAX),
    ...(r.extensionVersion == null ? {} : { cli_version: clamp(r.extensionVersion, CLI_VERSION_MAX) }),
  };
}
