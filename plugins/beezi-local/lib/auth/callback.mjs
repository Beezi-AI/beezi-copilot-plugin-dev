import crypto from 'crypto';

const MAX_ERROR_LENGTH = 200;
const BARE_CODE = /^[A-Za-z0-9._~-]+$/;

export const CALLBACK_OUTCOMES = Object.freeze({ CODE: 'code', ERROR: 'error', IGNORE: 'ignore' });

// Removes C0 controls and DEL so a server-chosen `error` value cannot drive the terminal, then caps it.
export function sanitizeAuthError(raw) {
  return String(raw).replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_ERROR_LENGTH);
}

// Constant-time comparison; a length mismatch is a mismatch.
export function stateMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verdict on one redirect's query: a hit whose state is not ours is ignored, never trusted with an outcome.
export function callbackOutcome(params, expectedState) {
  if (!stateMatches(params.get('state'), expectedState)) return { outcome: CALLBACK_OUTCOMES.IGNORE };
  const error = params.get('error');
  if (error != null) return { outcome: CALLBACK_OUTCOMES.ERROR, error: sanitizeAuthError(error) };
  const code = params.get('code');
  return code ? { outcome: CALLBACK_OUTCOMES.CODE, code } : { outcome: CALLBACK_OUTCOMES.IGNORE };
}

// A pasted redirect URL (or its query) → { params }, a bare authorization code → { code }, anything else → null.
export function parsePastedCallback(input) {
  const text = String(input == null ? '' : input).trim();
  if (text === '') return null;
  const query = text.indexOf('?');
  if (query >= 0 || /(^|&)(code|error|state)=/.test(text)) {
    return { params: new URLSearchParams(query >= 0 ? text.slice(query + 1).split('#')[0] : text) };
  }
  return BARE_CODE.test(text) ? { code: text } : null;
}
