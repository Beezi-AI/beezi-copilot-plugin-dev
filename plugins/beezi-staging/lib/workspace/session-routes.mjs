// The per-session workspace file: each account's bound rule (route) and read pick, keyed by session id.
import fs from 'fs';
import { sessionWorkspaceFile, stateDir } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { normPath, samePath } from '../core/fs-paths.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { currentSessionId } from '../host/current-session.mjs';
import { objectOr, stringIds } from '../core/guards.mjs';

const STATE_VERSION = 3;

function normalizeRead(raw) {
  const out = {};
  const source = objectOr(raw);
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'string' && source[key] !== '') out[key] = source[key];
  }
  return out;
}

// A rule bound to a session: {kind, match, label, tenantIds, at}; [] tenantIds means send nowhere.
export function normalizeRoute(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  if ((raw.kind !== 'repo' && raw.kind !== 'folder' && raw.kind !== 'outside') || typeof raw.match !== 'string' || raw.match === '') return null;
  const tenantIds = stringIds(raw.tenantIds);
  if (tenantIds == null) return null;
  return {
    kind: raw.kind,
    match: raw.match,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.match,
    tenantIds,
    at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : new Date().toISOString(),
  };
}

function normalizeRoutes(raw) {
  const out = {};
  const source = objectOr(raw);
  for (const key of Object.keys(source)) {
    const route = normalizeRoute(source[key]);
    if (route != null) out[key] = route;
  }
  return out;
}

function normalizeState(raw) {
  if (raw == null || typeof raw !== 'object' || raw.version !== STATE_VERSION) return null;
  return {
    version: STATE_VERSION,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    route: normalizeRoutes(raw.route),
    read: normalizeRead(raw.read),
  };
}

function emptyState(cwd) {
  return { version: STATE_VERSION, cwd: cwd == null ? null : cwd, updatedAt: '', route: {}, read: {} };
}

// Binds (route) or unbinds (null) an account's rule on a loaded state.
function applyRoute(state, key, route) {
  const normalized = route == null ? null : normalizeRoute(route);
  if (normalized == null) delete state.route[key];
  else state.route[key] = normalized;
}

function saveState(sessionId, state) {
  state.updatedAt = new Date().toISOString();
  writeJsonSecure(sessionWorkspaceFile(sessionId), state);
  return state;
}

function loadOrEmpty(sessionId, cwd) {
  const existing = readSessionWorkspace(sessionId);
  return existing == null ? emptyState(cwd) : existing;
}

// A session id that fails isUsableSessionId gives null and never reaches a path.
export function readSessionWorkspace(sessionId) {
  if (!isUsableSessionId(sessionId)) return null;
  return normalizeState(readJson(sessionWorkspaceFile(sessionId), null));
}

// `routes` binds (route) or unbinds (null) each account's rule.
export function initSessionWorkspace(sessionId, { cwd = null, routes = {} } = {}) {
  if (!isUsableSessionId(sessionId)) return null;
  const state = loadOrEmpty(sessionId, cwd);
  if (cwd != null) state.cwd = cwd;
  const bound = objectOr(routes);
  for (const key of Object.keys(bound)) applyRoute(state, key, bound[key]);
  return saveState(sessionId, state);
}

// Binds (or with null unbinds) a rule on this session for one account.
export function recordSessionRoute(sessionId, accountKey, route) {
  if (!isUsableSessionId(sessionId)) return null;
  const state = loadOrEmpty(sessionId, null);
  applyRoute(state, accountKey, route);
  return saveState(sessionId, state);
}

// Sets (or with null clears) the workspace this session reads from.
export function recordReadTenant(sessionId, accountKey, tenantId) {
  if (!isUsableSessionId(sessionId)) return null;
  const state = loadOrEmpty(sessionId, null);
  if (tenantId == null) delete state.read[accountKey];
  else state.read[accountKey] = tenantId;
  return saveState(sessionId, state);
}

// Every readable session workspace file in state/.
export function listSessionWorkspaces() {
  let files;
  try {
    files = fs.readdirSync(stateDir()).filter((f) => f.endsWith('.workspace'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const sessionId = file.slice(0, -'.workspace'.length);
    const state = readSessionWorkspace(sessionId);
    if (state != null) out.push({ sessionId, state });
  }
  return out;
}

// Logout: drops the account's bound rule and read pick from every session file, keeping each file's age.
export function forgetAccountInSessions(key) {
  try {
    for (const { sessionId, state } of listSessionWorkspaces()) {
      if (state.route[key] == null && state.read[key] == null) continue;
      delete state.route[key];
      delete state.read[key];
      writeJsonSecure(sessionWorkspaceFile(sessionId), state);
    }
  } catch { /* best-effort */ }
}

// Newest session whose workspace file names this cwd.
export function findSessionWorkspaceByCwd(cwd) {
  if (normPath(cwd) == null) return null;
  let best = null;
  for (const entry of listSessionWorkspaces()) {
    // Compared the way the filesystem would: case-folded on win32, darwin and WSL DrvFs.
    if (!samePath(entry.state.cwd, cwd)) continue;
    if (best == null || entry.state.updatedAt > best.state.updatedAt) best = entry;
  }
  return best;
}

// The workspace state of the Copilot session a command runs in: its id, else the newest session here.
export function currentSessionWorkspace(cwd = process.cwd()) {
  const sessionId = currentSessionId(cwd);
  if (sessionId != null) return readSessionWorkspace(sessionId);
  const byCwd = findSessionWorkspaceByCwd(cwd);
  return byCwd == null ? null : byCwd.state;
}
