import { runBillingCapture } from '../lib/commands/billing-capture.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runBillingCapture(process.argv.slice(2)).catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
