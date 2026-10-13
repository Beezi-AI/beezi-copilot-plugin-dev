// Owns every read of the Copilot app's data.db: read-only, explicit non-secret columns, never a token or settings column.
import fs from 'fs';
import { copilotAppDbFile } from '../../config/copilot-paths.mjs';
import { loadSqlite } from '../../platform/sqlite.mjs';
import { identityKey, normalizeHost } from '../../core/github-identity.mjs';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { str } from '../../core/guards.mjs';

// Copilot sign-ins only: the app also stores Microsoft (Azure DevOps) accounts in the same table.
const GITHUB_KINDS = "a.kind IN ('github', 'github_enterprise_server')";
// The app's built-in Copilot provider row id is `github_copilot:<uuid>`.
const COPILOT_PROVIDER_TYPE = 'github_copilot';

// True when a session's provider_id names a provider other than the built-in Copilot one (BYOK or on-device); the
// one predicate the live checkpoint and history share. No provider is the built-in one. Pure.
export function isByokProvider(providerId) {
  return typeof providerId === 'string' && providerId !== '' && providerId.split(':')[0] !== COPILOT_PROVIDER_TYPE;
}

export const APP_DB_SQL = Object.freeze({
  session: 'SELECT id FROM sessions WHERE id = ?',
  accounts: `SELECT a.login AS login, a.host AS host, a.is_default AS is_default FROM accounts AS a WHERE ${GITHUB_KINDS} ORDER BY a.created_at, a.id`,
  // The project override the app binds a session to (session_account_projects → projects → accounts).
  boundAccount: 'SELECT a.login AS login, a.host AS host FROM session_account_projects AS s'
    + ' JOIN projects AS p ON p.id = s.project_id JOIN accounts AS a ON a.id = p.copilot_account_id'
    + ` WHERE s.session_id = ? AND ${GITHUB_KINDS}`,
  facts: 'SELECT title, title_source, provider_id, execution_location, forked_from_session_id, fork_original_history_event_count'
    + ' FROM sessions WHERE id = ?',
  nonLocal: "SELECT id, execution_location, total_nano_aiu FROM sessions WHERE execution_location <> 'local' ORDER BY id",
});

function num(v) {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n >= 0 ? n : null;
}

// read(db) on a read-only handle closed afterwards; fallback when Node has no sqlite, there is no data.db, or anything throws.
async function withAppDb(fallback, read) {
  let db = null;
  try {
    const mod = await loadSqlite();
    const file = copilotAppDbFile();
    if (mod == null || !fs.existsSync(file)) return fallback;
    db = new mod.DatabaseSync(file, { readOnly: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    if (db != null) { try { db.close(); } catch { /* already closed */ } }
  }
}

function accountOf(row) {
  const host = row == null ? null : normalizeHost(row.host);
  const login = row == null ? null : str(row.login);
  return identityKey(host, login) == null ? null : { host, login: login.trim() };
}

function readAccounts(db) {
  const out = [];
  for (const row of db.prepare(APP_DB_SQL.accounts).all()) {
    const account = accountOf(row);
    if (account != null) out.push({ host: account.host, login: account.login, isDefault: num(row.is_default) === 1 });
  }
  return out;
}

function hasSession(db, id) {
  return db.prepare(APP_DB_SQL.session).get(id) != null;
}

// True when the Copilot app owns this session id.
export async function isAppSession(id) {
  if (!isUsableSessionId(id)) return false;
  return withAppDb(false, (db) => hasSession(db, id));
}

// The GitHub accounts signed in to the app: [{ host, login, isDefault }].
export async function appAccounts() {
  return withAppDb([], readAccounts);
}

// { host, login } the app ran the session under: its project's account, else the app's only account; null otherwise.
export async function appSessionAccount(id) {
  if (!isUsableSessionId(id)) return null;
  return withAppDb(null, (db) => {
    if (!hasSession(db, id)) return null;
    const bound = accountOf(db.prepare(APP_DB_SQL.boundAccount).get(id));
    if (bound != null) return bound;
    const accounts = readAccounts(db);
    return accounts.length === 1 ? { host: accounts[0].host, login: accounts[0].login } : null;
  });
}

// The app's own facts about a session (title, BYOK provider, where it ran, fork origin), or null when not an app session.
export async function appSessionFacts(id) {
  if (!isUsableSessionId(id)) return null;
  return withAppDb(null, (db) => {
    const statement = db.prepare(APP_DB_SQL.facts);
    if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true);
    const row = statement.get(id);
    if (row == null) return null;
    return {
      title: str(row.title),
      titleSource: str(row.title_source),
      providerId: str(row.provider_id),
      executionLocation: str(row.execution_location),
      forkedFromSessionId: str(row.forked_from_session_id),
      forkHistoryEventCount: num(row.fork_original_history_event_count),
    };
  });
}

// Sessions that ran in the cloud or a remote environment, which write nothing locally: [{ id, executionLocation, totalNanoAiu }].
export async function appNonLocalSessions() {
  return withAppDb([], (db) => {
    const statement = db.prepare(APP_DB_SQL.nonLocal);
    if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true);
    const out = [];
    for (const row of statement.all()) {
      const id = str(row.id);
      if (id != null) out.push({ id, executionLocation: str(row.execution_location), totalNanoAiu: num(row.total_nano_aiu) || 0 });
    }
    return out;
  });
}
