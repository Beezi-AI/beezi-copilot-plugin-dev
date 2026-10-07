import fs from 'fs';
import path from 'path';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { listAccounts as _listAccounts, getDefaultKey as _getDefaultKey, AccountStatus } from './accounts.mjs';
import { copilotSessionStateRoots } from './copilot-paths.mjs';
import { stateDir } from './paths.mjs';
import { loadSessionState, isUsableSessionId } from './session-state.mjs';
import { normPath } from './repo-map.mjs';

function toSession(row, token) {
  return {
    key: row.key,
    email: row.email == null ? null : row.email,
    name: row.name == null ? null : row.name,
    tenantName: row.tenantName == null ? null : row.tenantName,
    tenants: Array.isArray(row.tenants) ? row.tenants : null,
    newFolders: row.newFolders != null && typeof row.newFolders === 'object' ? row.newFolders : null,
    workspaceRules: Array.isArray(row.workspaceRules) ? row.workspaceRules : [],
    tenantId: null,
    token,
    clientId: row.clientId == null ? null : row.clientId,
  };
}

async function resolve(row, deps) {
  if (row == null || row.status !== AccountStatus.LINKED) return null;
  if (deps.getAccessToken && !deps.getAuthentication) {
    const token = await deps.getAccessToken(deps, { account: row.key }).catch(() => null);
    return token ? toSession(row, token) : null;
  }
  const auth = await (deps.getAuthentication || _getAuthentication)(deps, { account: row.key }).catch(() => null);
  return auth != null && auth.authState === 'ready' ? toSession({ ...row, clientId: auth.clientId }, auth.accessToken) : null;
}

export async function sessionFor(key, deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const row = (await listAccounts(deps)).find((a) => a.key === key);
  return resolve(row, deps);
}

export async function defaultSession(deps = {}) {
  const getDefaultKey = deps.getDefaultKey == null ? _getDefaultKey : deps.getDefaultKey;
  const key = await getDefaultKey(deps);
  return key == null ? null : sessionFor(key, deps);
}

// Every linked account with a usable token, resolved concurrently; failures are dropped for this call.
export async function linkedSessions(deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  const sessions = await Promise.all(rows.map((row) => resolve(row, deps)));
  return sessions.filter((s) => s != null);
}

// Plugin diagnostics go through one account: the default when it is live, else the first.
export function diagnosticsSession(sessions, defaultKey = null) {
  if (!sessions || sessions.length === 0) return null;
  const def = sessions.find((s) => s.key === defaultKey);
  return def == null ? sessions[0] : def;
}

// V-31 is open, but the CLI changelog says MCP servers survive /clear and session switches and get the variable once, at
// spawn. The MCP process (scripts/mcp.mjs sets BEEZI_PROCESS_ROLE=mcp) therefore never trusts its copy: it takes the
// session that wrote last instead. Hooks and agent shells get a fresh id per call, so they still trust the variable.
const MCP_ENV_MAY_BE_STALE = true;

const STATE_FRESH_MS = 12 * 60 * 60 * 1000;
const AMBIGUOUS_MS = 10 * 60 * 1000;
// At most this many candidates are read per rung, newest first; the scan that orders them stats names only.
const MAX_READ = 200;
const MAX_SCAN = 5000;
// Sessions checked when a tool call names none: any that wrote within the ambiguity window may be the caller.
const MAX_RECENT = 8;
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

function sameDir(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (x == null || y == null) return false;
  return FOLD ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function sessionDirExists(id) {
  for (const root of copilotSessionStateRoots()) {
    try {
      if (fs.statSync(path.join(root, id)).isDirectory()) return true;
    } catch { /* not under this root */ }
  }
  return false;
}

// Newest first; entries older than `maxAgeMs` (when given) are dropped, then at most MAX_READ remain.
function newestFirst(entries, now, maxAgeMs) {
  const fresh = maxAgeMs == null ? entries : entries.filter((e) => now - e.mtimeMs <= maxAgeMs);
  return fresh.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_READ);
}

// Plan 04 state files (state/<id>.json) whose recorded cwd is this cwd; only `*.json`, never the other state-dir files.
function stateCandidates(cwd, now) {
  let names;
  try { names = fs.readdirSync(stateDir()); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (files.length >= MAX_SCAN) break;
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isUsableSessionId(id)) continue;
    try { files.push({ id, mtimeMs: fs.statSync(path.join(stateDir(), name)).mtimeMs }); } catch { /* vanished */ }
  }
  return newestFirst(files, now, STATE_FRESH_MS)
    .filter((f) => sameDir(loadSessionState(f.id).cwd, cwd) && sessionDirExists(f.id))
    .map((f) => ({ id: f.id, at: f.mtimeMs }));
}

