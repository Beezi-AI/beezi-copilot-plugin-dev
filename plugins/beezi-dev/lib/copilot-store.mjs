import fs from 'fs';
import { copilotSessionStoreDb } from './copilot-paths.mjs';

export const STORE_REASON = Object.freeze({
  NO_SQLITE: 'no-sqlite', NO_DB: 'no-db', NO_TABLE: 'no-table', SCHEMA: 'schema',
  BUSY: 'busy', ERROR: 'error', DISABLED: 'disabled',
});
const GONE = [STORE_REASON.NO_DB, STORE_REASON.NO_TABLE, STORE_REASON.SCHEMA];

// The database file itself cannot yield rows for any process.
export function isStoreGone(reason) {
  return GONE.indexOf(reason) !== -1;
}

// Decided from the database or the Node build, not from this moment: a null-mode session may go to totals.
export function isDefinitiveReason(reason) {
  return reason === STORE_REASON.NO_SQLITE || isStoreGone(reason);
}

const TABLE = 'assistant_usage_events';
const REQUIRED = ['session_id', 'model', 'input_tokens', 'output_tokens'];
const OPTIONAL = {
  turnIndex: 'turn_index', agentId: 'agent_id', parentToolCallId: 'parent_tool_call_id',
  cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens',
  reasoningTokens: 'reasoning_tokens', nanoAiu: 'total_nano_aiu',
  requestMultiplier: 'request_multiplier', reasoningEffort: 'reasoning_effort', initiator: 'initiator',
};
// V-09: created_at (ISO-8601 UTC, set when the call ends) is the real column; the rest are fallbacks.
const TIME_COLUMNS = ['created_at', 'timestamp', 'created', 'ts'];
const TWIN_COLUMNS = [
  'agent_id', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'total_nano_aiu', 'duration_ms', 'time_to_first_token_ms',
];
const ZONELESS_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

let sqliteLoad = null;

// Guarded dynamic import: a static import would break the Node 13.2 floor at load time.
export function loadSqlite() {
  if (sqliteLoad) return sqliteLoad;
  const original = process.emitWarning;
  // Only the SQLite ExperimentalWarning is dropped, and only while the import runs (V-12).
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] != null ? rest[0].type : null);
    const text = typeof warning === 'string' ? warning : (warning != null ? warning.message : '');
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(text))) return undefined;
    return original.apply(process, [warning, ...rest]);
  };
  let started;
  try {
    started = import('node:sqlite');
  } catch {
    started = Promise.reject(new Error('no-sqlite'));
  }
  sqliteLoad = started
    .then((mod) => (mod != null && typeof mod.DatabaseSync === 'function' ? mod : null))
    .catch(() => null)
    .then((mod) => { process.emitWarning = original; return mod; });
  return sqliteLoad;
}

function num(v) {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0;
}

