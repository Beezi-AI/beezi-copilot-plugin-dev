// The account row's workspace (tenant) model: membership, roles, join baselines and the row routing reads.
import { accountsIndexFile } from '../config/paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { joinNames } from '../core/text.mjs';

// The account row's workspace list; null means unknown (old server or never probed).
export function tenantsOf(row) {
  if (row == null || !Array.isArray(row.tenants)) return null;
  return row.tenants.filter((t) => t && typeof t.id === 'string' && t.id !== '');
}

// One linked row from the accounts index, read synchronously; null unless it exists and is linked.
// The index file is read directly: accounts/index-store.mjs has only an async reader, and routing runs synchronously.
export function linkedRowByKey(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{8}$/.test(key)) return null;
  const raw = readJson(accountsIndexFile(), null);
  if (raw == null || raw.version !== 1 || !Array.isArray(raw.accounts)) return null;
  const row = raw.accounts.find((a) => a != null && a.key === key);
  return row != null && row.status === 'linked' ? row : null;
}

// A row that resolves to no targets at all, for a key that is missing or no longer linked.
function unlinkedRow(key) {
  return { key: typeof key === 'string' ? key : null, unlinked: true, tenants: [], newFolders: null, workspaceRules: [] };
}

// The account row whose workspace fields decide routing. A row or a session built with workspace fields
// is used as is; one without a `tenants` property is a caller bug, so its row is re-read from the index
// and a missing or not-linked account gets no targets rather than a headerless write.
export function accountRowFor(rowOrSession) {
  const given = rowOrSession != null && typeof rowOrSession === 'object' ? rowOrSession : null;
  if (given != null && given.tenants !== undefined) return given;
  const key = given == null ? null : given.key;
  const row = linkedRowByKey(key);
  return row != null ? row : unlinkedRow(key);
}

export function isMultiTenant(row) {
  const tenants = tenantsOf(accountRowFor(row));
  return tenants != null && tenants.length > 1;
}

export function isSingleTenant(row) {
  const tenants = tenantsOf(accountRowFor(row));
  return tenants != null && tenants.length === 1;
}

export function tenantById(row, id) {
  const tenants = tenantsOf(row);
  if (tenants == null || id == null) return null;
  const found = tenants.find((t) => t.id === id);
  return found == null ? null : found;
}

const ANALYTICS_ROLE_LABELS = { 'Tenant Owner': 'Owner', Admin: 'Admin', 'Project Admin': 'Supervisor', User: 'User' };

// The role as the web shows it: analytics workspaces rename their roles, others only the owner.
export function roleLabel(t) {
  if (t == null || typeof t.role !== 'string' || t.role === '') return '';
  if (t.type === 'analytics' && Object.prototype.hasOwnProperty.call(ANALYTICS_ROLE_LABELS, t.role)) return ANALYTICS_ROLE_LABELS[t.role];
  return t.role === 'Tenant Owner' ? 'Owner' : t.role;
}

// When this account started on this machine: its link time, else its first refresh; null when neither is known.
export function reviewBaselineMs(row) {
  if (row == null) return null;
  for (const at of [row.linkedAt, row.reviewBaselineAt]) {
    const ms = typeof at === 'string' ? Date.parse(at) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Workspaces whose membership began after the baseline (whoami joinedAt); [] for one or unknown workspaces.
export function joinedAfterLink(row) {
  if (!isMultiTenant(row)) return [];
  const baseline = reviewBaselineMs(row);
  if (baseline == null) return [];
  return tenantsOf(row).filter((t) => {
    const ms = typeof t.joinedAt === 'string' ? Date.parse(t.joinedAt) : NaN;
    return Number.isFinite(ms) && ms > baseline;
  }).map((t) => t.id);
}

// Joined after the baseline and not yet through the re-pick pass here.
export function newTenantsOf(row) {
  const reviewed = row != null && Array.isArray(row.reviewedTenantIds) ? row.reviewedTenantIds : [];
  return joinedAfterLink(row).filter((id) => reviewed.indexOf(id) === -1);
}

// Workspace names for a sentence: "A", "A and B", "A, B and C".
export function joinTenantNames(row, ids) {
  const names = ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  });
  return joinNames(names);
}
