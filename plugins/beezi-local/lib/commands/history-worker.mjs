// history-worker.mjs: uploads the past sessions a workspace's accepted offer owes it; the history lease keeps it to one run at a time.
import { runPendingHistory } from '../history/pending-history-run.mjs';
import { exitClean } from '../platform/exit.mjs';

const WATCHDOG_MS = 30 * 60 * 1000;

// Detached: `--account <key>` names the account; every way out, the watchdog included, exits 0.
export function runHistoryWorker(argv, exit = (code) => exitClean(code), run = runPendingHistory) {
  const watchdog = setTimeout(() => exit(0), WATCHDOG_MS);
  const at = argv.indexOf('--account');
  const key = at === -1 ? null : argv[at + 1];
  const done = () => { clearTimeout(watchdog); exit(0); };
  return (key == null ? Promise.resolve() : run(key)).then(done, done);
}
