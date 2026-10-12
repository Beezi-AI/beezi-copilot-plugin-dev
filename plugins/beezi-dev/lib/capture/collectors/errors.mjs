import { hookTimeIso } from '../../core/hook-time.mjs';
import { dataOf } from '../../sources/cli/event-types.mjs';
import { tsMs } from './operations.mjs';
import { redactText } from '../../core/redact.mjs';
import { str } from '../../core/guards.mjs';

const MAX_ERRORS = 20;
const TEXT_MAX = 1000;
const HOOK_MATCH_MS = 2 * 60 * 1000;
const BILLING_CODES = /billing|payment|budget|spending|overage|not_configured/i;
const TRANSIENT_TYPES = /server|overload|timeout|timed_out|network|connection|stream|unavailable/i;

// Redacted before it is cut, so a secret straddling the limit cannot survive as a fragment.
function clampText(v) {
  const t = str(v);
  return t == null ? null : redactText(t).slice(0, TEXT_MAX);
}

function isTransient(type, status) {
  if (typeof status === 'number' && status >= 500) return true;
  return type != null && TRANSIENT_TYPES.test(type);
}

function classifyText(message) {
  const m = message == null ? '' : message;
  if (/rate.?limit|too many requests|\b429\b/i.test(m)) return 'rate_limit';
  if (/billing|payment|budget|spending limit|overage/i.test(m)) return 'billing_error';
  if (/quota|allowance|credits? (are |were )?(exhausted|exceeded|used up)/i.test(m)) return 'rate_limit';
  if (/unauthori[sz]ed|authenticat|forbidden|\b40[13]\b|token (expired|invalid|revoked)|not (logged|signed) in/i.test(m)) return 'authentication_failed';
  return 'unknown';
}

export function classifyError(type, code, status, message) {
  const t = type == null ? '' : String(type).toLowerCase();
  if (t === 'rate_limit' || t === 'session_limits') return 'rate_limit';
  if (t === 'quota') return code != null && BILLING_CODES.test(code) ? 'billing_error' : 'rate_limit';
  if (t === 'authentication' || t === 'authorization') return 'authentication_failed';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'billing_error';
  if (status === 401 || status === 403) return 'authentication_failed';
  // A type outside the known classes (model, model-picker, …) says nothing, so the message decides.
  return classifyText(message);
}

function detailsOf(type, code, status) {
  const parts = [];
  if (type != null) parts.push(type);
  if (code != null) parts.push(code);
  if (status != null) parts.push(String(status));
  return parts.length ? parts.join(' / ').slice(0, TEXT_MAX) : null;
}

function eventError(e) {
  const d = dataOf(e);
  const type = str(d.errorType);
  const code = str(d.errorCode);
  const status = typeof d.statusCode === 'number' ? d.statusCode : null;
  if (isTransient(type, status)) return null;
  const ms = tsMs(e);
  return {
    error: classifyError(type, code, status, str(d.message)),
    errorDetails: detailsOf(type, code, status),
    lastAssistantMessage: clampText(d.message),
    occurredAt: ms == null ? null : new Date(ms).toISOString(),
  };
}

// One row per (error class, UTC minute), the server's own key.
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = e.error + '|' + (typeof e.occurredAt === 'string' ? e.occurredAt.slice(0, 16) : '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function errorFromHookPayload(input) {
  const p = input == null ? {} : input;
  if (p.error_context !== 'model_call' || p.recoverable === true) return null;
  const err = p.error != null && typeof p.error === 'object' ? p.error : {};
  const message = str(err.message) != null ? err.message : str(p.error);
  // A number scraped from free text counts only when the wording names no class itself: a quota sentence can quote any figure.
  const m = /\b([45]\d\d)\b/.exec(message == null ? '' : message);
  const status = m && classifyText(message) === 'unknown' ? Number(m[1]) : null;
  if (isTransient(null, status)) return null;
  const name = str(err.name);
  return {
    sessionId: str(p.session_id),
    error: classifyError(null, null, status, message),
    errorDetails: clampText(name != null && message != null ? name + ': ' + message : (message != null ? message : name)),
    lastAssistantMessage: null,
    occurredAt: hookTimeIso(p.timestamp),
  };
}

export function collectErrors(events, ctx) {
  const out = [];
  const errorTimes = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (e.type !== 'session.error') continue;
    const ms = tsMs(e);
    if (ms != null) errorTimes.push(ms);
    const err = eventError(e);
    if (err != null) out.push(err);
  }
  const hookErrors = ctx != null && Array.isArray(ctx.hookErrors) ? ctx.hookErrors : [];
  for (const h of hookErrors) {
    if (h == null || str(h.error) == null) continue;
    const ms = typeof h.occurredAt === 'string' ? Date.parse(h.occurredAt) : NaN;
    if (Number.isFinite(ms) && errorTimes.some((t) => Math.abs(t - ms) <= HOOK_MATCH_MS)) continue;
    out.push(h);
  }
  return dedupe(out).slice(0, MAX_ERRORS);
}
