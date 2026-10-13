// workspace.mjs new-folders [ask | send <refs> | none]: show or change where sessions in a repo or folder with no rule go.
import { listAccounts, parseAccountFlag } from '../../accounts/index-store.mjs';
import { setNewFolders } from '../../workspace/settings-store.mjs';
import { isMultiTenant } from '../../workspace/tenants.mjs';
import { newFoldersOf, resolveTargets } from '../../workspace/targets.mjs';
import { releaseHeldQueue } from '../../delivery/queue-files.mjs';
import { UserError } from '../../core/errors.mjs';
import { accountLabel, newFoldersLabel, tenantNames, workspaceLines } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { USAGE, afterRuleWrite, mayPersist, parseSessionFlag, requireMulti, resolveAccount, resolveSession, selection } from './args.mjs';
import { checkIn } from './rules.mjs';

async function showNewFolders(row) {
  if (!isMultiTenant(row)) {
    console.log(machineLine([['new-folders', 'n/a'], ['multi', 'no'], ['account', row.key]]));
    return;
  }
  const several = (await listAccounts()).length > 1;
  const newFoldersNow = newFoldersOf(row);
  console.log(`New folders${several ? ` (${accountLabel(row)})` : ''}: ${newFoldersLabel(row)}`);
  for (const line of workspaceLines(row)) console.log(line);
  console.log(machineLine([['new-folders', newFoldersNow.mode], ['set', newFoldersNow.set ? 'yes' : 'no'], ['multi', 'yes'], ['account', row.key]]));
}

export async function newFolders(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const row = await resolveAccount(account);
  if (rest.length === 0) {
    await showNewFolders(row);
    return;
  }
  requireMulti(row);
  const mode = String(rest[0]).toLowerCase();
  if ((mode !== 'ask' && mode !== 'send' && mode !== 'none') || (mode !== 'send' && rest.length > 1)) throw new UserError(USAGE);
  const tenantIds = mode === 'send' ? selection(row, rest.slice(1)) : [];
  if (mode === 'send' && tenantIds.length === 0) throw new UserError('Send needs at least one workspace; use none to send nowhere.');
  const current = resolveSession(session);
  if (!(await mayPersist('changing the New folders setting', current.sessionId))) return;
  const before = resolveTargets(row, current.state);
  await setNewFolders(row.key, { mode, tenantIds });
  if (mode === 'ask') console.log('✓ New folders: Ask me — Beezi asks once per repo or folder.');
  else if (mode === 'send') console.log(`✓ New folders: analytics go to ${tenantNames(row, tenantIds)}.`);
  else console.log('✓ New folders: not uploaded.');
  // A session here with no rule follows the new setting now: its held reports go out and new workspaces check in.
  if (current.sessionId != null && before.rule == null) {
    const fresh = await resolveAccount(row.key);
    releaseHeldQueue(fresh, current.sessionId);
    for (const id of resolveTargets(fresh, current.state).targets) {
      if (before.targets.indexOf(id) === -1) await checkIn(fresh, id);
    }
  }
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['new-folders', mode]]));
}
