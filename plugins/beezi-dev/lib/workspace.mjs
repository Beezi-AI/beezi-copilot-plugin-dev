import fs from 'fs';
import { accountsIndexFile, sessionWorkspaceFile, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { normPath } from './repo-map.mjs';
import { UserError } from './friendly-error.mjs';
// A namespace import: accounts.mjs reaches this module, so a named import of Plan 06's resolveSessionId
// would fail the whole plugin's link (token, MCP server, checkpoint) until that export exists.
import * as sessionsModule from './sessions.mjs';
import { isUsableSessionId } from './session-state.mjs';

const STATE_VERSION = 3;
const NEW_FOLDER_MODES = ['ask', 'send', 'none'];

// How long held reports wait before they expire; checkpoint re-exports it.
export const QUEUE_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

// The account row's workspace list; null means unknown (old server or never probed).
export function tenantsOf(row) {
  if (row == null || !Array.isArray(row.tenants)) return null;
  return row.tenants.filter((t) => t && typeof t.id === 'string' && t.id !== '');
}

// One linked row from the accounts index, read synchronously; null unless it exists and is linked.
// The index file is read directly: accounts.mjs imports workspace-rules, which imports this module.
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
  if (t.type === 'analytics' && ANALYTICS_ROLE_LABELS[t.role] != null) return ANALYTICS_ROLE_LABELS[t.role];
  return t.role === 'Tenant Owner' ? 'Owner' : t.role;
}

export function describeTenant(t) {
  if (t == null) return 'unknown workspace';
  const name = t.name ? t.name : t.id;
  const role = roleLabel(t);
  return role ? `${name} (${role})` : name;
}

function objectOr(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}

function normalizeRead(raw) {
  const out = {};
  const source = objectOr(raw);
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'string' && source[key] !== '') out[key] = source[key];
  }
  return out;
}

// A rule bound to a session: {kind, match, label, tenantIds, at}; [] tenantIds means send nowhere.
function normalizeRoute(raw) {
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
  const wanted = normPath(cwd);
  if (wanted == null) return null;
  let best = null;
  for (const entry of listSessionWorkspaces()) {
    if (normPath(entry.state.cwd) !== wanted) continue;
    if (best == null || entry.state.updatedAt > best.state.updatedAt) best = entry;
  }
  return best;
}

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
      // A bound [] route excludes only while its rule is still stored; raw entries are compared because workspace-rules.mjs imports this module.
      const stillStored = bound != null && bound.tenantIds.length === 0 && Array.isArray(account.workspaceRules)
        && account.workspaceRules.some((raw) => raw != null && typeof raw === 'object' && raw.kind === bound.kind && (raw.kind === 'outside' || raw.match === bound.match)
          && Array.isArray(raw.tenantIds) && raw.tenantIds.length === 0);
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

// An id, a case-insensitive name, or a 1-based position in row.tenants; throws when none match.
export function resolveTenantRef(row, ref) {
  const value = ref == null ? '' : String(ref).trim();
  if (!value) throw new UserError('No workspace given.');
  const tenants = tenantsOf(row);
  if (tenants == null) {
    throw new UserError('This account\'s workspaces are not known yet. Start a new Copilot session, then try again.');
  }
  const byId = tenants.find((t) => t.id === value);
  if (byId) return byId.id;
  const byName = tenants.find((t) => typeof t.name === 'string' && t.name.toLowerCase() === value.toLowerCase());
  if (byName) return byName.id;
  if (/^\d+$/.test(value)) {
    const byPosition = tenants[Number(value) - 1];
    if (byPosition) return byPosition.id;
  }
  throw new UserError(`No workspace of this account matches "${value}". Use a workspace name or id shown in /beezi-dev-settings.`);
}

