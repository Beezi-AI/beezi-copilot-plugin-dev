import { readHookInput, normalizeHookInput, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// PostToolUse (every tool) and, with --precompact, PreCompact. Prints nothing: PostToolUse stdout can replace
// the tool result. The pulse gate (15 minutes) lives in lib/pulse.mjs and costs one stat().
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null || !hasSessionFile(input)) process.exit(0);
const precompact = process.argv.indexOf('--precompact') !== -1;
// A Copilot CLI payload names events.jsonl, so this costs nothing there; a VS Code one is pulsed through the VS Code checkpoint, which finds a chat file not yet written as no-transcript.
const vscode = isVscodeHookPayload(input);
const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
runHook(DIAGNOSTIC_SOURCES.PULSE, async () => {
  const mod = await importHookModule('./pulse.mjs');
  if (mod == null) return;
  if (!vscode) {
    await mod.maybeRunPulse(input, { force: precompact, budgetMs: 8000 });
    return;
  }
  const runCheckpoint = async (args) => {
    const vsc = await importHookModule('./vscode-checkpoint.mjs');
    return vsc == null ? null : vsc.runVscodeCheckpoint({ ...args, file: vscodeFile });
  };
  await mod.maybeRunPulse(input, { force: precompact, budgetMs: 8000, runCheckpoint });
});
