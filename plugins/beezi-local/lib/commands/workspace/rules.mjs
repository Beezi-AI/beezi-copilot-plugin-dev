// workspace.mjs rules and rule add|set|remove|add-all: list, write and remove workspace rules, then re-bind open sessions.
import os from 'os';
import path from 'path';
import { parseAccountFlag } from '../../accounts/index-store.mjs';
import { removeWorkspaceRule, setWorkspaceRule } from '../../workspace/settings-store.mjs';
import {
  choiceDir, initSessionWorkspace, listSessionWorkspaces, readSessionWorkspace, recordSessionRoute, resolveSession,
} from '../../workspace/session-routes.mjs';
import { isMultiTenant, isSingleTenant, tenantsOf } from '../../workspace/tenants.mjs';
import { resolveTargets } from '../../workspace/targets.mjs';
import { createRouteContext, routeKeyForDir } from '../../workspace/route-key.mjs';
import { outsideKey, rulesOf } from '../../workspace/rule-model.mjs';
import { planUnruledRoutes } from '../../history/history-routing.mjs';
import { routeForDir } from '../../workspace/routing.mjs';
import { rulesTableLines } from '../../ux/rules-table.mjs';
import { releaseHeldQueue } from '../../delivery/queue-files.mjs';
import { canonicalRemote } from '../../repo/git.mjs';
import { normPath, pathHasPrefix } from '../../core/fs-paths.mjs';
import { listSessionFiles } from '../../sources/cli/session-files.mjs';
import { UserError, friendlyMessage } from '../../core/errors.mjs';
import { sessionFor } from '../../auth/recipients.mjs';
import { syncAccountIfNeeded } from '../../billing/account-sync.mjs';
import {
  hereLine, ruleAddedConfirmation, ruleLine, ruleRemovedConfirmation, ruleSetConfirmation, rulesAddedConfirmation, rulesHeaderLine,
  sendList, withUndoHint, workspaceLines, workspacesUnknownLine,
} from '../../ux/workspace-lines.mjs';
import { recordUndo, routingOf } from '../../state/rule-undo.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import {
  USAGE, afterRuleWrite, mayPersist, pastSessionOptions, parseSessionFlag, requireKnownWorkspaces, requireMulti, requireNoneForSingle,
  resolveAccount, selectedRows, selection, sessionCountsByKey,
} from './args.mjs';
import { displayPath } from '../../core/text.mjs';

const NOT_LINKED = 'Beezi: this machine is not linked. Run /beezi-local-login to link an account.';
const TARGET_FLAGS = ['--current', '--repo', '--folder', '--outside'];

function homeDir() {
  return normPath(os.homedir());
}

// `/`, a drive root, home or a folder above it (e.g. /Users): a folder rule there would catch every session.
function isHomeOrRoot(p) {
  const home = homeDir();
  return p === '/' || /^[a-z]:\/?$/i.test(p) || (home != null && pathHasPrefix(home, p));
}

// The tenant-scoped check-in a session holds back until it knows where it sends.
export async function checkIn(row, tenantId) {
  try {
    const live = await sessionFor(row.key);
    if (live == null) return;
    await syncAccountIfNeeded({ ...live, tenantId }, { force: true, via: 'workspace' });
  } catch (error) {
    console.error(`Beezi: workspace check-in skipped (${friendlyMessage(error)}).`);
  }
}

// Binds open sessions whose directory now routes to one of `indices`: the current one always, others when unbound or bound to that rule.
// Each bound session's held reports are released, and each workspace it newly sends to gets one check-in.
export async function bindOpenSessions(row, indices, current, ctx) {
  const checkedIn = [];
  const target = (dir) => {
    const route = dir == null ? null : routeForDir(row, dir, ctx);
    return route != null && indices.indexOf(route.index) !== -1 ? route : null;
  };
  const bind = async (sid, prior, route, dir) => {
    const before = resolveTargets(row, prior).targets;
    // Records the directory too, so a session with no state yet can be found by folder later.
    initSessionWorkspace(sid, { cwd: dir, routes: { [row.key]: route } });
    releaseHeldQueue(row, sid);
    for (const id of resolveTargets(row, readSessionWorkspace(sid)).targets) {
      if (before.indexOf(id) !== -1 || checkedIn.indexOf(id) !== -1) continue;
      checkedIn.push(id);
      await checkIn(row, id);
    }
  };
  if (current.sessionId != null) {
    const dir = choiceDir(current.state);
    const route = target(dir);
    if (route != null) await bind(current.sessionId, current.state, route, dir);
  }
  for (const entry of listSessionWorkspaces()) {
    if (entry.sessionId === current.sessionId) continue;
    const route = target(entry.state.cwd);
    if (route == null) continue;
    const bound = entry.state.route[row.key];
    if (bound != null && (bound.kind !== route.kind || bound.match !== route.match)) continue;
    await bind(entry.sessionId, entry.state, route, entry.state.cwd);
  }
}

