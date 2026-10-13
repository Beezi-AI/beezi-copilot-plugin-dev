import { runAccounts } from '../lib/commands/accounts.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runAccounts(process.argv.slice(2)).catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
