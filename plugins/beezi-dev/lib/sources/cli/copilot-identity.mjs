import fs from 'fs';
import { copilotConfigFile } from '../../config/copilot-paths.mjs';
import { quotaCacheFile } from '../../config/paths.mjs';
import { readJson } from '../../platform/fs-store.mjs';
import { identityKey, normalizeHost } from '../../core/github-identity.mjs';
import { nonEmpty } from '../../core/guards.mjs';

// Why the GitHub identity is or is not known. Downstream code branches on this, never re-derives it.
export const IdentityStatus = Object.freeze({
  OK: 'ok',
  ENV_TOKEN: 'env-token',
  AMBIGUOUS: 'ambiguous',
  LOGGED_OUT: 'logged-out',
  UNREADABLE: 'unreadable',
});

const TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const ENV_ACCOUNT_PREFIX = 'COPILOT_GH_ACCOUNT_';
// '<host>_<login>' with every character outside [A-Za-z0-9] written as _<HEX>_ (github_2E_com_octo_2D_user); the lazy host
// stops at the first bare '_' that leaves a fully encoded login.
const ENV_ACCOUNT_NAME = /^((?:[A-Za-z0-9]|_[0-9A-F]{2}_)+?)_((?:[A-Za-z0-9]|_[0-9A-F]{2}_)+)$/;
const ENV_ESCAPE = /_([0-9A-F]{2})_/g;
const LOGIN = /^[A-Za-z0-9_-]{1,39}$/;
// How long the runtime's answer may stand in for an identity config.json cannot name (ambiguous, env token, no user).
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

