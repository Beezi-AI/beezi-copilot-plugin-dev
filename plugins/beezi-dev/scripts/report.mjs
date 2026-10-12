import { normalizeHookInput, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { recordHookSeen } from '../lib/state/hooks-seen.mjs';
import { runHook, importHookModule } from '../lib/host/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/contract/diagnostic-codes.mjs';

// SessionEnd: the pending-shutdown flag, a detached shutdown-worker when none is waiting, then the final checkpoint. Prints nothing.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null || !hasSessionFile(input)) process.exit(0);
recordHookSeen('SessionEnd');
const vscode = isVscodeHookPayload(input);
const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
runHook(DIAGNOSTIC_SOURCES.REPORT, async () => {
  const mod = await importHookModule(new URL('../lib/pipeline/session-end.mjs', import.meta.url).href);
  if (mod != null) await mod.runSessionEnd(input, { vscode, vscodeFile, budgetMs: 10000, settleWaitMs: 3000 });
});
