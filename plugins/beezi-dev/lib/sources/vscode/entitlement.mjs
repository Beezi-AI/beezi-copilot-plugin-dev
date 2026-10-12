// VS Code's own resolved Copilot entitlement: state.vscdb ItemTable['chat.setupContext'], read-only. It belongs
// to VS Code's default account and names no login, so billing attributes it; only `entitlement` and `sku` leave the row,
// plus the install's GitHub host from the cached policy, so the sync sign-in reader can key a GHE.com login.
import fs from 'fs';
import { vscodeInstalls, vscodeStateDb } from '../../config/copilot-paths.mjs';
import { loadSqlite } from '../../platform/sqlite.mjs';
import { isPlain, nonEmpty } from '../../core/guards.mjs';
import { policyHost, readStatePolicy } from './account.mjs';

const SETUP_CONTEXT_KEY = 'chat.setupContext';

// { entitlement, sku } from the stored JSON (TEXT or BLOB), or null when it carries no integer entitlement. Pure.
export function parseSetupContext(value) {
  let raw = null;
  try {
    raw = JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlain(raw) || !Number.isInteger(raw.entitlement)) return null;
  return { entitlement: raw.entitlement, sku: nonEmpty(raw.sku) ? raw.sku.trim().toLowerCase() : null };
}

// { entitlement, sku, host } of one state.vscdb: its setupContext (both null without one) and the host its default account
// signs in to (null for an enterprise sign-in with no readable tenant); null when the database does not open.
function readInstall(sqlite, file) {
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(SETUP_CONTEXT_KEY);
    const context = row == null ? null : parseSetupContext(row.value);
    let host = null;
    try { host = policyHost(readStatePolicy(db)); } catch { host = null; }
    return { entitlement: context == null ? null : context.entitlement, sku: context == null ? null : context.sku, host };
  } catch {
    return null;
  } finally {
    if (db != null) { try { db.close(); } catch { /* already closed */ } }
  }
}

// [{ product, userDir, entitlement, sku, host }] for each VS Code install whose state.vscdb opens (entitlement and sku null
// when it stored no setupContext); null where Node has no SQLite. Never throws.
export async function readVscodeEntitlements({ installs = vscodeInstalls(), load = loadSqlite } = {}) {
  try {
    const files = installs.map((install) => ({ product: install.product, userDir: install.userDir, file: vscodeStateDb(install.userDir) }))
      .filter((x) => fs.existsSync(x.file));
    if (files.length === 0) return [];
    const sqlite = await load();
    if (sqlite == null) return null;
    const out = [];
    for (const { product, userDir, file } of files) {
      const read = readInstall(sqlite, file);
      if (read != null) out.push({ product, userDir, ...read });
    }
    return out;
  } catch {
    return [];
  }
}
