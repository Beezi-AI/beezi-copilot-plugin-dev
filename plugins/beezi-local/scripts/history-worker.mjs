import { runHistoryWorker } from '../lib/commands/history-worker.mjs';

// Detached from rule writes, sync, login and SessionStart; argv is `--account <key>`; prints nothing.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);

runHistoryWorker(process.argv.slice(2));
