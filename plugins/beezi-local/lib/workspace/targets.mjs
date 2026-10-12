// Where an account's analytics go: New folders, the session's write targets and its read workspace.
import { accountRowFor, tenantsOf } from './tenants.mjs';
import { normalizeRoute } from './session-routes.mjs';
import { rulesOf } from './rule-model.mjs';
import { objectOr, stringIds } from '../core/guards.mjs';

const NEW_FOLDER_MODES = ['ask', 'send', 'none'];

// Where repos and folders with no rule send: {mode, tenantIds (send only, row order), set}; a send to no current workspace asks instead.
export function newFoldersOf(row) {
  const account = accountRowFor(row);
  const raw = account.newFolders;
  const set = raw != null && typeof raw === 'object' && NEW_FOLDER_MODES.indexOf(raw.mode) !== -1;
  if (!set || raw.mode !== 'send') return { mode: set ? raw.mode : 'ask', tenantIds: [], set };
  const picked = stringIds(raw.tenantIds) || [];
  const tenantIds = (tenantsOf(account) || []).map((t) => t.id).filter((id) => picked.indexOf(id) !== -1);
  return { mode: tenantIds.length > 0 ? 'send' : 'ask', tenantIds, set };
}

// Where an account's analytics go this session: its bound rule, else New folders; one or unknown workspaces → [null] (no header).
// row.tenantId / tenantName describe the web-side workspace and are never read here.
export function resolveTargets(row, state) {
  const account = accountRowFor(row);
  if (account.unlinked === true) {
    return { tenants: [], multi: false, targets: [], pendingAsk: false, askTenants: [], rule: null, source: 'unlinked' };
  }
  const tenants = tenantsOf(account);
  if (tenants == null || tenants.length < 2) {
    if (tenants != null && tenants.length === 1) {
      const bound = normalizeRoute(objectOr(objectOr(state).route)[account.key]);
      // A bound [] route excludes only while its rule is still stored; any outside rule matches a bound outside route.
      const stillStored = bound != null && bound.tenantIds.length === 0
        && rulesOf(account).some((r) => r.kind === bound.kind && (r.kind === 'outside' || r.match === bound.match) && r.tenantIds.length === 0);
      if (stillStored) {
        const rule = { kind: bound.kind, match: bound.match, label: bound.label };
        return { tenants, multi: false, targets: [], pendingAsk: false, askTenants: [], rule, source: 'rule' };
      }
    }
    return { tenants, multi: false, targets: [null], pendingAsk: false, askTenants: [], rule: null, source: 'single' };
  }
  const members = tenants.map((t) => t.id);
  const bound = normalizeRoute(objectOr(objectOr(state).route)[account.key]);
  if (bound != null) {
    // Intersected with current membership: a workspace the account has left is never a target.
    const targets = members.filter((id) => bound.tenantIds.indexOf(id) !== -1);
    const rule = { kind: bound.kind, match: bound.match, label: bound.label };
    return { tenants, multi: true, targets, pendingAsk: false, askTenants: [], rule, source: 'rule' };
  }
  const newFolders = newFoldersOf(account);
  if (newFolders.mode === 'send') {
    return { tenants, multi: true, targets: newFolders.tenantIds, pendingAsk: false, askTenants: [], rule: null, source: 'new-folders' };
  }
  if (newFolders.mode === 'none') {
    return { tenants, multi: true, targets: [], pendingAsk: false, askTenants: [], rule: null, source: 'none' };
  }
  // Held for an answer that may pick any workspace.
  return { tenants, multi: true, targets: [], pendingAsk: true, askTenants: members, rule: null, source: 'pending' };
}

// The one workspace reads (MCP, status) go to: null for one or unknown workspaces, else the session's pick, its first target, the New folders default, or the first workspace.
// Never decides a write.
export function resolveReadTenant(row, state) {
  const account = accountRowFor(row);
  const tenants = tenantsOf(account);
  if (tenants == null || tenants.length === 0) return { tenantId: null, source: null };
  if (tenants.length === 1) return { tenantId: null, source: 'single' };
  const picked = state == null ? null : objectOr(state.read)[account.key];
  if (picked != null && tenants.some((t) => t.id === picked)) return { tenantId: picked, source: 'read' };
  const targets = resolveTargets(account, state).targets;
  if (targets.length > 0) return { tenantId: targets[0], source: 'target' };
  const newFolders = newFoldersOf(account).tenantIds;
  if (newFolders.length > 0) return { tenantId: newFolders[0], source: 'new-folders' };
  return { tenantId: tenants[0].id, source: 'first' };
}

// One clone per target; stateOrFn is a session state or fn(session) → state. A preset tenantId is kept as is.
// A multi-workspace account with no target yields no clone: there is never a headerless fallback.
export function expandTargets(sessions, stateOrFn) {
  const out = [];
  for (const s of sessions || []) {
    if (s == null) continue;
    if (s.tenantId != null) { out.push(s); continue; }
    const state = typeof stateOrFn === 'function' ? stateOrFn(s) : stateOrFn;
    for (const tenantId of resolveTargets(s, state).targets) out.push({ ...s, tenantId });
  }
  return out;
}
