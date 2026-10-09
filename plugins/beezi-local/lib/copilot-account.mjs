import fs from 'fs';
import { copilotConfigFile } from './copilot-paths.mjs';
import { quotaCacheFile } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import { readVscodeSignedIn } from './vscode-account.mjs';

// Why the GitHub identity is or is not known. Downstream code branches on this, never re-derives it.
export const IdentityStatus = Object.freeze({
  OK: 'ok',
  ENV_TOKEN: 'env-token',
  AMBIGUOUS: 'ambiguous',
  LOGGED_OUT: 'logged-out',
  UNREADABLE: 'unreadable',
});

const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const KEY_MAX = 64;
// config.json has no active-account marker; the Copilot runtime's account.getCurrentAuth names it instead.
const ACTIVE_MARKER = null;
// How long the runtime's answer may stand in for an ambiguous or env-token identity.
const RUNTIME_AUTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// config.json opens with `//` comment lines ("This file is managed automatically"), so strict JSON fails on it.
function readJsoncFile(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function truthy(value) {
  return /^(true|1|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

// Presence flags only: a token value is never read past "non-empty", never fingerprinted and never returned.
// If V-38(b) shows hooks do not inherit the token vars, hook callers get a best-effort answer here.
export function copilotAuthEnv(env = process.env) {
  let envToken = null;
  for (const name of TOKEN_VARS) {
    // Codespaces injects a GITHUB_TOKEN that does not override a signed-in account.
    if (name === 'GITHUB_TOKEN' && env.CODESPACES === 'true') continue;
    if (nonEmpty(env[name])) { envToken = name; break; }
  }
  return { envToken, byok: nonEmpty(env.COPILOT_PROVIDER_BASE_URL), offline: truthy(env.COPILOT_OFFLINE) };
}

// '<host>/<login>' lowercased, or null when a part is missing or the key would not fit the wire cap.
export function identityKey(host, login) {
  if (typeof host !== 'string' || typeof login !== 'string') return null;
  const h = host.trim();
  const l = login.trim();
  if (h === '' || l === '') return null;
  const key = `${h}/${l}`.toLowerCase();
  return key.length > KEY_MAX ? null : key;
}

// 'https://github.com/' → 'github.com'; null when nothing is left.
export function normalizeHost(host) {
  if (!nonEmpty(host)) return null;
  const clean = host.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  return clean === '' ? null : clean;
}

function identity(status, host = null, login = null) {
  const key = status === IdentityStatus.OK ? identityKey(host, login) : null;
  // A login too long for the key is no usable identity at all.
  if (status === IdentityStatus.OK && key == null) return identity(IdentityStatus.UNREADABLE);
  // No numeric GitHub id: V-19 is open, and the key never uses it (R-07, D-1).
  return { status, host: status === IdentityStatus.OK ? host : null, login: status === IdentityStatus.OK ? login : null, id: null, key };
}

// No Copilot CLI account in config.json: VS Code's Copilot Chat sign-in names the account, else `status` stands.
function vscodeIdentity(status) {
  const vscode = readVscodeSignedIn();
  return vscode != null ? identity(IdentityStatus.OK, vscode.host, vscode.login) : identity(status);
}

// Only named scalars leave each entry; the rest of config.json (tokens included) is dropped unread.
function usersOf(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const list = raw.loggedInUsers;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const users = [];
  for (const entry of list) {
    if (entry == null || typeof entry !== 'object') return null;
    if (!nonEmpty(entry.login) || /[\s/]/.test(entry.login.trim())) return null;
    users.push({
      login: entry.login.trim(),
      host: typeof entry.host === 'string' ? entry.host : null,
      active: ACTIVE_MARKER != null && entry[ACTIVE_MARKER] === true,
    });
  }
  return users;
}

// The account the Copilot runtime last reported (account.getCurrentAuth, cached by lib/quota-copilot.mjs),
// or null when absent, malformed or older than maxAgeMs. Named scalars only; never throws.
export function readRuntimeAuth({ maxAgeMs = RUNTIME_AUTH_MAX_AGE_MS, readJsonImpl } = {}) {
  try {
    const read = readJsonImpl == null ? readJson : readJsonImpl;
    const raw = read(quotaCacheFile(), null);
    const auth = raw != null && typeof raw === 'object' && raw.version === 1 ? raw.auth : null;
    if (auth == null || typeof auth !== 'object') return null;
    const host = normalizeHost(auth.host);
    const key = identityKey(host, auth.login);
    const at = Date.parse(auth.fetchedAt);
    if (key == null || key !== auth.key || !Number.isFinite(at)) return null;
    if (Date.now() - at > maxAgeMs || at > Date.now() + 60 * 1000) return null;
    return {
      key,
      host,
      login: auth.login.trim(),
      authType: nonEmpty(auth.authType) ? auth.authType : null,
      rawPlan: nonEmpty(auth.rawPlan) ? auth.rawPlan : null,
      rawSku: nonEmpty(auth.rawSku) ? auth.rawSku : null,
      fetchedAt: auth.fetchedAt,
    };
  } catch {
    return null;
  }
}

// The '<host>/<login>' keys of every account signed in to Copilot, from config.json. Never throws.
export function signedInIdentityKeys({ readJsonImpl } = {}) {
  try {
    const read = readJsonImpl == null ? readJsoncFile : readJsonImpl;
    const users = usersOf(read(copilotConfigFile(), null)) || [];
    return users.map((u) => identityKey(normalizeHost(u.host), u.login)).filter((key) => key != null);
  } catch {
    return [];
  }
}

// The GitHub account Copilot is signed in as, from ~/.copilot/config.json and env presence. Never throws.
// When the file cannot name one (several users, or an env token), a fresh runtime answer settles it.
export function readCopilotIdentity({ env = process.env, readJsonImpl } = {}) {
  try {
    const read = readJsonImpl == null ? readJsoncFile : readJsonImpl;
    // An env token silently overrides the stored login, so the file may name someone who is not billed;
    // only a runtime answer measured under an env credential (not the stored user login) names the account.
    if (copilotAuthEnv(env).envToken != null) {
      const runtime = readRuntimeAuth({ readJsonImpl: read });
      return runtime != null && runtime.authType !== 'user'
        ? identity(IdentityStatus.OK, runtime.host, runtime.login)
        : identity(IdentityStatus.ENV_TOKEN);
    }
    const users = usersOf(read(copilotConfigFile(), null));
    if (users == null) return fs.existsSync(copilotConfigFile()) ? identity(IdentityStatus.UNREADABLE) : vscodeIdentity(IdentityStatus.UNREADABLE);
    if (users.length === 0) return vscodeIdentity(IdentityStatus.LOGGED_OUT);
    let chosen = null;
    if (users.length === 1) chosen = users[0];
    else {
      const active = users.filter((u) => u.active);
      if (active.length === 1) chosen = active[0];
    }
    if (chosen == null || normalizeHost(chosen.host) == null) {
      // The runtime's active account counts only if it is one of the users the file lists.
      const runtime = readRuntimeAuth({ readJsonImpl: read });
      const listed = runtime != null && users.some((u) => identityKey(normalizeHost(u.host), u.login) === runtime.key);
      return listed ? identity(IdentityStatus.OK, runtime.host, runtime.login) : identity(IdentityStatus.AMBIGUOUS);
    }
    return identity(IdentityStatus.OK, normalizeHost(chosen.host), chosen.login);
  } catch {
    return identity(IdentityStatus.UNREADABLE);
  }
}

// The raw plan for this identity key ({ rawPlan, rawSku }): the Copilot runtime's answer, else the token sku VS Code's
// Copilot Chat logged for it (rawPlan null); or null.
export function readLocalPlanRaw(key) {
  if (key == null) return null;
  const runtime = readRuntimeAuth();
  if (runtime != null && runtime.key === key && (runtime.rawPlan != null || runtime.rawSku != null)) {
    return { rawPlan: runtime.rawPlan, rawSku: runtime.rawSku };
  }
  const vscode = readVscodeSignedIn();
  return vscode != null && vscode.key === key && vscode.rawSku != null ? { rawPlan: null, rawSku: vscode.rawSku } : null;
}
