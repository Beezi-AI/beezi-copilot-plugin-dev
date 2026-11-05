// Manual dry run of the history import per routed workspace, kept for the replay harness; past sessions upload only through history-offer.mjs accept.
import { runBackfill } from '../lib/commands/history/backfill.mjs';
import { fail } from '../lib/commands/history/run-history.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runBackfill(process.argv.slice(2)).catch((error) => fail(friendlyMessage(error)));