// Strips --tenant <ref> out of argv; tenantId is null when the flag is absent.
export function parseTenantFlag(argv, row) {
  const rest = [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tenant') {
      ref = argv[++i];
      if (ref == null) throw new UserError('--tenant needs a value: a workspace name or id shown in /beezi-dev-settings.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { argv: rest, tenantId: ref == null ? null : resolveTenantRef(row, ref) };
}

// Strips every --tenant <ref[,ref…]> out of argv; tenantIds is [] when the flag is absent.
export function parseTenantFlags(argv, row) {
  const rest = [];
  const tenantIds = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--tenant') { rest.push(argv[i]); continue; }
    const value = argv[++i];
    if (value == null) throw new UserError('--tenant needs a value: a workspace name or id shown in /beezi-dev-settings.');
    for (const ref of String(value).split(',')) {
      if (ref.trim() === '') continue;
      const id = resolveTenantRef(row, ref);
      if (tenantIds.indexOf(id) === -1) tenantIds.push(id);
    }
  }
  return { argv: rest, tenantIds };
}

// The Copilot session a command runs in, via Plan 06's resolver; null when it is missing, ambiguous or not a usable id.
export function currentSessionId(cwd = process.cwd()) {
  try {
    const found = typeof sessionsModule.resolveSessionId === 'function' ? sessionsModule.resolveSessionId({ env: process.env, cwd }) : null;
    if (found == null || found.ambiguous === true) return null;
    return isUsableSessionId(found.sessionId) ? found.sessionId : null;
  } catch {
    return null;
  }
}

// The workspace state of the Copilot session a command runs in: its id, else the newest session here.
export function currentSessionWorkspace(cwd = process.cwd()) {
  const sessionId = currentSessionId(cwd);
  if (sessionId != null) return readSessionWorkspace(sessionId);
  const byCwd = findSessionWorkspaceByCwd(cwd);
  return byCwd == null ? null : byCwd.state;
}

function workspaceRequired(message) {
  const error = new UserError(message);
  error.workspaceRequired = true;
  return error;
}

// --tenant flags when given, else this session's targets ([null] = headerless); none left throws workspaceRequired.
export function parseCommandTargets(argv, row) {
  const account = accountRowFor(row);
  const parsed = parseTenantFlags(argv, account);
  // A missing or logged-out account has no targets, flags or not.
  if (account.unlinked === true) return { argv: parsed.argv, tenantIds: [] };
  // One or unknown workspaces always go headerless, flags or not.
  if (!isMultiTenant(account)) return { argv: parsed.argv, tenantIds: [null] };
  if (parsed.tenantIds.length > 0) return parsed;
  const resolved = resolveTargets(account, currentSessionWorkspace());
  if (resolved.targets.length > 0) return { argv: parsed.argv, tenantIds: resolved.targets };
  if (resolved.pendingAsk) {
    throw workspaceRequired('Beezi has not been told where analytics from this folder go yet, so this session sends nowhere. Choose with /beezi-dev-settings rules, or pass --tenant <workspace>.');
  }
  if (resolved.rule != null) {
    throw workspaceRequired(`The rule for ${resolved.rule.label} is "Don't track", so this session sends nowhere. Change it with /beezi-dev-settings rules, or pass --tenant <workspace>.`);
  }
  throw workspaceRequired('New folders are set to Don\'t send, so this session sends nowhere. Change it with /beezi-dev-settings new-folders, or pass --tenant <workspace>.');
}

// One --tenant when given, else the session's read workspace.
export function parseCommandReadTenant(argv, row) {
  const account = accountRowFor(row);
  const parsed = parseTenantFlags(argv, account);
  if (parsed.tenantIds.length > 1) throw new UserError('Pass one --tenant here: this reads from a single workspace.');
  if (!isMultiTenant(account)) return { argv: parsed.argv, tenantId: null };
  if (parsed.tenantIds.length === 1) return { argv: parsed.argv, tenantId: parsed.tenantIds[0] };
  return { argv: parsed.argv, tenantId: resolveReadTenant(account, currentSessionWorkspace()).tenantId };
}
