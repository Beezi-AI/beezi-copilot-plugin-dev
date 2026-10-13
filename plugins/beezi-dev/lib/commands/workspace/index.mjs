// workspace.mjs: dispatches rules, rule, routes, joined, new-folders and read.
import { UserError } from '../../core/errors.mjs';
import { USAGE } from './args.mjs';
import { rule, rules } from './rules.mjs';
import { routes } from './routes.mjs';
import { joined } from './joined.mjs';
import { newFolders } from './new-folders.mjs';
import { read } from './read.mjs';
import { takeDeferFlag } from '../../history/pending-trigger.mjs';

const SUBCOMMANDS = { rules, rule, routes, joined, 'new-folders': newFolders, read };

// --defer-upload is taken from anywhere in argv once, here, and reaches the handlers as cx.deferUpload.
export async function runWorkspace(argv, deps = {}) {
  const taken = takeDeferFlag(argv);
  const cx = { deferUpload: taken.deferUpload, deps };
  const [cmd, ...rest] = taken.argv;
  if (cmd != null && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, cmd)) {
    await SUBCOMMANDS[cmd](rest, cx);
    return;
  }
  throw new UserError(cmd == null ? USAGE : `Unknown command "${cmd}". ${USAGE}`);
}
