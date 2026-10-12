import { normalizeHookInput, shellCommandOf, hasSessionFile, isVscodeHookPayload } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { isGitCheckpointCommand } from '../lib/host/git-trigger.mjs';

// PostToolUse (shell tools): checkpoints after a command that moves the branch or commit. Prints nothing: PostToolUse
// stdout can replace the tool result. The runner and its telemetry stack load only after the command gate passes.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null || !isGitCheckpointCommand(shellCommandOf(input)) || !hasSessionFile(input)) process.exit(0);
// A VS Code Local-agent session is never read as a Copilot CLI transcript; its pulse and Stop checkpoint it.
if (isVscodeHookPayload(input)) process.exit(0);

async function main() {
  const { runHook, importHookModule } = await import('../lib/host/hook-runner.mjs');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/contract/diagnostic-codes.mjs');
  // Imported inside the hook: an implementation module that throws on import is recorded by a runtime still standing.
  await runHook(DIAGNOSTIC_SOURCES.CHECKPOINT, async () => {
    const mod = await importHookModule(new URL('../lib/pipeline/cli-checkpoint.mjs', import.meta.url).href);
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
}

main().catch(() => process.exit(0));
