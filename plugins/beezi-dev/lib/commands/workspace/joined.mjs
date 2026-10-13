// workspace.mjs joined [add-all | done]: the places to re-pick after an account joins a workspace, and the two ways to finish.
import { AccountStatus, parseAccountFlag } from '../../accounts/index-store.mjs';
import { markTenantsReviewed, setWorkspaceRule } from '../../workspace/settings-store.mjs';
import { joinTenantNames, newTenantsOf, tenantsOf } from '../../workspace/tenants.mjs';
import { createRouteContext } from '../../workspace/route-key.mjs';
import { isLineSafePlace } from '../../workspace/rule-model.mjs';
import { placeNow, planReviewPlaces } from '../../history/history-routing.mjs';
import { listSessionFiles } from '../../sources/cli/session-files.mjs';
import { UserError } from '../../core/errors.mjs';
import {
  commandLine, deferSuffix, idList, joinedHeaderLine, joinedLine, ruleAddCommandLine, workspaceLines,
} from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import {
  USAGE, afterRuleWrite, mayPersist, pastSessionOptions, parseSessionFlag, requireMulti, resolveAccount, resolveSession, selectedRows,
} from './args.mjs';
import { bindOpenSessions } from './rules.mjs';

// Accounts that joined a workspace since their last re-pick here: every place to re-pick, with where it sends now (login Step 5a, /beezi-dev-sync Step 1).
export async function joined(argv, cx = { deferUpload: false }) {
  const [sub, ...after] = argv;
  if (sub === 'add-all') { await joinedAddAll(after, cx); return; }
  if (sub === 'done') { await joinedDone(after); return; }
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(session);
  const ctx = createRouteContext();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED) continue;
    const newIds = newTenantsOf(row);
    if (newIds.length === 0) continue;
    if (entries == null) entries = await listSessionFiles();
    const places = planReviewPlaces(row, entries, ctx, pastSessionOptions(sessionId))
      .filter(isLineSafePlace);
    if (places.length === 0) continue;
    console.log(joinedHeaderLine(row, joinTenantNames(row, newIds), newIds, places.length));
    for (const line of workspaceLines(row, newIds)) console.log(line);
    for (const place of places) {
      total += 1;
      console.log(joinedLine(total, row, place, placeNow(row, place, newIds)));
      console.log(ruleAddCommandLine(`J${total}-command`, place, row, cx.deferUpload));
    }
    console.log(commandLine('add-all-command', `joined add-all --account ${row.key}${deferSuffix(cx.deferUpload)}`));
    console.log(commandLine('done-command', `joined done --account ${row.key}`));
  }
  console.log(machineLine([['joined', total]]));
}

// Adds the new workspaces to every listed place that already sends somewhere; Don't-track and no-rule-yet places stay as they are. Then marks the join reviewed.
async function joinedAddAll(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const newIds = newTenantsOf(row);
  if (newIds.length === 0) {
    console.log('✓ No new workspaces are waiting for a review.');
    console.log(machineLine([['rules-added', 0]]));
    return;
  }
  const current = resolveSession(session);
  if (!(await mayPersist('saving a workspace rule', current.sessionId))) return;
  const ctx = createRouteContext();
  const members = tenantsOf(row).map((t) => t.id);
  const added = [];
  for (const place of planReviewPlaces(row, await listSessionFiles(), ctx, pastSessionOptions(current.sessionId))) {
    const now = placeNow(row, place, newIds);
    if (now.pending || now.ids.length === 0) continue;
    const tenantIds = members.filter((id) => now.ids.indexOf(id) !== -1 || newIds.indexOf(id) !== -1);
    added.push((await setWorkspaceRule(row.key, { kind: place.kind, match: place.match, label: place.label, tenantIds })).index);
  }
  await markTenantsReviewed(row.key, newIds);
  const n = added.length;
  const names = joinTenantNames(row, newIds);
  console.log(n === 0
    ? `✓ Nothing to add: no repo or folder sends anywhere yet. ${names} won't be asked about again.`
    : `✓ ${names} now ${newIds.length === 1 ? 'gets' : 'get'} analytics from ${n === 1 ? '1 repo or folder' : `${n} repos and folders`}.`);
  if (n > 0) {
    await bindOpenSessions(await resolveAccount(row.key), added, current, ctx);
    await afterRuleWrite(row.key, cx, cx.deps);
  }
  console.log(machineLine([['rules-added', n]]));
}

// Marks the account's new workspaces reviewed, whatever the answers were.
async function joinedDone(argv) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const newIds = newTenantsOf(row);
  if (newIds.length > 0 && !(await mayPersist('saving a workspace review', resolveSession(null).sessionId))) return;
  await markTenantsReviewed(row.key, newIds);
  console.log(newIds.length === 0 ? '✓ No new workspaces were waiting for a review.' : `✓ Done reviewing ${joinTenantNames(row, newIds)}.`);
  console.log(machineLine([['reviewed', idList(newIds)]]));
}
