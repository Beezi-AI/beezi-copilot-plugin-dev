import { runCatchUp } from '../lib/commands/catch-up.mjs';
import { exitClean } from '../lib/platform/exit.mjs';

// Detached from SessionStart. argv is the starting session's id; prints nothing.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);

runCatchUp(process.argv.slice(2)).catch(() => {}).then(() => exitClean(0)).catch(() => exitClean(0));
