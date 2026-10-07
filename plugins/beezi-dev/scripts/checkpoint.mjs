import { readHookInput, normalizeHookInput, shellCommandOf, isGitCheckpointCommand, hasSessionFile, isVscodeHookPayload } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// PostToolUse (shell tools): checkpoints after git commit, switch and checkout. Prints nothing: PostToolUse
// stdout can replace the tool result.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null || !hasSessionFile(input)) process.exit(0);
if (!isGitCheckpointCommand(shellCommandOf(input))) process.exit(0);
// A VS Code Local-agent session is never read as a Copilot CLI transcript; its pulse and Stop checkpoint it.
if (isVscodeHookPayload(input)) process.exit(0);
// Imported inside the hook, not at the top: an implementation module that throws on import is
// recorded by a runtime that is still standing.
runHook(DIAGNOSTIC_SOURCES.CHECKPOINT, async () => {
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod == null) return;
  await mod.runCheckpoint({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    trigger: 'git',
    budgetMs: 4000,
    withTimeline: false,
    withQuota: false,
  });
});
