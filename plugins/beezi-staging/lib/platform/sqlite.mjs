// Owns the only node:sqlite load: one guarded dynamic import, memoized, resolving to null where Node lacks it.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let sqliteLoad = null;

// The synchronous database class under either export name: DatabaseSync is a deprecated alias of Database.
export function databaseClassOf(mod) {
  if (mod == null) return null;
  if (typeof mod.DatabaseSync === 'function') return mod.DatabaseSync;
  return typeof mod.Database === 'function' ? mod.Database : null;
}

// True when `{ readOnly: true }` is honoured: a read-only open of a missing file must fail instead of creating it.
export function honoursReadOnly(Database, file = path.join(os.tmpdir(), `beezi-sqlite-ro-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`)) {
  let db;
  try {
    db = new Database(file, { readOnly: true });
  } catch {
    return true;
  }
  try { db.close(); } catch { /* already closed */ }
  try { fs.unlinkSync(file); } catch { /* never created */ }
  return false;
}

// { DatabaseSync } for callers, or null when Node has no node:sqlite or would ignore readOnly and open Copilot's DB writable.
export function sqliteApi(mod, readOnlyProbe = honoursReadOnly) {
  const Database = databaseClassOf(mod);
  if (Database == null || !readOnlyProbe(Database)) return null;
  return { DatabaseSync: Database };
}

// Guarded dynamic import: a static import would break the Node 13.2 floor at load time.
export function loadSqlite() {
  if (sqliteLoad) return sqliteLoad;
  const original = process.emitWarning;
  // Only the SQLite ExperimentalWarning is dropped, and only while the import runs.
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
    .then((mod) => sqliteApi(mod))
    .catch(() => null)
    .then((api) => { process.emitWarning = original; return api; });
  return sqliteLoad;
}
