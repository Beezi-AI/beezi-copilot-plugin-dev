// workspace.mjs undo: puts back the rules and New folders from before the last recorded change, unless something changed them since.
import { getAccount } from '../../accounts/index-store.mjs';
import { restoreRouting } from '../../workspace/routing-restore.mjs';
import { resolveTargets } from '../../workspace/targets.mjs';
import { createRouteContext } from '../../workspace/route-key.mjs';
import { rulesOf } from '../../workspace/rule-model.mjs';
import { clearUndo, readUndo } from '../../state/rule-undo.mjs';
import { releaseHeldQueue } from '../../delivery/queue-files.mjs';
import { UserError } from '../../core/errors.mjs';
import { UNDO_CHANGED, UNDO_MISSING, UNDO_NOTHING, undoneLine } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { resolveSession } from '../../workspace/session-routes.mjs';
import { USAGE, afterRuleWrite, mayPersist, parseSessionFlag, resolveAccount } from './args.mjs';
import { bindOpenSessions, checkIn, rerouteGone } from './rules.mjs';

// A session here with no rule follows the new New folders now: its held reports go out and workspaces it newly sends to check in.
export async function followNewFolders(fresh, current, prior) {
  if (current.sessionId == null || prior.rule != null) return;
  releaseHeldQueue(fresh, current.sessionId);
  for (const id of resolveTargets(fresh, current.state).targets) {
    if (prior.targets.indexOf(id) === -1) await checkIn(fresh, id);
  }
}

function sameRule(a, b) {
  return a.kind === b.kind && a.match === b.match && JSON.stringify(a.tenantIds) === JSON.stringify(b.tenantIds);
}

// restoreRouting decides missing, revoked and changed under the index lock; an unreadable index throws before the record is cleared.
export async function undo(argv, cx = { deferUpload: false }) {
  const { session, rest } = parseSessionFlag(argv);
  if (rest.length !== 0) throw new UserError(USAGE);
  const last = readUndo();
  if (last == null) {
    console.log(UNDO_NOTHING);
    console.log(machineLine([['undone', 0]]));
    return;
  }
  const current = resolveSession(session);
  if (!(await mayPersist('undoing a rules change', current.sessionId))) return;
  const row = await getAccount(last.account);
  const result = await restoreRouting(last.account, { expected: last.after, before: last.before });
  clearUndo();
  if (result !== 'restored') {
    console.log(result === 'changed' ? UNDO_CHANGED : UNDO_MISSING);
    console.log(machineLine([['undone', 0]]));
    return;
  }
  console.log(undoneLine(last));
  const fresh = await resolveAccount(last.account);
  const ctx = createRouteContext();
  // Rules that came back (or got their old workspaces back) re-bind their sessions; rules that went away re-route theirs.
  const undone = rulesOf({ workspaceRules: last.after.workspaceRules });
  const now = rulesOf(fresh);
  const restored = now.filter((r) => !undone.some((u) => sameRule(u, r)));
  if (restored.length > 0) await bindOpenSessions(fresh, restored.map((r) => r.index), current, ctx);
  await rerouteGone(fresh, undone.filter((u) => !now.some((r) => r.kind === u.kind && r.match === u.match)), ctx);
  if (row != null && JSON.stringify(last.before.newFolders) !== JSON.stringify(last.after.newFolders)) {
    await followNewFolders(fresh, current, resolveTargets(row, current.state));
  }
  await afterRuleWrite(fresh.key, cx, cx.deps);
  console.log(machineLine([['undone', 1]]));
}
