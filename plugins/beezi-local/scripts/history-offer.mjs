import { runHistoryOffer } from '../lib/commands/history/offer.mjs';
import { fail } from '../lib/commands/history/run-history.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runHistoryOffer(process.argv.slice(2)).catch((error) => fail(friendlyMessage(error)));
