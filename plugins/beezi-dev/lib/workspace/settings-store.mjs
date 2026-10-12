// Owns the per-account workspace settings stored on index rows: New folders, routing rules and reviewed/noticed ids.
import { mutateRow } from '../accounts/index-store.mjs';
import { rulesOf, outsideKey } from './rule-model.mjs';
import { UserError } from '../core/errors.mjs';

// Where repos and folders with no rule send: ask, send (to tenantIds) or none; returns the stored value.
export function setNewFolders(key, { mode, tenantIds = [] } = {}, deps = {}) {
  if (mode !== 'ask' && mode !== 'send' && mode !== 'none') {
    return Promise.reject(new UserError(`Unknown New folders setting "${mode}". Use ask, send or none.`));
  }
  const ids = Array.isArray(tenantIds) ? tenantIds.filter((id) => typeof id === 'string' && id !== '') : [];
  if (mode === 'send' && ids.length === 0) return Promise.reject(new UserError('Sending needs at least one workspace.'));
  return mutateRow(key, (row) => {
    row.newFolders = { mode, tenantIds: mode === 'send' ? ids : [] };
    return row.newFolders;
  }, deps);
}

// Adds ids to one of the row's id lists; a known workspace list prunes both id lists to its members.
function addTenantIds(key, field, ids, deps) {
  return mutateRow(key, (row) => {
    const stored = Array.isArray(row[field]) ? row[field].filter((id) => typeof id === 'string') : [];
    row[field] = stored.concat(ids.filter((id) => typeof id === 'string' && stored.indexOf(id) === -1));
    if (Array.isArray(row.tenants)) {
      const members = row.tenants.filter((t) => t != null && typeof t.id === 'string').map((t) => t.id);
      for (const list of ['reviewedTenantIds', 'joinNoticedTenantIds']) {
        if (Array.isArray(row[list])) row[list] = row[list].filter((id) => members.indexOf(id) !== -1);
      }
    }
    return row[field];
  }, deps);
}

// Workspaces whose re-pick pass finished on this machine (workspace joined done / add-all).
export function markTenantsReviewed(key, ids, deps = {}) {
  return addTenantIds(key, 'reviewedTenantIds', ids, deps);
}

// Workspaces the session-start notice already announced on this machine.
export function markJoinNoticed(key, ids, deps = {}) {
  return addTenantIds(key, 'joinNoticedTenantIds', ids, deps);
}

// Adds a routing rule, or replaces the tenantIds of the one with the same kind and match in place; returns its 1-based number.
export function setWorkspaceRule(key, { kind, match, label = null, tenantIds } = {}, deps = {}) {
  if (kind !== 'repo' && kind !== 'folder' && kind !== 'outside') {
    return Promise.reject(new UserError(`Unknown rule kind "${kind}". Use repo, folder or outside.`));
  }
  // One outside rule per account, whatever match the caller passed.
  if (kind === 'outside') ({ match, label } = outsideKey());
  if (typeof match !== 'string' || match === '') return Promise.reject(new UserError('A rule needs a repository or folder to match.'));
  if (!Array.isArray(tenantIds) || tenantIds.some((id) => typeof id !== 'string' || id === '')) {
    return Promise.reject(new UserError('A rule needs a list of workspace ids (none sends nowhere).'));
  }
  return mutateRow(key, (row) => {
    const stored = Array.isArray(row.workspaceRules) ? row.workspaceRules.slice() : [];
    const existing = rulesOf({ workspaceRules: stored }).find((r) => r.kind === kind && r.match === match);
    const rule = {
      kind,
      match,
      label: typeof label === 'string' && label !== '' ? label : match,
      tenantIds: tenantIds.slice(),
      createdAt: existing != null && existing.createdAt != null ? existing.createdAt : new Date().toISOString(),
    };
    let n;
    if (existing != null) {
      stored[existing.index - 1] = rule;
      n = existing.index;
    } else {
      stored.push(rule);
      n = stored.length;
    }
    row.workspaceRules = stored;
    return { index: n, rule };
  }, deps);
}

// Removes rule number n (1-based, as rulesOf numbers it); returns the removed rule.
export function removeWorkspaceRule(key, n, deps = {}) {
  return mutateRow(key, (row) => {
    const position = Number(n);
    const found = Number.isInteger(position) ? rulesOf(row).find((r) => r.index === position) : null;
    if (found == null) throw new UserError(`There is no rule ${n}. Run /beezi-dev-settings rules to list them.`);
    row.workspaceRules.splice(position - 1, 1);
    return found;
  }, deps);
}
