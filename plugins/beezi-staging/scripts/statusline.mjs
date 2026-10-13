import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { runStatusline } from '../lib/statusline/passthrough.mjs';

// Beezi status line: a pass-through wrapper that records a local snapshot, then renders the user's own line
// (logic and its ordering rules in lib/statusline/passthrough.mjs).
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const raw = readHookStdin();

runStatusline(raw);