function numOrNull(v) {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) && n >= 0 ? n : null;
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// Epoch seconds or ms, or text; a zone-less SQLite datetime is UTC by convention.
function isoOf(v) {
  const n = typeof v === 'bigint' ? Number(v) : v;
  let ms = NaN;
  if (typeof n === 'number' && isFinite(n)) ms = n < 1e12 ? n * 1000 : n;
  else if (typeof n === 'string' && n !== '') ms = Date.parse(ZONELESS_TS.test(n) ? `${n.replace(' ', 'T')}Z` : n);
  if (!Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

function busyLike(error) {
  const text = error != null && typeof error.message === 'string' ? error.message : '';
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(text);
}

function quoted(name) {
  return `"${name}"`;
}

// Per-call usage rows of one session after `afterRowId`, oldest first. Read-only; never throws.
export async function readUsageRows(sessionId, { afterRowId = 0, limit = 5000 } = {}) {
  const none = (reason) => ({ available: false, reason, rows: [] });
  let db = null;
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return none(STORE_REASON.ERROR);
    const mod = await loadSqlite();
    if (mod == null) return none(STORE_REASON.NO_SQLITE);
    const file = copilotSessionStoreDb();
    if (!fs.existsSync(file)) return none(STORE_REASON.NO_DB);
    // V-27 default: the read-only open option; the handle is closed in finally.
    db = new mod.DatabaseSync(file, { readOnly: true });
    const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all().map((c) => c.name);
    if (columns.length === 0) return none(STORE_REASON.NO_TABLE);
    for (const name of REQUIRED) if (columns.indexOf(name) === -1) return none(STORE_REASON.SCHEMA);

    const optional = Object.keys(OPTIONAL).filter((key) => columns.indexOf(OPTIONAL[key]) !== -1);
    let timeColumn = null;
    for (const name of TIME_COLUMNS) if (columns.indexOf(name) !== -1) { timeColumn = name; break; }
    const aliased = (name) => `t.${quoted(name)} AS ${quoted(name)}`;
    const select = ['t.rowid AS beezi_rowid']
      .concat(REQUIRED.map(aliased))
      .concat(optional.map((key) => aliased(OPTIONAL[key])))
      .concat(timeColumn == null ? [] : [aliased(timeColumn)]);
    let twinFilter = '';
    if (timeColumn != null) {
      const same = [timeColumn].concat(TWIN_COLUMNS.filter((name) => columns.indexOf(name) !== -1))
        .map((name) => ` AND o.${quoted(name)} IS t.${quoted(name)}`).join('');
      // Copilot re-inserts a call under a new rowid (turn_index may differ); only the earliest copy is kept.
      twinFilter = ` AND NOT EXISTS (SELECT 1 FROM ${TABLE} AS o WHERE o."session_id" = t."session_id" AND o.rowid < t.rowid${same})`;
    }
    const statement = db.prepare(
      `SELECT ${select.join(', ')} FROM ${TABLE} AS t WHERE t."session_id" = ? AND t.rowid > ?${twinFilter} ORDER BY t.rowid LIMIT ?`,
    );
    // BigInt reads keep an oversized integer from throwing the whole query; num() folds them back.
    if (typeof statement.setReadBigInts === 'function') statement.setReadBigInts(true);
    const after = Number.isInteger(afterRowId) && afterRowId > 0 ? afterRowId : 0;
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20000) : 5000;

    const has = (key) => optional.indexOf(key) !== -1;
    const rows = [];
    for (const r of statement.all(sessionId, after, cap)) {
      rows.push({
        rowId: num(r.beezi_rowid),
        sessionId,
        turnIndex: has('turnIndex') ? numOrNull(r[OPTIONAL.turnIndex]) : null,
        agentId: has('agentId') ? str(r[OPTIONAL.agentId]) : null,
        parentToolCallId: has('parentToolCallId') ? str(r[OPTIONAL.parentToolCallId]) : null,
        model: str(r.model) == null ? 'unknown' : r.model,
        inputTokens: num(r.input_tokens),
        outputTokens: num(r.output_tokens),
        cacheReadTokens: has('cacheReadTokens') ? num(r[OPTIONAL.cacheReadTokens]) : 0,
        cacheWriteTokens: has('cacheWriteTokens') ? num(r[OPTIONAL.cacheWriteTokens]) : 0,
        reasoningTokens: has('reasoningTokens') ? num(r[OPTIONAL.reasoningTokens]) : 0,
        nanoAiu: has('nanoAiu') ? numOrNull(r[OPTIONAL.nanoAiu]) : null,
        requestMultiplier: has('requestMultiplier') ? numOrNull(r[OPTIONAL.requestMultiplier]) : null,
        reasoningEffort: has('reasoningEffort') ? str(r[OPTIONAL.reasoningEffort]) : null,
        initiator: has('initiator') ? str(r[OPTIONAL.initiator]) : null,
        at: timeColumn == null ? null : isoOf(r[timeColumn]),
      });
    }
    return { available: true, reason: null, rows };
  } catch (error) {
    if (busyLike(error)) return none(STORE_REASON.BUSY);
    // A WITHOUT ROWID table has no rowid to page on.
    if (error != null && /no such column/i.test(String(error.message))) return none(STORE_REASON.SCHEMA);
    return none(STORE_REASON.ERROR);
  } finally {
    if (db != null) { try { db.close(); } catch { /* already closed */ } }
  }
}