// Prints a write's confirmation as the first stdout line (the undo hint unless the flow defers) and records it as the change undo reverts.
// `before` is routingOf the raw row read before the write and `fresh` the raw row after it, so restoreRouting compares like with like.
export function confirmChange(fresh, confirmation, before, cx) {
  console.log(withUndoHint(confirmation.line, cx.deferUpload));
  recordUndo({ account: fresh.key, summary: confirmation.summary, change: confirmation.change, was: confirmation.was, before, after: routingOf(fresh) });
}

// Sessions bound to a rule that is gone would keep sending by it: re-bind each to whatever still applies (none unbinds to New folders).
// On a multi-workspace account each one's held reports are released and workspaces it newly reaches check in once.
export async function rerouteGone(fresh, gone, ctx) {
  const checkedIn = [];
  for (const entry of listSessionWorkspaces()) {
    const bound = entry.state.route[fresh.key];
    if (bound == null || !gone.some((r) => r.kind === bound.kind && r.match === bound.match)) continue;
    const prior = resolveTargets(fresh, entry.state).targets;
    recordSessionRoute(entry.sessionId, fresh.key, routeForDir(fresh, entry.state.cwd, ctx));
    if (!isMultiTenant(fresh)) continue;
    releaseHeldQueue(fresh, entry.sessionId);
    for (const id of resolveTargets(fresh, readSessionWorkspace(entry.sessionId)).targets) {
      if (prior.indexOf(id) !== -1 || checkedIn.indexOf(id) !== -1) continue;
      checkedIn.push(id);
      await checkIn(fresh, id);
    }
  }
}

export async function rules(argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(afterSession);
  const table = afterAccount.indexOf('--table') !== -1;
  const rest = afterAccount.filter((a) => a !== '--table');
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  if (rows.length === 0) {
    console.log(NOT_LINKED);
    return;
  }
  const current = resolveSession(session);
  const dir = choiceDir(current.state);
  const ctx = createRouteContext();
  if (table) {
    const countsByKey = await sessionCountsByKey(rows, ctx, current.sessionId);
    console.log(rulesTableLines(rows, dir, ctx, { countsByKey }).join('\n'));
    return;
  }
  for (const row of rows) {
    const tenants = tenantsOf(row);
    if (tenants == null || tenants.length === 0) {
      console.log(workspacesUnknownLine(row));
      continue;
    }
    // A one-workspace account's rules only stop or keep tracking, so they say tracked instead of naming the workspace.
    const single = isSingleTenant(row);
    const stored = rulesOf(row);
    console.log(rulesHeaderLine(row, stored.length, single));
    if (!single) for (const line of workspaceLines(row)) console.log(line);
    for (const r of stored) {
      const tracked = r.tenantIds.length === 0 ? 'not tracked' : 'tracked';
      console.log(ruleLine(row, r, single ? tracked : sendList(row, r.tenantIds)));
    }
    console.log(hereLine(row, dir, ctx));
  }
}

// The rule's key from --current (the session's directory; home, / and temp give `outside`), --repo, --folder or --outside.
export function ruleKey(target, dir, ctx) {
  if (target.flag === '--outside') return outsideKey();
  if (target.flag === '--current') {
    const key = routeKeyForDir(dir, ctx);
    if (key == null) throw new UserError('No folder is known for this session. Pass --repo <url>, --folder <path> or --outside.');
    return key;
  }
  if (target.flag === '--repo') {
    const canon = canonicalRemote(target.value);
    if (canon == null) throw new UserError(`"${target.value}" is not a repository remote URL.`);
    return { kind: 'repo', match: canon, label: canon };
  }
  const raw = target.value === '~' || target.value.indexOf('~/') === 0 ? path.join(os.homedir(), target.value.slice(1)) : target.value;
  const folder = normPath(path.resolve(raw));
  if (folder == null || isHomeOrRoot(folder)) {
    throw new UserError('A folder rule can\'t be your home folder, a folder above it, or /: it would catch every session. Use --outside for sessions there.');
  }
  return { kind: 'folder', match: folder, label: displayPath(folder, homeDir()) };
}

