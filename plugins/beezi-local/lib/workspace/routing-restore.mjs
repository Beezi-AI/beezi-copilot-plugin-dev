// Puts an account's rules and New folders back for undo; kept out of settings-store, which the SessionStart hook loads, so the hook never loads the undo record.
import { mutateRow, AccountStatus, NO_SUCH_ACCOUNT } from '../accounts/index-store.mjs';
import { routingOf, sameRouting } from '../state/rule-undo.mjs';
import { UserError } from '../core/errors.mjs';

// Thrown inside mutateRow so a refused restore saves nothing; carries the outcome.
class RestoreRefused {
  constructor(outcome) { this.outcome = outcome; }
}

// Puts `before` back only while the row still routes as `expected`: 'missing', 'changed' or 'restored'.
export function restoreRouting(key, { expected, before }) {
  return mutateRow(key, (row) => {
    if (row.status !== AccountStatus.LINKED) throw new RestoreRefused('missing');
    if (!sameRouting(routingOf(row), expected)) throw new RestoreRefused('changed');
    row.workspaceRules = before.workspaceRules;
    row.newFolders = before.newFolders;
    return 'restored';
  }).catch((error) => {
    if (error instanceof RestoreRefused) return error.outcome;
    if (error instanceof UserError && error.message === NO_SUCH_ACCOUNT) return 'missing';
    throw error;
  });
}