// The `cwd:` line of a workspace.yaml (V-21), with no YAML library; null when absent.
function yamlCwd(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^cwd:[ \t]*(.*)$/m.exec(text);
  if (m == null) return null;
  const raw = m[1].trim();
  const dq = /^"(.*)"$/.exec(raw);
  // Double-quoted YAML escapes \\ and \"; single-quoted and plain values are literal.
  const value = dq ? dq[1].replace(/\\([\\"])/g, '$1') : raw.replace(/^'(.*)'$/, '$1');
  return value === '' ? null : value;
}

// Every session-state/<id> over every root (R-09), newest events.jsonl first; the scan stats names only.
function sessionStateEntries() {
  const found = [];
  let scanned = 0;
  for (const root of copilotSessionStateRoots()) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const id of names) {
      if (scanned >= MAX_SCAN) break;
      if (!isUsableSessionId(id)) continue;
      scanned += 1;
      let mtimeMs;
      try { mtimeMs = fs.statSync(path.join(root, id, 'events.jsonl')).mtimeMs; } catch {
        try { mtimeMs = fs.statSync(path.join(root, id, 'workspace.yaml')).mtimeMs; } catch { continue; }
      }
      found.push({ id, root, mtimeMs });
    }
  }
  return newestFirst(found, Date.now(), null);
}

// session-state/<id>/workspace.yaml whose cwd is this cwd, ordered by the mtime of events.jsonl.
function sessionStateCandidates(cwd) {
  return sessionStateEntries()
    .filter((e) => sameDir(yamlCwd(path.join(e.root, e.id, 'workspace.yaml')), cwd))
    .map((e) => ({ id: e.id, at: e.mtimeMs }));
}

// Sessions whose events.jsonl changed within `withinMs`, newest first: the ones that may be calling when a tool call
// names no session (the MCP process). Never throws.
export function recentSessionIds({ withinMs = AMBIGUOUS_MS } = {}) {
  try {
    const now = Date.now();
    return sessionStateEntries()
      .filter((e) => now - e.mtimeMs <= withinMs)
      .slice(0, MAX_RECENT)
      .map((e) => ({ id: e.id, at: e.mtimeMs }));
  } catch {
    return [];
  }
}

// The newest candidate; ambiguous when a second one in the same cwd was updated within the last 10 minutes.
function pickNewest(candidates, now, source) {
  if (candidates.length === 0) return null;
  const sorted = candidates.slice().sort((a, b) => b.at - a.at);
  const recent = sorted.filter((c) => now - c.at <= AMBIGUOUS_MS);
  return { sessionId: sorted[0].id, source, ambiguous: recent.length > 1 };
}

// The Copilot session this process runs in, or null. Synchronous: callers (workspace.mjs, the audit, the mode guard,
// the MCP bridge) read the result directly. Fallback rungs never return a session recorded under another cwd.
export function resolveSessionId({ env = process.env, cwd = process.cwd() } = {}) {
  const now = Date.now();
  const staleHere = MCP_ENV_MAY_BE_STALE && env != null && env.BEEZI_PROCESS_ROLE === 'mcp';
  const fromEnv = env != null && !staleHere ? env.COPILOT_AGENT_SESSION_ID : null;
  // An exact identity rather than a guess, so the recorded-cwd check does not apply (a shell may run in a subfolder).
  if (isUsableSessionId(fromEnv) && sessionDirExists(fromEnv)) return { sessionId: fromEnv, source: 'env', ambiguous: false };
  if (staleHere) {
    // The caller is the session that wrote last (the server's own cwd is as stale as its variable); ambiguous when a second wrote within minutes.
    const recent = recentSessionIds();
    if (recent.length > 0) return { sessionId: recent[0].id, source: 'recent', ambiguous: recent.length > 1 };
  }
  try {
    const state = pickNewest(stateCandidates(cwd, now), now, 'state');
    if (state != null) return state;
    return pickNewest(sessionStateCandidates(cwd), now, 'session-state');
  } catch {
    return null;
  }
}
