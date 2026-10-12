import { runPreflight } from '../lib/commands/preflight.mjs';

// Step 0 of the interactive skills. Always exits 0: the verdict is the printed line, so a failed check
// reads as an instruction to stop instead of a crash the model tries to recover from.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);

runPreflight(process.argv, process.env, process.cwd());
process.exitCode = 0;
