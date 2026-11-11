// workspace.mjs: dispatches rules, rule, routes, joined, new-folders, read, places, setup and undo.
import { UserError } from '../../core/errors.mjs';
import { USAGE } from './args.mjs';
import { rule, rules } from './rules.mjs';
import { routes } from './routes.mjs';
import { joined } from './joined.mjs';
import { newFolders } from './new-folders.mjs';
import { read } from './read.mjs';
import { places } from './places.mjs';
import { setup } from './setup.mjs';
import { undo } from './undo.mjs';

const SUBCOMMANDS = { rules, rule, routes, joined, 'new-folders': newFolders, read, places, setup, undo };

// `deps` reaches the setup listing's scan; the other subcommands take none.
export async function runWorkspace(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  if (cmd != null && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, cmd)) {
    await SUBCOMMANDS[cmd](rest, deps);
    return;
  }
  throw new UserError(cmd == null ? USAGE : `Unknown command "${cmd}". ${USAGE}`);
}