function truthy(value) {
  return /^(true|1|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

// Presence flags only: a token value is never read past "non-empty", never fingerprinted and never returned.
// Hooks may not inherit the token vars, so hook callers get a best-effort answer here.
export function copilotAuthEnv(env = process.env) {
  let envToken = null;
  for (const name of TOKEN_VARS) {
    // Codespaces injects a GITHUB_TOKEN that does not override a signed-in account.
    if (name === 'GITHUB_TOKEN' && env.CODESPACES === 'true') continue;
    if (nonEmpty(env[name])) { envToken = name; break; }
  }
  return { envToken, byok: nonEmpty(env.COPILOT_PROVIDER_BASE_URL), offline: truthy(env.COPILOT_OFFLINE) };
}

function identity(status, host = null, login = null) {
  const key = status === IdentityStatus.OK ? identityKey(host, login) : null;
  // A login too long for the key is no usable identity at all.
  if (status === IdentityStatus.OK && key == null) return identity(IdentityStatus.UNREADABLE);
  // No numeric GitHub id: the key never uses it.
  return { status, host: status === IdentityStatus.OK ? host : null, login: status === IdentityStatus.OK ? login : null, id: null, key };
}

// No Copilot CLI account in config.json: the fallback sign-in ({ host, login } or null) names the account, else `status` stands.
function fallbackIdentity(status, fallbackSignIn) {
  const other = fallbackSignIn == null ? null : fallbackSignIn();
  return other != null ? identity(IdentityStatus.OK, other.host, other.login) : identity(status);
}

function decodeEnvPart(text) {
  return text.replace(ENV_ESCAPE, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// The account a Copilot app runtime started this process for: the single COPILOT_GH_ACCOUNT_<host>_<login> variable it sets.
// Names only, the value (a token) is never read; null when there is none, several, or the name does not decode.
export function processEnvAccount(env = process.env) {
  const names = Object.keys(env).filter((name) => name.indexOf(ENV_ACCOUNT_PREFIX) === 0);
  if (names.length !== 1) return null;
  const m = ENV_ACCOUNT_NAME.exec(names[0].slice(ENV_ACCOUNT_PREFIX.length));
  if (m == null) return null;
  const host = normalizeHost(decodeEnvPart(m[1]));
  const login = decodeEnvPart(m[2]);
  if (host == null || host.indexOf('.') === -1 || !LOGIN.test(login)) return null;
  const key = identityKey(host, login);
  return key == null ? null : { key, host, login };
}

// The '<host>/<login>' key config.json's lastLoggedInUser names, or null.
function lastLoggedInKey(raw) {
  const last = raw.lastLoggedInUser;
  return last == null || typeof last !== 'object' ? null : identityKey(normalizeHost(last.host), last.login);
}

// Only named scalars leave each entry; the rest of config.json (tokens included) is dropped unread.
function usersOf(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const list = raw.loggedInUsers;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const lastKey = lastLoggedInKey(raw);
  const users = [];
  for (const entry of list) {
    if (entry == null || typeof entry !== 'object') return null;
    if (!nonEmpty(entry.login) || /[\s/]/.test(entry.login.trim())) return null;
    const login = entry.login.trim();
    const host = typeof entry.host === 'string' ? entry.host : null;
    users.push({ login, host, active: lastKey != null && identityKey(normalizeHost(host), login) === lastKey });
  }
  return users;
}

// The runtime's answer for a terminal with no Copilot CLI /login account: a gh CLI sign-in or a stored user login, never
// an env credential (an app runtime's or a CI token's account, which names only its own process).
function isTerminalSignIn(runtime) {
  return runtime != null && (runtime.authType === 'gh-cli' || runtime.authType === 'user') && runtime.envVar == null;
}

// No Copilot CLI /login account (gh CLI sign-in, app-only or VS Code-only): a fresh terminal runtime answer names the
// account, else the fallback sign-in, else logged out. `runtimeAnswers: false` leaves the runtime out (the probe's view).
function unlistedIdentity(read, fallbackSignIn, runtimeAnswers) {
  const runtime = runtimeAnswers ? readRuntimeAuth({ readJsonImpl: read }) : null;
  return isTerminalSignIn(runtime) ? identity(IdentityStatus.OK, runtime.host, runtime.login) : fallbackIdentity(IdentityStatus.LOGGED_OUT, fallbackSignIn);
}

// The '<host>/<login>' key a fresh terminal runtime answer names (a gh CLI sign-in Copilot uses with no config.json user),
// so the machine's known accounts include it; null otherwise. Never throws.
export function runtimeSignInKey({ readJsonImpl } = {}) {
  const runtime = readRuntimeAuth({ readJsonImpl });
  return isTerminalSignIn(runtime) ? runtime.key : null;
}

// The account the Copilot runtime last reported (account.getCurrentAuth, cached by billing/quota/cache.mjs),
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
      envVar: nonEmpty(auth.envVar) ? auth.envVar.trim() : null,
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

// The GitHub account Copilot is signed in as: the app runtime's account variable, else ~/.copilot/config.json and env
// presence. Never throws. When the file cannot name one (several users and no listed lastLoggedInUser, no user, or an env
// token), a fresh runtime answer settles it.
// fallbackSignIn: another sign-in to stand in when config.json names no user (billing/plan-sources passes VS Code's).
// runtimeAnswers: false reads the files and env alone, as the probe must when it judges whose answer it got.
export function readCopilotIdentity({ env = process.env, readJsonImpl, fallbackSignIn = null, runtimeAnswers = true } = {}) {
  try {
    const own = processEnvAccount(env);
    if (own != null) return identity(IdentityStatus.OK, own.host, own.login);
    const read = readJsonImpl == null ? readJsoncFile : readJsonImpl;
    // An env token silently overrides the stored login, so the file may name someone who is not billed;
    // only a runtime answer measured under an env credential (not the stored user login) names the account.
    if (copilotAuthEnv(env).envToken != null) {
      const runtime = runtimeAnswers ? readRuntimeAuth({ readJsonImpl: read }) : null;
      return runtime != null && runtime.authType !== 'user'
        ? identity(IdentityStatus.OK, runtime.host, runtime.login)
        : identity(IdentityStatus.ENV_TOKEN);
    }
    const users = usersOf(read(copilotConfigFile(), null));
    // A missing config.json is a machine Copilot CLI never signed in on, not an unreadable one.
    if (users == null && fs.existsSync(copilotConfigFile())) return identity(IdentityStatus.UNREADABLE);
    if (users == null || users.length === 0) return unlistedIdentity(read, fallbackSignIn, runtimeAnswers);
    let chosen = null;
    if (users.length === 1) chosen = users[0];
    else {
      const active = users.filter((u) => u.active);
      if (active.length === 1) chosen = active[0];
    }
    if (chosen == null || normalizeHost(chosen.host) == null) {
      // The runtime's active account counts only if it is one of the users the file lists.
      const runtime = runtimeAnswers ? readRuntimeAuth({ readJsonImpl: read }) : null;
      const listed = runtime != null && users.some((u) => identityKey(normalizeHost(u.host), u.login) === runtime.key);
      return listed ? identity(IdentityStatus.OK, runtime.host, runtime.login) : identity(IdentityStatus.AMBIGUOUS);
    }
    return identity(IdentityStatus.OK, normalizeHost(chosen.host), chosen.login);
  } catch {
    return identity(IdentityStatus.UNREADABLE);
  }
}
