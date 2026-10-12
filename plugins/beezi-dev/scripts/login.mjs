import { runLogin } from '../lib/commands/login.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';
import { recordLoginFailure } from '../lib/auth/diagnostics.mjs';

// Login is one blocking browser flow, or with --no-browser and then --complete '<url-or-code>' a paste-back one. runLogin
// prints account=<key> last so subsequent capture and backfill commands target the account just authenticated.
runLogin({ args: process.argv.slice(2) }).catch((error) => {
  recordLoginFailure(error == null ? null : error.loginReason);
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
