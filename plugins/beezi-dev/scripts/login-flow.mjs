import { loginFlow } from '../lib/commands/login-flow.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

// /beezi-dev-login's steps up to the next question; the last line is next=<step>, or a ✗ line when the flow itself failed.
loginFlow(process.argv.slice(2)).catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