function findRule(row, ref) {
  const n = Number(String(ref).replace(/^R/i, ''));
  const found = rulesOf(row).find((r) => r.index === n);
  if (found == null) throw new UserError(`There is no rule ${ref}. Run /beezi-local-settings rules to list them.`);
  return found;
}

// One of TARGET_FLAGS (with its value, null when absent) and the workspace refs around it; each caller checks both.
export function parseRuleTarget(rest) {
  let target = null;
  const refs = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (TARGET_FLAGS.indexOf(arg) === -1) {
      refs.push(arg);
      continue;
    }
    if (target != null) throw new UserError('Pass only one of --current, --repo <url>, --folder <path> or --outside.');
    const bare = arg === '--current' || arg === '--outside';
    const value = bare ? null : rest[++i];
    if (!bare && (value == null || value.trim() === '')) throw new UserError(`${arg} needs a value.`);
    target = { flag: arg, value };
  }
  return { target, refs };
}

async function ruleAdd(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const { target, refs } = parseRuleTarget(rest);
  if (target == null || refs.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  requireNoneForSingle(row, refs);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const key = ruleKey(target, choiceDir(current.state), ctx);
  const tenantIds = selection(row, refs);
  if (!(await mayPersist('saving a workspace rule', current.sessionId))) return;
  const before = routingOf(row);
  const n = (await setWorkspaceRule(row.key, { kind: key.kind, match: key.match, label: key.label, tenantIds })).index;
  const fresh = await resolveAccount(row.key);
  confirmChange(fresh, ruleAddedConfirmation(row, key, tenantIds, n), before, cx);
  await bindOpenSessions(fresh, [n], current, ctx);
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['rule', n]]));
}

async function ruleSet(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length < 2) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  const found = findRule(row, rest[0]);
  requireNoneForSingle(row, rest.slice(1));
  const tenantIds = selection(row, rest.slice(1));
  const current = resolveSession(session);
  if (!(await mayPersist('saving a workspace rule', current.sessionId))) return;
  const before = routingOf(row);
  await setWorkspaceRule(row.key, { kind: found.kind, match: found.match, label: found.label, tenantIds });
  const fresh = await resolveAccount(row.key);
  confirmChange(fresh, ruleSetConfirmation(row, found, tenantIds), before, cx);
  await bindOpenSessions(fresh, [found.index], current, createRouteContext());
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['rule', found.index]]));
}

async function ruleRemove(argv, cx = { deferUpload: false }) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  if (!(await mayPersist('removing a workspace rule'))) return;
  const before = routingOf(row);
  const removed = await removeWorkspaceRule(row.key, String(rest[0]).replace(/^R/i, ''));
  const fresh = await resolveAccount(row.key);
  confirmChange(fresh, ruleRemovedConfirmation(row, removed), before, cx);
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['removed', removed.index]]));
  await rerouteGone(fresh, [removed], createRouteContext());
}

// One rule per repo or folder that `routes` lists, all sending to the same workspaces.
async function ruleAddAll(argv, cx = { deferUpload: false }) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const tenantIds = selection(row, rest);
  const current = resolveSession(session);
  const ctx = createRouteContext();
  const groups = planUnruledRoutes(row, await listSessionFiles(), ctx, pastSessionOptions(current.sessionId));
  if (groups.length > 0 && !(await mayPersist('saving a workspace rule', current.sessionId))) return;
  const before = routingOf(row);
  const added = [];
  for (const g of groups) {
    added.push((await setWorkspaceRule(row.key, { kind: g.kind, match: g.match, label: g.label, tenantIds })).index);
  }
  const n = added.length;
  if (n === 0) {
    console.log('✓ No repos or folders are waiting for a rule.');
  } else {
    const fresh = await resolveAccount(row.key);
    confirmChange(fresh, rulesAddedConfirmation(row, n, tenantIds), before, cx);
    await bindOpenSessions(fresh, added, current, ctx);
  }
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['rules-added', n]]));
}

export async function rule(argv, cx = { deferUpload: false }) {
  const [sub, ...rest] = argv;
  if (sub === 'add') { await ruleAdd(rest, cx); return; }
  if (sub === 'set') { await ruleSet(rest, cx); return; }
  if (sub === 'remove') { await ruleRemove(rest, cx); return; }
  if (sub === 'add-all') { await ruleAddAll(rest, cx); return; }
  throw new UserError(USAGE);
}

