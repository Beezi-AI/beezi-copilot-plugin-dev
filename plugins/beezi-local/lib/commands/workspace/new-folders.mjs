// workspace.mjs new-folders [--history | ask | send <refs> | none]: show or change where sessions in a repo or folder with no rule go.
import { listAccounts, parseAccountFlag } from '../../accounts/index-store.mjs';
import { setNewFolders } from '../../workspace/settings-store.mjs';
import { isMultiTenant } from '../../workspace/tenants.mjs';
import { newFoldersOf, resolveTargets } from '../../workspace/targets.mjs';
import { routingOf } from '../../state/rule-undo.mjs';
import { pastSessions } from '../../history/past-sessions.mjs';
import { UserError } from '../../core/errors.mjs';
import { accountLabel, newFoldersConfirmation, newFoldersLabel, workspaceLines } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { resolveSession } from '../../workspace/session-routes.mjs';
import { USAGE, mayPersist, parseSessionFlag, requireMulti, resolveAccount, selection } from './args.mjs';
import { confirmChange } from './rules.mjs';
import { followNewFolders } from './undo.mjs';

// The setup question's preview: past sessions the upload would send and the places they come from. A count that fails prints
// nothing, so the question still stands without numbers.
function historyLines(row) {
  let counts = null;
  try { counts = pastSessions(row); } catch { counts = null; }
  return counts == null ? [] : [machineLine([['history', counts.sessions], ['places', counts.places]])];
}

async function showNewFolders(row, history) {
  if (!isMultiTenant(row)) {
    console.log(machineLine([['new-folders', 'n/a'], ['multi', 'no'], ['account', row.key]]));
    return;
  }
  const several = (await listAccounts()).length > 1;
  const newFoldersNow = newFoldersOf(row);
  console.log(`New folders${several ? ` (${accountLabel(row)})` : ''}: ${newFoldersLabel(row)}`);
  for (const line of workspaceLines(row)) console.log(line);
  if (history) for (const line of historyLines(row)) console.log(line);
  console.log(machineLine([['new-folders', newFoldersNow.mode], ['set', newFoldersNow.set ? 'yes' : 'no'], ['multi', 'yes'], ['account', row.key]]));
}

export async function newFolders(argv) {
  const history = argv.indexOf('--history') !== -1;
  const { session, rest: afterSession } = parseSessionFlag(argv.filter((arg) => arg !== '--history'));
  const { account, rest } = await parseAccountFlag(afterSession);
  const row = await resolveAccount(account);
  if (rest.length === 0) {
    await showNewFolders(row, history);
    return;
  }
  requireMulti(row);
  const mode = String(rest[0]).toLowerCase();
  if ((mode !== 'ask' && mode !== 'send' && mode !== 'none') || (mode !== 'send' && rest.length > 1) || history) throw new UserError(USAGE);
  const tenantIds = mode === 'send' ? selection(row, rest.slice(1)) : [];
  if (mode === 'send' && tenantIds.length === 0) throw new UserError('Send needs at least one workspace; use none to send nowhere.');
  const current = resolveSession(session);
  if (!(await mayPersist('changing the New folders setting', current.sessionId))) return;
  const prior = resolveTargets(row, current.state);
  const before = routingOf(row);
  await setNewFolders(row.key, { mode, tenantIds });
  const fresh = await resolveAccount(row.key);
  confirmChange(fresh, newFoldersConfirmation(row, mode, tenantIds), before);
  await followNewFolders(fresh, current, prior);
  console.log(machineLine([['new-folders', mode]]));
}
