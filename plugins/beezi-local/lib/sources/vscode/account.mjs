import fs from 'fs';
import path from 'path';
import { vscodeInstalls, vscodeStateDb } from '../../config/copilot-paths.mjs';
import { identityKey, normalizeHost } from '../../core/github-identity.mjs';
import { loadSqlite } from '../../platform/sqlite.mjs';
import { isPlain } from '../../core/guards.mjs';
import { launchLogs, launchStartMs, loginAt, readDir, scanChatLog } from './chat-log.mjs';

// The GitHub account a VS Code Local-agent session ran under: the Copilot Chat log of the launch that covers the
// session's first request when the session's own account label agrees, else that label (state.vscdb's single login
// confirming it). Also VS Code's org policy facts from state.vscdb.

export const VscodeAccountSource = Object.freeze({ LOG: 'vscode-log', STATE: 'vscode-state', LABEL: 'vscode-label' });

const DEFAULT_HOST = 'github.com';
// The sku of VS Code's anonymous Copilot access: no GitHub account is signed in.
const ANONYMOUS_SKU = 'no_auth_limited_copilot';
// github-<login>-usages; a GitHub Enterprise sign-in writes github-enterprise-<login>-usages, which is no github.com login.
const USAGES_KEY = /^github-(?!enterprise-)([A-Za-z0-9_-]{1,39})-usages$/;
const LOGIN = /^[A-Za-z0-9_-]{1,39}$/;
const POLICY_KEY = 'defaultAccount.cachedPolicyData';
const GHE_PROVIDER = 'github-enterprise';

function account(login, source, host = DEFAULT_HOST) {
  const h = normalizeHost(host);
  const key = identityKey(h, login);
  return key == null ? null : { key, host: h, login, source };
}

// The latest login at or before atMs in this install's covering launch logs, keyed under host.
function fromLogs(logsDir, atMs, host) {
  const best = loginAt(logsDir, atMs);
  return best == null ? null : account(best.login, VscodeAccountSource.LOG, host);
}

// VS Code's current Copilot Chat account for a session neither its logs nor state.vscdb resolved, unless the session's
// own account label names someone else. `hosts` as for readVscodeSignedIn. Sync. Never throws.
export function currentVscodeAccount(session, { hosts = null } = {}) {
  const now = readVscodeSignedIn({ hosts });
  if (now == null) return null;
  const label = session != null && typeof session.accountLabel === 'string' ? session.accountLabel.trim().toLowerCase() : '';
  return label !== '' && label !== now.login.toLowerCase() ? null : now;
}

// The host recorded for an install: a known host, null for an enterprise sign-in whose tenant is unknown, else
// github.com when nothing was recorded yet (state.vscdb is SQLite, so only an async pass can record it).
function recordedHost(hosts, userDir) {
  if (hosts == null || typeof hosts !== 'object' || !Object.prototype.hasOwnProperty.call(hosts, userDir)) return DEFAULT_HOST;
  return typeof hosts[userDir] === 'string' ? hosts[userDir] : null;
}

// Every launch folder of every install, newest first: [{ dir, startMs, install }].
function allLaunches() {
  const launches = [];
  for (const install of vscodeInstalls()) {
    for (const name of readDir(install.logsDir)) {
      const startMs = launchStartMs(name);
      if (startMs != null) launches.push({ dir: path.join(install.logsDir, name), startMs, install });
    }
  }
  return launches.sort((a, b) => b.startMs - a.startMs);
}

// The newest login and newest sku line across one launch's logs.
function launchSignIn(logs) {
  let who = null;
  let sku = null;
  for (const log of logs) {
    const scan = scanChatLog(log.file, log.stat);
    for (const hit of scan.logins) if (who == null || hit.ms >= who.ms) who = hit;
    for (const hit of scan.skus) if (sku == null || hit.ms >= sku.ms) sku = hit;
  }
  return { who, sku };
}

