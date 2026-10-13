// Past-session routing: where each past session sends today, which are waiting for a rule, and the re-pick places.
import { loadLedger, isImported } from '../state/ledger.mjs';
import { isMultiTenant, isSingleTenant, tenantsOf } from '../workspace/tenants.mjs';
import { rulesOf, usesRules } from '../workspace/rule-model.mjs';
import { createRouteContext, routeKeyForDir } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { newFoldersOf, resolveTargets } from '../workspace/targets.mjs';
import { ACTIVE_SESSION_WINDOW_MS } from './scan-limits.mjs';
import { MAX_TRANSCRIPT_BYTES } from '../contract/report-limits.mjs';

// The re-pick pass lists places with sessions from the last 30 days, as Codex's upload window does.
const REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// A past session's workspaces: the rule for its directory now, else New folders; source is 'single'|'rule'|'new-folders'|'none'|'pending'.
// `key` is the directory's route key when the account has rules and the directory is known, else null.
export function routePastSession(row, { state = null, readCwd = null } = {}, ctx) {
  if (!usesRules(row)) return { tenantIds: [null], source: 'single', pending: false, key: null };
  if (isSingleTenant(row)) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    const key = cwd == null ? null : routeKeyForDir(cwd, context);
    // A bound [] route stays honored while its rule is still stored, the same test resolveTargets uses.
    const bound = state != null && state.route ? state.route[row.key] : null;
    if (bound != null && Array.isArray(bound.tenantIds) && bound.tenantIds.length === 0
      && rulesOf(row).some((r) => r.kind === bound.kind && r.match === bound.match && r.tenantIds.length === 0)) {
      return { tenantIds: [], source: 'rule', pending: false, key };
    }
    const rule = routeForDir(row, cwd, context);
    if (rule != null && rule.tenantIds.length === 0) return { tenantIds: [], source: 'rule', pending: false, key };
    return { tenantIds: [null], source: 'single', pending: false, key: null };
  }
  let key = null;
  if (rulesOf(row).length > 0) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    key = cwd == null ? null : routeKeyForDir(cwd, context);
    const rule = routeForDir(row, cwd, context);
    if (rule != null) {
      const tenantIds = resolveTargets(row, { route: { [row.key]: rule } }).targets;
      return { tenantIds, source: 'rule', pending: false, key };
    }
  }
  const fallback = resolveTargets(row, null);
  return { tenantIds: fallback.targets, source: fallback.source, pending: fallback.pendingAsk, key };
}

function safeReadState(readState, sessionId) {
  try { return readState(sessionId); } catch { return null; }
}

// The recorded working directory comes only from readCwd(transcriptPath); no index means no directory.
const NO_CWD = () => null;

// sessionId → routePastSession result for every session-file entry ({ sessionId, transcriptPath, mtimeMs, size });
// readState(sessionId), readCwd(transcriptPath).
export function planSessionRoutes(row, entries, ctx, { readState = readSessionWorkspace, readCwd = NO_CWD } = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const needsState = usesRules(row);
  const routes = new Map();
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    const state = needsState ? safeReadState(readState, entry.sessionId) : null;
    const route = routePastSession(row, { sessionId: entry.sessionId, state, readCwd: () => readCwd(entry.transcriptPath) }, context);
    routes.set(entry.sessionId, route);
  }
  return routes;
}

