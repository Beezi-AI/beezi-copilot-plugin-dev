import { runWorkspace } from '../lib/commands/workspace/index.mjs';
import { friendlyMessage } from '../lib/core/errors.mjs';

runWorkspace(process.argv.slice(2)).catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
