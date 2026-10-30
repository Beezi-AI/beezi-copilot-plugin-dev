import { getAuthentication as _getAuthentication } from './token.mjs';
import { listAccounts as _listAccounts, getDefaultKey as _getDefaultKey, AccountStatus } from '../accounts/index-store.mjs';
import { BEEZI_ENV } from '../config/paths.mjs';
import { LEGACY_PRODUCTION_API_ORIGIN, PRODUCTION_API_ORIGIN } from '../config/api.mjs';

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

// `session` carrying the API-origin pin of the credential `auth` was read from. Every session built from an
// authentication result goes through here; a credential without api_origin (an older login) adds no pin.
export function pinnedTo(session, auth) {
  if (auth == null || auth.apiOrigin == null) return session;
  const legacy = BEEZI_ENV === '' && auth.apiOrigin === LEGACY_PRODUCTION_API_ORIGIN;
  return { ...session, apiOrigin: legacy ? PRODUCTION_API_ORIGIN : auth.apiOrigin };
}

// One credential read for `session` (a row mapped by toSession): the session with its token, or null when it has none.
export async function withToken(session, deps = {}) {
  if (deps.getAccessToken && !deps.getAuthentication) {
    const token = await deps.getAccessToken(deps, { account: session.key }).catch(() => null);
    return token ? { ...session, token } : null;
  }
  const auth = await (deps.getAuthentication || _getAuthentication)(deps, { account: session.key }).catch(() => null);
  if (auth == null || auth.authState !== 'ready') return null;
  return pinnedTo({ ...session, token: auth.accessToken, clientId: auth.clientId == null ? null : auth.clientId }, auth);
}

async function resolve(row, deps) {
  if (row == null || row.status !== AccountStatus.LINKED) return null;
  return withToken(toSession(row, null), deps);
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

// Every linked account as a token-less session, without touching the credential store: enough to enqueue for it.
export async function linkedRecipients(deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((row) => row.status === AccountStatus.LINKED).map((row) => toSession(row, null));
}

// Every linked account with a usable token, resolved concurrently; failures are dropped for this call.
export async function linkedSessions(deps = {}) {
  const recipients = await linkedRecipients(deps);
  const sessions = await Promise.all(recipients.map((session) => withToken(session, deps)));
  return sessions.filter((s) => s != null);
}

// Plugin diagnostics go through one account: the default when it is live, else the first.
export function diagnosticsSession(sessions, defaultKey = null) {
  if (!sessions || sessions.length === 0) return null;
  const def = sessions.find((s) => s.key === defaultKey);
  return def == null ? sessions[0] : def;
}