// The one "waiting" test, shared by `routes` and the backfill seal hold so a pull is held only for what `routes` asks about: New folders is Ask me, settled, readable, pending, and in no workspace's ledger.
// Map<sessionId, key> plus `noDirectory` (waiting with no recorded directory); `routes` option reuses planSessionRoutes results.
export function waitingRoutes(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  loadLedgerImpl = loadLedger,
  readState = readSessionWorkspace,
  readCwd = NO_CWD,
  routes = null,
} = {}) {
  const waiting = new Map();
  waiting.noDirectory = 0;
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return waiting;
  const context = ctx == null ? createRouteContext() : ctx;
  const identity = row.clientId == null ? null : row.clientId;
  const ledgers = tenantsOf(row).map((t) => loadLedgerImpl(row.key, identity, t.id));
  const nowMs = typeof now === 'function' ? now() : now;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) continue;
    if (ledgers.some((ledger) => isImported(ledger, entry.sessionId))) continue;
    let cwd = null;
    let cwdRead = false;
    const cwdOnce = () => {
      if (!cwdRead) { cwdRead = true; cwd = readCwd(entry.transcriptPath); }
      return cwd;
    };
    let state;
    const stateOnce = () => {
      if (state === undefined) state = safeReadState(readState, entry.sessionId);
      return state;
    };
    const route = routes != null && routes.has(entry.sessionId)
      ? routes.get(entry.sessionId)
      : routePastSession(row, { sessionId: entry.sessionId, state: stateOnce(), readCwd: cwdOnce }, context);
    if (route.source !== 'pending') continue;
    let key = route.key;
    if (key == null) {
      const known = stateOnce();
      const dir = known != null && typeof known.cwd === 'string' && known.cwd !== '' ? known.cwd : cwdOnce();
      key = dir == null ? null : routeKeyForDir(dir, context);
    }
    if (key == null) { waiting.noDirectory += 1; continue; }
    waiting.set(entry.sessionId, key);
  }
  return waiting;
}

// Repos/folders (and `outside`) whose waiting past sessions (see waitingRoutes) have no rule, most sessions first.
// Returns [{kind, match, label, sessions (count)}]; the array's `noDirectory` counts sessions with no recorded directory.
export function planUnruledRoutes(row, entries, ctx, options = {}) {
  const waiting = waitingRoutes(row, entries, ctx, options);
  const groups = [];
  groups.noDirectory = waiting.noDirectory;
  const byKey = new Map();
  for (const key of waiting.values()) {
    const id = `${key.kind}\n${key.match}`;
    let group = byKey.get(id);
    if (group == null) {
      group = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, group);
      groups.push(group);
    }
    group.sessions += 1;
  }
  groups.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  return groups;
}

// The re-pick pass's places: the rule or rule-less place of every recent session (no ledger filter, most sessions first), then stored rules with none.
// Returns [{kind, match, label, sessions}].
export function planReviewPlaces(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  readState = readSessionWorkspace,
  readCwd = NO_CWD,
} = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const nowMs = typeof now === 'function' ? now() : now;
  const places = [];
  const byKey = new Map();
  const add = (key, n) => {
    const id = `${key.kind}\n${key.match}`;
    let place = byKey.get(id);
    if (place == null) {
      place = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, place);
      places.push(place);
    }
    place.sessions += n;
  };
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    if (nowMs - entry.mtimeMs > REVIEW_WINDOW_MS) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) continue;
    const state = safeReadState(readState, entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry.transcriptPath);
    if (dir == null) continue;
    const key = routeForDir(row, dir, context) || routeKeyForDir(dir, context);
    if (key != null) add(key, 1);
  }
  places.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  for (const rule of rulesOf(row)) add(rule, 0);
  return places;
}

// Where a place sends today: its rule (unless every workspace it names was left), else New folders, else under Ask me the one workspace the account had before the new ones, else pending.
export function placeNow(row, place, newIds) {
  const members = (tenantsOf(row) || []).map((t) => t.id);
  for (const rule of rulesOf(row)) {
    if (rule.kind !== place.kind || rule.match !== place.match) continue;
    const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
    if (rule.tenantIds.length === 0 || ids.length > 0) return { ids, pending: false };
  }
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return { ids: newFolders.tenantIds, pending: false };
  if (newFolders.mode === 'none') return { ids: [], pending: false };
  const before = members.filter((id) => newIds.indexOf(id) === -1);
  return before.length === 1 ? { ids: before, pending: false } : { ids: [], pending: true };
}
