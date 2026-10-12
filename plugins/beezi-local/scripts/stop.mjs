import { normalizeHookInput, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { recordHookSeen } from '../lib/state/hooks-seen.mjs';
import { runHook, importHookModule } from '../lib/host/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/contract/diagnostic-codes.mjs';

// Turn end: the full checkpoint plus the whole-session activity timeline. Prints nothing: a
// `decision:"block"` on Stop forces another turn.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null || !hasSessionFile(input)) process.exit(0);
recordHookSeen('Stop');
const vscode = isVscodeHookPayload(input);
const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
  // This checkpoint does what a pulse would, so the pulse marker starts its interval over.
  const pulse = await importHookModule(new URL('../lib/pipeline/pulse.mjs', import.meta.url).href);
  if (pulse != null) pulse.claimInterval(input.session_id, 'pulse', 0);
  // A VS Code Local-agent session: its chat session file, never VS Code's transcript, goes through the VS Code checkpoint.
  if (vscode) {
    const vsc = await importHookModule(new URL('../lib/pipeline/vscode-checkpoint.mjs', import.meta.url).href);
    if (vsc != null) await vsc.runVscodeCheckpoint({ sessionId: input.session_id, file: vscodeFile, transcriptPath: input.transcript_path, cwd: input.cwd, trigger: 'stop', budgetMs: 8000 });
    return;
  }
  const mod = await importHookModule(new URL('../lib/pipeline/cli-checkpoint.mjs', import.meta.url).href);
  if (mod == null) return;
  await mod.runCheckpoint({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    trigger: 'stop',
    budgetMs: 8000,
    withTimeline: true,
    withQuota: true,
  });
});
