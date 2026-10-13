import { normalizeHookInput } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { sessionStartOutput } from '../lib/host/session-start-output.mjs';
import { recordHookSeen } from '../lib/state/hooks-seen.mjs';
import { runHook, importHookModule } from '../lib/host/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/contract/diagnostic-codes.mjs';

// The only hook that writes to stdout: at most one JSON object carrying additionalContext (see sessionStartOutput). The
// most important actionable notice rides it as a line for the model to relay. The body loads lazily, so nothing beyond
// the imports above is loaded before the probe exit.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null) process.exit(0);
recordHookSeen('SessionStart');

function write({ additionalContext }) {
  const output = sessionStartOutput(additionalContext);
  if (output != null) process.stdout.write(JSON.stringify(output));
}

runHook(DIAGNOSTIC_SOURCES.SESSION_START, async () => {
  const hook = await importHookModule(new URL('../lib/commands/session-start-hook.mjs', import.meta.url).href);
  if (hook == null) return { additionalContext: null };
  // Nine seconds, not twelve: the sync git calls cannot be preempted and the workspace prompt still runs after it, inside the 15 s hook timeout.
  return hook.runSessionStartHook(input, { budgetMs: 9000, write });
}, { onResult: write });
