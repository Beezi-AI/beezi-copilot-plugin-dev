// workspace.mjs routes: past sessions waiting under New folders = Ask me, grouped by repo or folder, for the planning questions.
import { AccountStatus, parseAccountFlag } from '../../accounts/index-store.mjs';
import { isMultiTenant } from '../../workspace/tenants.mjs';
import { newFoldersOf } from '../../workspace/targets.mjs';
import { createRouteContext } from '../../workspace/route-key.mjs';
import { isLineSafePlace } from '../../workspace/rule-model.mjs';
import { planUnruledRoutes } from '../../history/history-routing.mjs';
import { listSessionFiles } from '../../sources/cli/session-files.mjs';
import { UserError } from '../../core/errors.mjs';
import { commandLine, deferSuffix, routeLine, routesHeaderLine, ruleAddCommandLine, workspaceLines } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { resolveSession } from '../../workspace/session-routes.mjs';
import { USAGE, pastSessionOptions, parseSessionFlag, selectedRows } from './args.mjs';

// Returns how many P lines it printed.
export async function routes(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(session);
  const ctx = createRouteContext();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED || !isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') continue;
    if (entries == null) entries = await listSessionFiles();
    const planned = planUnruledRoutes(row, entries, ctx, pastSessionOptions(sessionId));
    // A place whose name holds a control character would forge a machine line, so it is left out, as in `joined`.
    const groups = planned.filter(isLineSafePlace);
    if (groups.length > 0) {
      console.log(routesHeaderLine(row, groups.length, groups.reduce((sum, g) => sum + g.sessions, 0)));
      for (const line of workspaceLines(row)) console.log(line);
      for (const g of groups) {
        total += 1;
        console.log(routeLine(total, row, g));
        console.log(ruleAddCommandLine(`P${total}-command`, g, row, cx.deferUpload));
      }
      console.log(commandLine('all-command', `rule add-all --account ${row.key}${deferSuffix(cx.deferUpload)} <tenants>`));
    }
    const lost = planned.noDirectory;
    if (lost > 0) {
      console.log(lost === 1
        ? '1 other past session has no recorded folder and is not sent.'
        : `${lost} other past sessions have no recorded folder and are not sent.`);
    }
  }
  console.log(machineLine([['routes', total]]));
  return total;
}
