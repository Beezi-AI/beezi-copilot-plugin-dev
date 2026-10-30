import { runBackfill } from '../lib/commands/history/backfill.mjs';
import { fail } from '../lib/commands/history/run-history.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runBackfill(process.argv.slice(2)).catch((error) => fail(friendlyMessage(error)));
