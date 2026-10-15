// workspace.mjs rules and rule add|set|remove|add-all: list, write and remove workspace rules, then re-bind open sessions.
import os from 'os';
import path from 'path';
import { parseAccountFlag } from '../../accounts/index-store.mjs';
import { removeWorkspaceRule, setWorkspaceRule } from '../../workspace/settings-store.mjs';
import { initSessionWorkspace, listSessionWorkspaces, readSessionWorkspace, recordSessionRoute } from '../../workspace/session-routes.mjs';
import { isSingleTenant, tenantsOf } from '../../workspace/tenants.mjs';
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
  hereLine, newFoldersLabel, placeOf, ruleDone, ruleLine, rulesHeaderLine, sendList, tenantNames, workspaceLines,
  workspacesUnknownLine,
} from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import {
  USAGE, afterRuleWrite, choiceDir, mayPersist, pastSessionOptions, parseSessionFlag, requireKnownWorkspaces, requireMulti, requireNoneForSingle,
  resolveAccount, resolveSession, selectedRows, selection,
} from './args.mjs';
import { displayPath, plural } from '../../core/text.mjs';

const NOT_LINKED = 'Beezi: this machine is not linked. Run /beezi-dev-login to link an account.';
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
  const dir = choiceDir(resolveSession(session).state);
  const ctx = createRouteContext();
  if (table) {
    console.log(rulesTableLines(rows, dir, ctx).join('\n'));
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
    const key = routeKeyForDir(dir, ctx);
    console.log(hereLine(row, key, key == null ? null : routeForDir(row, dir, ctx)));
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
  if (found == null) throw new UserError(`There is no rule ${ref}. Run /beezi-dev-settings rules to list them.`);
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
  const n = (await setWorkspaceRule(row.key, { kind: key.kind, match: key.match, label: key.label, tenantIds })).index;
  console.log(ruleDone(row, key, tenantIds, false));
  await bindOpenSessions(await resolveAccount(row.key), [n], current, ctx);
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
  await setWorkspaceRule(row.key, { kind: found.kind, match: found.match, label: found.label, tenantIds });
  console.log(ruleDone(row, found, tenantIds, true));
  await bindOpenSessions(await resolveAccount(row.key), [found.index], current, createRouteContext());
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['rule', found.index]]));
}

async function ruleRemove(argv, cx = { deferUpload: false }) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  if (!(await mayPersist('removing a workspace rule'))) return;
  const removed = await removeWorkspaceRule(row.key, String(rest[0]).replace(/^R/i, ''));
  if (isSingleTenant(row)) {
    console.log(`✓ Removed the rule for ${placeOf(removed)}. Beezi tracks it again unless another rule covers it.`);
  } else {
    console.log(`✓ Removed the rule for ${placeOf(removed)}. New sessions there follow New folders (${newFoldersLabel(row)}).`);
  }
  await afterRuleWrite(row.key, cx, cx.deps);
  console.log(machineLine([['removed', removed.index]]));
  // Sessions bound to the removed rule keep their state until something re-binds them: re-route each to whatever still applies.
  if (isSingleTenant(row)) {
    const fresh = await resolveAccount(row.key);
    const ctx = createRouteContext();
    for (const entry of listSessionWorkspaces()) {
      const bound = entry.state.route[row.key];
      if (bound == null || bound.kind !== removed.kind || bound.match !== removed.match) continue;
      recordSessionRoute(entry.sessionId, row.key, routeForDir(fresh, entry.state.cwd, ctx));
    }
  }
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
  const added = [];
  for (const g of groups) {
    added.push((await setWorkspaceRule(row.key, { kind: g.kind, match: g.match, label: g.label, tenantIds })).index);
  }
  const n = added.length;
  if (n === 0) {
    console.log('✓ No repos or folders are waiting for a rule.');
  } else {
    const those = n === 1 ? 'that repo or folder' : 'those repos and folders';
    const where = tenantIds.length === 0 ? `${those} ${n === 1 ? 'is' : 'are'} not tracked` : `analytics for ${those} go to ${tenantNames(row, tenantIds)}`;
    console.log(`✓ Added ${plural(n, 'rule')}: ${where}.`);
    await bindOpenSessions(await resolveAccount(row.key), added, current, ctx);
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

