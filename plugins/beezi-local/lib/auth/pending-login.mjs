// The paste-back sign-in's half-finished grant: PKCE verifier, state and client, kept 0600 between the two commands.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { UserError } from '../core/errors.mjs';
import { callbackOutcome, parsePastedCallback, stateMatches, CALLBACK_OUTCOMES } from './callback.mjs';

export const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const DYNAMIC_PORT_FIRST = 49152;
const DYNAMIC_PORT_COUNT = 16384;
const FIELDS = ['verifier', 'state', 'clientId', 'redirectUri', 'tokenEndpoint'];
const START_AGAIN = 'Run /beezi-local-login again for a new link.';
const PASTE_HINT = 'Paste the full address the browser showed after you signed in (it starts with http://127.0.0.1).';

export function pendingLoginFile() {
  return path.join(beeziHome(), 'login-pending.json');
}

// Nothing listens on this port: the browser's failed page load leaves the code in its address bar for the user to paste.
export function pasteBackRedirectUri(randomBytes = crypto.randomBytes) {
  const port = DYNAMIC_PORT_FIRST + (randomBytes(2).readUInt16BE(0) % DYNAMIC_PORT_COUNT);
  return `http://127.0.0.1:${port}/callback`;
}

export function savePendingLogin({ verifier, state, clientId, redirectUri, tokenEndpoint }, now) {
  writeJsonSecure(pendingLoginFile(), { version: 1, createdAt: now, verifier, state, clientId, redirectUri, tokenEndpoint });
}

export function discardPendingLogin() {
  try { fs.unlinkSync(pendingLoginFile()); } catch { /* already gone */ }
}

function isPending(value) {
  return value != null && typeof value === 'object' && typeof value.createdAt === 'number'
    && FIELDS.every((field) => typeof value[field] === 'string' && value[field] !== '');
}

// The pasted redirect's code; a URL must carry this login's state, a bare code is bound to the verifier by PKCE alone.
function pastedCode(input, expectedState) {
  const pasted = parsePastedCallback(input);
  if (pasted == null) throw new UserError(PASTE_HINT);
  if (pasted.code != null) return pasted.code;
  if (pasted.params.get('state') == null) throw new UserError(`That address has no sign-in state. ${PASTE_HINT}`);
  if (!stateMatches(pasted.params.get('state'), expectedState)) {
    throw new UserError('That address belongs to an older or different sign-in link. Paste the address from the latest link.');
  }
  const verdict = callbackOutcome(pasted.params, expectedState);
  if (verdict.outcome === CALLBACK_OUTCOMES.ERROR) throw new UserError(`Authorization failed: ${verdict.error}.`);
  if (verdict.outcome !== CALLBACK_OUTCOMES.CODE) throw new UserError(`That address has no authorization code. ${PASTE_HINT}`);
  return verdict.code;
}

// Validates the pasted redirect against the saved login and consumes it: { meta, clientId, redirectUri, code, verifier }.
export function takePendingLogin(input, now) {
  const pending = readJson(pendingLoginFile(), null);
  if (!isPending(pending)) throw new UserError(`No sign-in is waiting to be finished. ${START_AGAIN}`);
  if (now - pending.createdAt > PENDING_LOGIN_TTL_MS || now < pending.createdAt) {
    discardPendingLogin();
    throw new UserError(`That sign-in link expired. ${START_AGAIN}`);
  }
  const code = pastedCode(input, pending.state);
  // Single use: the verifier is gone before the code is exchanged, whatever the exchange answers.
  discardPendingLogin();
  return { meta: { tokenEndpoint: pending.tokenEndpoint }, clientId: pending.clientId, redirectUri: pending.redirectUri, code, verifier: pending.verifier };
}
