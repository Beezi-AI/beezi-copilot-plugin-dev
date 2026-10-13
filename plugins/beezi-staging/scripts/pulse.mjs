import { normalizeHookInput, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { maybeRunPulse, pulseDue } from '../lib/pipeline/pulse.mjs';

// PostToolUse (every tool), postToolUseFailure, notification and, with --precompact, PreCompact. Prints nothing: PostToolUse
// stdout can replace the tool result. The 15-minute gate in lib/pipeline/pulse.mjs costs one stat(); the runner and its
// telemetry stack load only after it passes.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null || !input.transcript_path || !hasSessionFile(input)) process.exit(0);
const precompact = process.argv.indexOf('--precompact') !== -1;
if (!precompact && !pulseDue(input.session_id)) process.exit(0);

async function main() {
  const { runHook, importHookModule } = await import('../lib/host/hook-runner.mjs');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/contract/diagnostic-codes.mjs');
  // A Copilot CLI payload names events.jsonl, so this costs nothing there; a VS Code one is pulsed through the VS Code checkpoint, which finds a chat file not yet written as no-transcript.
  const vscode = isVscodeHookPayload(input);
  const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
  await runHook(DIAGNOSTIC_SOURCES.PULSE, async () => {
    if (!vscode) {
      await maybeRunPulse(input, { force: precompact, budgetMs: 8000 });
      return;
    }
    const runCheckpoint = async (args) => {
      const vsc = await importHookModule(new URL('../lib/pipeline/vscode-checkpoint.mjs', import.meta.url).href);
      return vsc == null ? null : vsc.runVscodeCheckpoint({ ...args, file: vscodeFile });
    };
    await maybeRunPulse(input, { force: precompact, budgetMs: 8000, runCheckpoint });
  });
}

main().catch(() => process.exit(0));
