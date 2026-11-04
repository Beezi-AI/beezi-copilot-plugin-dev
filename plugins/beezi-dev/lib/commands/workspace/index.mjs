// workspace.mjs: dispatches rules, rule, routes, joined, new-folders, read, places and undo.
import { UserError } from '../../core/errors.mjs';
import { USAGE } from './args.mjs';
import { rule, rules } from './rules.mjs';
import { routes } from './routes.mjs';
import { joined } from './joined.mjs';
import { newFolders } from './new-folders.mjs';
import { read } from './read.mjs';
import { places } from './places.mjs';
import { undo } from './undo.mjs';

const SUBCOMMANDS = { rules, rule, routes, joined, 'new-folders': newFolders, read, places, undo };

export async function runWorkspace(argv) {
  const [cmd, ...rest] = argv;
  if (cmd != null && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, cmd)) {
    await SUBCOMMANDS[cmd](rest);
    return;
  }
  throw new UserError(cmd == null ? USAGE : `Unknown command "${cmd}". ${USAGE}`);
}
