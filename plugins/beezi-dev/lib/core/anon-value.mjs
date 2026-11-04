// Owns the made-up values an anonymized workspace receives: anon:<kind>:<first 32 hex of HMAC-SHA256(key, kind \0 input)>.
import crypto from 'crypto';

export const ANON_KIND = Object.freeze({
  REPO: 'repo',
  FOLDER: 'folder',
  BRANCH: 'branch',
  HOST: 'host',
  ACCOUNT: 'account',
  SESSION: 'session',
});

const ANON_VALUE_RE = /^anon:(repo|folder|branch|host|account|session):[0-9a-f]{32}$/;
const ANON_HEX_LENGTH = 32;

export function isAnonValue(value) {
  return typeof value === 'string' && ANON_VALUE_RE.test(value);
}

export function anonValue(keyHex, kind, input) {
  if (isAnonValue(input)) return input;
  const hex = crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(kind + '\0' + input, 'utf8').digest('hex');
  return 'anon:' + kind + ':' + hex.slice(0, ANON_HEX_LENGTH);
}

// A non-string passes through unchanged.
function anonNormalized(keyHex, kind, value) {
  return typeof value === 'string' ? anonValue(keyHex, kind, value.toLowerCase().trim()) : value;
}

export function anonHost(keyHex, hostname) {
  return anonNormalized(keyHex, ANON_KIND.HOST, hostname);
}

// A Copilot account id is the identity key '<host>/<login>'.
export function anonAccount(keyHex, value) {
  return anonNormalized(keyHex, ANON_KIND.ACCOUNT, value);
}

export function anonSession(keyHex, sessionId) {
  return typeof sessionId === 'string' ? anonValue(keyHex, ANON_KIND.SESSION, sessionId) : sessionId;
}
