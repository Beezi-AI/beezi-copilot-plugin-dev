import { runSettings } from '../lib/commands/settings.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runSettings(process.argv.slice(2)).catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
