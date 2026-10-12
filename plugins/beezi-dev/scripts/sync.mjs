import { runSync } from '../lib/commands/history/sync.mjs';
import { fail } from '../lib/commands/history/run-history.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runSync(process.argv.slice(2)).catch((error) => fail(friendlyMessage(error)));
