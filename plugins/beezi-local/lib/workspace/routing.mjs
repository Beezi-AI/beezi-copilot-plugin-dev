// Live routing: the rule a directory follows, and binding those rules onto a session's workspace file.
import { normPath, pathHasPrefix } from '../core/fs-paths.mjs';
import { rulesOf, usesRules } from './rule-model.mjs';
import { tenantsOf } from './tenants.mjs';
import { createRouteContext, isUnsafeKeyPath, mainTreePath, routeKeyForDir } from './route-key.mjs';
import { initSessionWorkspace } from './session-routes.mjs';

// The rule this directory follows: the repo rule for its remote, else the longest folder prefix, else (home or above, /, temp or app chats only) the outside rule; tenantIds limited to current workspaces.
export function routeForDir(row, dir, ctx) {
  const rules = rulesOf(row);
  const tenants = tenantsOf(row);
  if (rules.length === 0 || tenants == null || tenants.length === 0) return null;
  const d = normPath(dir);
  if (d == null) return null;
  const members = tenants.map((t) => t.id);
  // A rule whose workspaces the account has all left is skipped; one stored with [] still matches.
  const usable = (rule) => {
    const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
    return rule.tenantIds.length === 0 || ids.length > 0 ? ids : null;
  };
  const toRoute = (rule, ids) => ({ index: rule.index, kind: rule.kind, match: rule.match, label: rule.label, tenantIds: ids });
  const repoRules = rules.filter((r) => r.kind === 'repo');
  if (repoRules.length > 0) {
    const key = routeKeyForDir(d, ctx);
    if (key != null && key.kind === 'repo') {
      for (const rule of repoRules) {
        if (rule.match.toLowerCase() !== key.match) continue;
        const ids = usable(rule);
        if (ids != null) return toRoute(rule, ids);
      }
    }
  }
  // A linked worktree also matches the folder rules of its main repo's path.
  const folderRules = rules.filter((r) => r.kind === 'folder');
  const main = folderRules.length > 0 ? mainTreePath(d, ctx) : null;
  const folders = folderRules
    .filter((r) => pathHasPrefix(d, r.match) || (main != null && pathHasPrefix(main, r.match)))
    .sort((a, b) => normPath(b.match).length - normPath(a.match).length);
  for (const rule of folders) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  // Never a catch-all: only directories no repo or folder rule could key reach it.
  if (!isUnsafeKeyPath(d)) return null;
  for (const rule of rules.filter((r) => r.kind === 'outside')) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  return null;
}

// Binds each row whose rules can route (null unbinds) for cwd on the session and records cwd; the saved state, or null when none qualify.
// Rebinds on every call so a removed rule unbinds, and always writes so the session stays the newest for its cwd.
// A state write that fails gives null: this runs on hook paths, which never throw.
export function bindSessionRoutes(sessionId, cwd, rows, ctx) {
  try {
    const context = ctx == null ? createRouteContext() : ctx;
    const routes = {};
    let any = false;
    for (const row of rows) {
      if (!usesRules(row)) continue;
      any = true;
      routes[row.key] = routeForDir(row, cwd, context);
    }
    if (!any) return null;
    return initSessionWorkspace(sessionId, { cwd, routes });
  } catch {
    return null;
  }
}
