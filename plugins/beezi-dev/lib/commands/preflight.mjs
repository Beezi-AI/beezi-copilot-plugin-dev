// preflight.mjs --for <purpose>: Step 0 of the interactive skills, one verdict line saying whether the skill may run here.
import { checkInteractive } from '../host/mode-guard.mjs';
import { resolveSessionId } from '../host/session-resolver.mjs';
import { machineLine } from '../ux/machine-lines.mjs';

const PURPOSES = {
  login: { purpose: 'linking a Beezi account', requireWrite: true },
  logout: { purpose: 'logging out of Beezi', requireWrite: true },
  settings: { purpose: 'changing Beezi settings', requireWrite: true },
  sync: { purpose: 'uploading your session history', requireWrite: true },
};

// The guard's verdict for the session Copilot runs this in; the guard's own failure reads as "no signal": typed arguments only.
function verdictFor(target, env, cwd) {
  try {
    const found = resolveSessionId({ env, cwd });
    const sessionId = found != null && found.ambiguous !== true ? found.sessionId : null;
    return checkInteractive({ purpose: target.purpose, requireWrite: target.requireWrite, sessionId });
  } catch {
    return { ok: true, reason: 'argument-only', message: null };
  }
}

// Prints the verdict; a failed check is a printed ✗ line, never a thrown error.
export function runPreflight(argv, env, cwd) {
  const flag = argv.indexOf('--for');
  const wanted = flag === -1 ? null : argv[flag + 1];
  const target = wanted != null && Object.prototype.hasOwnProperty.call(PURPOSES, wanted) ? PURPOSES[wanted] : null;
  if (target == null) {
    console.log(`✗ Beezi: usage: preflight.mjs --for <${Object.keys(PURPOSES).join('|')}>`);
    return;
  }
  const verdict = verdictFor(target, env, cwd);
  console.log(verdict.ok ? `✓ Beezi: ${target.purpose} can run here.` : `✗ ${verdict.message}`);
  if (verdict.ok && verdict.reason === 'argument-only') console.log(machineLine([['mode', 'argument-only']]));
}