// The account Copilot Chat last signed in as, from the newest VS Code launch that wrote a Copilot Chat log, with the
// token sku logged for that login: { key, host, login, rawSku, atMs, userDir, product }. rawSku is null when none was
// logged; atMs is that sku line's time, else the login's; userDir and product name the install.
// `hosts` maps an install's userDir to its recorded GitHub host. Sync. Never throws.
export function readVscodeSignedIn({ hosts = null } = {}) {
  try {
    for (const launch of allLaunches()) {
      const logs = launchLogs(launch.dir);
      if (logs.length === 0) continue;
      // The newest launch with Copilot Chat decides; an older one never stands in for a sign-out.
      const { who, sku } = launchSignIn(logs);
      const host = recordedHost(hosts, launch.install.userDir);
      const found = who == null || host == null ? null : account(who.login, VscodeAccountSource.LOG, host);
      // A sign-out to anonymous access after the login leaves no account.
      if (found == null || (sku != null && sku.sku === ANONYMOUS_SKU && sku.ms >= who.ms)) return null;
      const own = sku != null && sku.login != null && sku.login.toLowerCase() === who.login.toLowerCase();
      return {
        key: found.key,
        host: found.host,
        login: found.login,
        rawSku: own ? sku.sku : null,
        atMs: own ? sku.ms : who.ms,
        userDir: launch.install.userDir,
        product: launch.install.product,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// read(db) on state.vscdb opened read-only and closed afterwards; fallback when it is missing, Node has no sqlite, or it throws.
async function withStateDb(userDir, fallback, read) {
  const file = vscodeStateDb(userDir);
  if (!fs.existsSync(file)) return fallback;
  const mod = await loadSqlite();
  if (mod == null) return fallback;
  let db = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    if (db != null) { try { db.close(); } catch { /* already closed */ } }
  }
}

// The logins with a 'github-<login>-usages' key in state.vscdb, read-only; [] when unreadable.
function stateLogins(userDir) {
  return withStateDb(userDir, [], (db) => {
    const logins = [];
    for (const row of db.prepare("SELECT key FROM ItemTable WHERE key LIKE 'github-%-usages'").all()) {
      const m = USAGES_KEY.exec(String(row.key));
      if (m != null && logins.indexOf(m[1]) === -1) logins.push(m[1]);
    }
    return logins;
  });
}

// The default account's cached org policy (accountPolicyData) from an open state.vscdb handle, or null. Throws on a bad row.
export function readStatePolicy(db) {
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(POLICY_KEY);
  // ItemTable.value is a BLOB column; VS Code stores text, which a blob write would return as bytes.
  const text = row == null ? null : (typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
  const parsed = text == null ? null : JSON.parse(text);
  return parsed != null && isPlain(parsed.accountPolicyData) ? parsed.accountPolicyData : null;
}

function statePolicy(userDir) {
  return withStateDb(userDir, null, readStatePolicy);
}

// The GitHub host VS Code's default account signs in to: the GHE.com tenant behind a github-enterprise sign-in, else
// github.com; null for an enterprise sign-in whose tenant cannot be read, never a github.com guess. Pure.
export function policyHost(policy) {
  const scope = policy == null || !isPlain(policy.managedSettingsScope) ? {} : policy.managedSettingsScope;
  if (scope.authenticationProviderId !== GHE_PROVIDER) return DEFAULT_HOST;
  const host = typeof scope.endpointOrigin === 'string' ? normalizeHost(scope.endpointOrigin) : null;
  return host == null ? null : host.replace(/^api\./, '');
}

async function installHost(userDir) {
  return policyHost(await statePolicy(userDir));
}

// The time the session's account must hold: its first request, else its creation.
function anchorMs(session) {
  let first = null;
  for (const r of session.requests || []) {
    if (r != null && typeof r.startedAtMs === 'number' && (first == null || r.startedAtMs < first)) first = r.startedAtMs;
  }
  return first != null ? first : (typeof session.createdAtMs === 'number' ? session.createdAtMs : null);
}

// The session's own label as a login: the account VS Code authenticated its model with; '' when absent or not a login.
function labelOf(session) {
  const label = typeof session.accountLabel === 'string' ? session.accountLabel.trim() : '';
  return LOGIN.test(label) ? label : '';
}

// The launch log's answer unless the session's label names someone else; else the label, confirmed by state.vscdb's single login.
async function installAccount(install, atMs, label) {
  const host = await installHost(install.userDir);
  const logged = atMs == null ? null : fromLogs(install.logsDir, atMs, host);
  if (logged != null && (label === '' || label.toLowerCase() === logged.login.toLowerCase())) return logged;
  if (label === '') return null;
  const logins = await stateLogins(install.userDir);
  const confirmed = logins.length === 1 && logins[0].toLowerCase() === label.toLowerCase();
  return account(label, confirmed ? VscodeAccountSource.STATE : VscodeAccountSource.LABEL, host);
}

// { key, host, login, source } for a readVscodeSession() result, or null. Async (state.vscdb is SQLite). Never throws.
export async function resolveVscodeAccount(session) {
  try {
    if (session == null || typeof session !== 'object') return null;
    const atMs = anchorMs(session);
    const label = labelOf(session);
    for (const install of vscodeInstalls()) {
      if (session.product != null && install.product !== session.product) continue;
      const found = await installAccount(install, atMs, label);
      if (found != null) return found;
    }
    return null;
  } catch {
    return null;
  }
}

// { key, host, login, source } VS Code's Copilot Chat was signed in as at atMs (a VS Code Agent Host session's start), or
// null; also null when two installs covering atMs were signed in as different accounts, since the session names neither.
export async function vscodeAccountAt(atMs) {
  try {
    if (typeof atMs !== 'number' || !isFinite(atMs)) return null;
    let chosen = null;
    for (const install of vscodeInstalls()) {
      const best = loginAt(install.logsDir, atMs);
      if (best == null) continue;
      // An enterprise install whose tenant is unknown names no account, so it cannot agree with another install.
      const found = account(best.login, VscodeAccountSource.LOG, await installHost(install.userDir));
      if (found == null || (chosen != null && chosen.key !== found.key)) return null;
      chosen = found;
    }
    return chosen;
  } catch {
    return null;
  }
}

// VS Code's org policy for Local chat, from the default account's cached policy:
// { product, hooksDisabled, mcpDisabled, fetchedAt } of the first install that has one, else null. Never throws.
export async function vscodePolicy() {
  try {
    for (const install of vscodeInstalls()) {
      const policy = await statePolicy(install.userDir);
      if (policy == null || !isPlain(policy.policyData)) continue;
      const fetchedMs = typeof policy.entitlementsFetchedAt === 'number' ? policy.entitlementsFetchedAt : NaN;
      return {
        product: install.product,
        // ChatHooks and ChatMCP are VS Code's policy names behind these two fields.
        hooksDisabled: policy.policyData.chat_preview_features_enabled === false,
        mcpDisabled: policy.policyData.mcp === false,
        fetchedAt: isFinite(fetchedMs) ? new Date(fetchedMs).toISOString() : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
