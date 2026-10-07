import { installStatusline, uninstallStatusline } from '../lib/statusline-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// `[--uninstall]`; prints one ✓/✗ line (a refusal or the JSONC snippet adds lines after the ✗).
try {
  const { ok, message } = process.argv.includes('--uninstall')
    ? uninstallStatusline()
    : installStatusline();
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
