// The stored workspace-rule model: rule normalization, the outside key and short rule names.
import { isMultiTenant, isSingleTenant } from './tenants.mjs';
import { stringIds } from '../core/guards.mjs';

const OUTSIDE_LABEL = 'outside a project';
// A match or label holding a control character could forge a machine line.
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// The key of every home (or above), /, temp or Copilot app chat directory: one askable place with its own rule.
export function outsideKey() {
  return { kind: 'outside', match: 'outside', label: OUTSIDE_LABEL };
}

function normalizeRule(raw, index) {
  if (raw == null || typeof raw !== 'object') return null;
  if (raw.kind === 'outside') {
    const ids = stringIds(raw.tenantIds);
    if (ids == null) return null;
    return { index, ...outsideKey(), tenantIds: ids, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null };
  }
  if ((raw.kind !== 'repo' && raw.kind !== 'folder') || typeof raw.match !== 'string' || raw.match === '') return null;
  const tenantIds = stringIds(raw.tenantIds);
  if (tenantIds == null) return null;
  return {
    index,
    kind: raw.kind,
    match: raw.match,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.match,
    tenantIds,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

// The account's rules; `index` is the 1-based position in the stored list, so dropped entries leave gaps.
export function rulesOf(row) {
  if (row == null || !Array.isArray(row.workspaceRules)) return [];
  const out = [];
  row.workspaceRules.forEach((raw, i) => {
    const rule = normalizeRule(raw, i + 1);
    if (rule != null) out.push(rule);
  });
  return out;
}

// Whether a row's rules can route anything: always for multi-workspace, else only with at least one rule.
export function usesRules(row) {
  return isMultiTenant(row) || (isSingleTenant(row) && rulesOf(row).length > 0);
}

// A rule's short name: a repo's last path segment, a folder's basename, or "outside a project".
export function shortLabel(rule) {
  if (rule == null) return '';
  if (rule.kind === 'outside') return OUTSIDE_LABEL;
  const match = typeof rule.match === 'string' ? rule.match : '';
  const parts = match.replace(/\\/g, '/').split('/').filter((p) => p !== '');
  if (parts.length > 0) return parts[parts.length - 1];
  return typeof rule.label === 'string' && rule.label !== '' ? rule.label : match;
}

// Whether a place's match and label are safe to print on a machine line (no control character).
export function isLineSafePlace(place) {
  return place != null && !UNSAFE_LINE.test(String(place.match)) && !UNSAFE_LINE.test(String(place.label));
}
