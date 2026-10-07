import { checkInteractive } from '../lib/mode-guard.mjs';
import { resolveSessionId } from '../lib/sessions.mjs';

// Step 0 of the interactive skills. Always exits 0: the verdict is the printed line, so a failed check
// reads as an instruction to stop instead of a crash the model tries to recover from.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);

const PURPOSES = {
  login: { purpose: 'linking a Beezi account', requireWrite: true },
  logout: { purpose: 'logging out of Beezi', requireWrite: true },
  settings: { purpose: 'changing Beezi settings', requireWrite: true },
  sync: { purpose: 'uploading your session history', requireWrite: true },
};

const flag = process.argv.indexOf('--for');
const wanted = flag === -1 ? null : process.argv[flag + 1];
const target = wanted != null && Object.prototype.hasOwnProperty.call(PURPOSES, wanted) ? PURPOSES[wanted] : null;

if (target == null) {
  console.log(`✗ Beezi: usage: preflight.mjs --for <${Object.keys(PURPOSES).join('|')}>`);
} else {
  let verdict = { ok: true, reason: 'argument-only', message: null };
  try {
    const found = resolveSessionId({ env: process.env, cwd: process.cwd() });
    const sessionId = found != null && found.ambiguous !== true ? found.sessionId : null;
    verdict = checkInteractive({ purpose: target.purpose, requireWrite: target.requireWrite, sessionId });
  } catch { /* the guard's own failure reads as "no signal": typed arguments only */ }
  console.log(verdict.ok ? `✓ Beezi: ${target.purpose} can run here.` : `✗ ${verdict.message}`);
  if (verdict.ok && verdict.reason === 'argument-only') console.log('mode=argument-only');
}
process.exitCode = 0;
