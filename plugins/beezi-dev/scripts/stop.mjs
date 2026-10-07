import { readHookInput, normalizeHookInput, recordHookSeen, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// Turn end: the full checkpoint plus the whole-session activity timeline. Prints nothing: a
// `decision:"block"` on Stop forces another turn.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null || !hasSessionFile(input)) process.exit(0);
recordHookSeen('Stop');
const vscode = isVscodeHookPayload(input);
const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
  // This checkpoint does what a pulse would, so the pulse marker starts its interval over.
  const pulse = await importHookModule('./pulse.mjs');
  if (pulse != null) pulse.claimInterval(input.session_id, 'pulse', 0);
  // A VS Code Local-agent session: its chat session file, never VS Code's transcript, goes through the VS Code checkpoint.
  if (vscode) {
    const vsc = await importHookModule('./vscode-checkpoint.mjs');
    if (vsc != null) await vsc.runVscodeCheckpoint({ sessionId: input.session_id, file: vscodeFile, transcriptPath: input.transcript_path, cwd: input.cwd, trigger: 'stop', budgetMs: 8000, settleWaitMs: 3000 });
    return;
  }
  const mod = await importHookModule('./checkpoint.mjs');
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
