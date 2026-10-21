// Route wording every screen shares: where a directory is, where its analytics go and why, and rule session counts.
import os from 'os';
import { normPath } from '../core/fs-paths.mjs';
import { displayPath } from '../core/text.mjs';
import { resolveRepoForRouting } from '../repo/repo-map.mjs';
import { createRouteContext, routeKeyForDir } from './route-key.mjs';
import { routeForDir } from './routing.mjs';
import { ruleReasonText, rulesOf, shortLabel } from './rule-model.mjs';
import { newFoldersOf, resolveTargets } from './targets.mjs';
import { isMultiTenant, joinTenantNames, tenantsOf } from './tenants.mjs';

// Where a directory is, as every screen names it: { key, short, kind, path, remote }; null without a directory.
// `path` is the repo root or folder (~ for home), `remote` the repo's canonical remote; both null outside a project.
export function placeOfDir(dir, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const key = routeKeyForDir(dir, context);
  if (key == null) return null;
  const place = { key, short: shortLabel(key), kind: key.kind, path: null, remote: null };
  if (key.kind === 'folder') place.path = key.label;
  if (key.kind === 'repo') {
    const found = resolveRepoForRouting(dir, context.map());
    place.path = found.root == null ? null : displayPath(normPath(found.root), normPath(os.homedir()));
    place.remote = key.match;
  }
  return place;
}

// "a git repo", "a folder" or null (outside a project), for "labacus-suite, a git repo".
export function kindWords(place) {
  if (place == null) return null;
  if (place.kind === 'repo') return 'a git repo';
  return place.kind === 'folder' ? 'a folder' : null;
}

// Whether two places or rules name the same place: repo remotes ignore case, folders compare normalized paths.
export function samePlace(a, b) {
  if (a == null || b == null || a.kind !== b.kind) return false;
  if (a.kind === 'outside') return true;
  if (a.kind === 'repo') return String(a.match).toLowerCase() === String(b.match).toLowerCase();
  return normPath(a.match) === normPath(b.match);
}

// The route of a place with no rule of its own: the one workspace, else New folders (send, don't send, or ask).
export function defaultRoute(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) return { ids: [], reason: { kind: 'unknown' } };
  if (!isMultiTenant(row)) return { ids: [tenants[0].id], reason: { kind: 'default' } };
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return { ids: newFolders.tenantIds, reason: { kind: 'default' } };
  if (newFolders.mode === 'none') return { ids: [], reason: { kind: 'default' } };
  return { ids: [], reason: { kind: 'pending' } };
}

// Where a directory's analytics go under the stored rules: { ids, reason }.
// reason: { kind: 'rule', index, own, short } (own: the rule is for this very place, not a parent folder),
// { kind: 'default' }, { kind: 'pending' } (Ask me, no rule yet) or { kind: 'unknown' } (workspaces not known).
export function routeOfDir(row, dir, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const rule = routeForDir(row, dir, context);
  if (rule == null) return defaultRoute(row);
  const key = routeKeyForDir(dir, context);
  return { ids: rule.tenantIds, reason: { kind: 'rule', index: rule.index, own: samePlace(rule, key), short: shortLabel(rule) } };
}

// Where a running session's analytics go, from the route bound to it; `place` (placeOfDir) tells whether a rule is its own.
export function routeOfSession(row, state, place = null) {
  const resolved = resolveTargets(row, state);
  if (resolved.source === 'rule') {
    const stored = rulesOf(row).find((r) => samePlace(r, resolved.rule));
    return {
      ids: resolved.targets,
      reason: {
        kind: 'rule',
        index: stored == null ? null : stored.index,
        own: place == null ? null : samePlace(resolved.rule, place.key),
        short: shortLabel(resolved.rule),
      },
    };
  }
  return defaultRoute(row);
}

// Where the analytics go, in words: "Acme and Northwind", "not tracked", "no rule yet".
export function routeTarget(row, route) {
  if (route.reason.kind === 'pending') return 'no rule yet';
  if (route.reason.kind === 'unknown') return 'workspaces not known yet';
  return route.ids.length === 0 ? 'not tracked' : joinTenantNames(row, route.ids);
}

// Why: "default", "rule R1", "rule R2 for scratch"; null when there is nothing to name.
export function routeReason(route) {
  const reason = route.reason;
  if (reason.kind === 'default') return 'default';
  if (reason.kind !== 'rule') return null;
  return ruleReasonText(reason.index, reason.own, reason.short);
}

// "→ Acme (default)", "→ not tracked (rule R1)", "→ Acme and Northwind (rule R2 for scratch)", "→ no rule yet".
export function routeText(row, route) {
  const why = routeReason(route);
  return `→ ${routeTarget(row, route)}${why == null ? '' : ` (${why})`}`;
}

// Recent sessions per place ({ kind, match, sessions }): { rules: Map<index, n>, default: n }; a place equal to a stored rule counts for it, the rest for Default.
export function ruleSessionCounts(row, places) {
  const stored = rulesOf(row);
  const counts = { rules: new Map(stored.map((r) => [r.index, 0])), default: 0 };
  for (const place of places) {
    const rule = stored.find((r) => samePlace(r, place));
    if (rule == null) counts.default += place.sessions;
    else counts.rules.set(rule.index, counts.rules.get(rule.index) + place.sessions);
  }
  return counts;
}
