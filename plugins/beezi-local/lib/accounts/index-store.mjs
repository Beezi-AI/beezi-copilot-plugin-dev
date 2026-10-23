// Owns the linked-accounts index: its lock, reads, row CRUD and the default account.
import { acquireCredentialLock, releaseCredentialLock } from '../credentials/credential-lock.mjs';
import crypto from 'crypto';
import fs from 'fs';
import { accountsIndexFile, accountDir } from '../config/paths.mjs';
import { readJson, writeJsonSecure, removePath } from '../platform/fs-store.mjs';
import { UserError } from '../core/errors.mjs';
import { matchAccountRef, splitAccountFlag } from './refs.mjs';

const INDEX_VERSION = 1;
const INDEX_LOCK_WAIT_MS = 2_000;

export const AccountStatus = Object.freeze({ LINKED: 'linked', REVOKED: 'revoked' });

// The UserError message for a key with no row, so a caller can tell it from the lock and unreadable-index errors.
export const NO_SUCH_ACCOUNT = 'No such linked account.';

export function newAccountKey() {
  return crypto.randomBytes(4).toString('hex');
}

function emptyIndex() {
  return { version: INDEX_VERSION, default: null, accounts: [] };
}

function normalize(raw) {
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts.filter((a) => a && typeof a.key === 'string' && /^[0-9a-f]{8}$/.test(a.key));
  let def = accounts.some((a) => a.key === raw.default) ? raw.default : null;
  // A lone linked account is the default in memory, so a lost `default` is never a dead end.
  if (def == null) {
    const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
    if (linked.length === 1) def = linked[0].key;
  }
  return { version: INDEX_VERSION, default: def, accounts };
}

function writeIndex(index) {
  writeJsonSecure(accountsIndexFile(), index);
}

// The same pid/start-time/nonce lock discipline as credential writes, including crash recovery.
export async function withIndexLock(fn) {
  const lock = await acquireCredentialLock({ index: true, waitMs: INDEX_LOCK_WAIT_MS });
  if (!lock) throw new UserError('Accounts are being updated by another Beezi process. Try again.');
  try {
    if (fs.existsSync(accountsIndexFile()) && !normalize(readJson(accountsIndexFile(), null))) {
      throw new UserError('The Beezi accounts index is unreadable. Restore accounts.json before changing linked accounts.');
    }
    return await fn();
  } finally { releaseCredentialLock(lock); }
}

// A missing or unreadable index is an empty one: no lock, no write (a Copilot data root never had a single-account store).
export async function readIndex() {
  const existing = normalize(readJson(accountsIndexFile(), null));
  return existing == null ? emptyIndex() : existing;
}

export async function listAccounts() {
  return (await readIndex()).accounts;
}

export async function getAccount(key) {
  const found = (await listAccounts()).find((a) => a.key === key);
  return found == null ? null : found;
}

export async function findByEmail(email) {
  if (!email) return null;
  const wanted = String(email).toLowerCase();
  const found = (await listAccounts()).find((a) => a.email != null && a.email.toLowerCase() === wanted);
  return found == null ? null : found;
}

export async function getDefaultKey() {
  return (await readIndex()).default;
}

export function setDefault(key) {
  return withIndexLock(async () => {
    const index = await readIndex();
    if (!index.accounts.some((a) => a.key === key)) throw new UserError(NO_SUCH_ACCOUNT);
    index.default = key;
    writeIndex(index);
    return index;
  });
}

export function addAccount(row) {
  return withIndexLock(async () => {
    const index = await readIndex();
    index.accounts = index.accounts.filter((a) => a.key !== row.key);
    index.accounts.push({
      key: row.key,
      email: row.email == null ? null : String(row.email).toLowerCase(),
      name: row.name == null ? null : row.name,
      tenantId: row.tenantId == null ? null : row.tenantId,
      tenantName: row.tenantName == null ? null : row.tenantName,
      tenants: Array.isArray(row.tenants) ? row.tenants : null,
      anonymization: row.anonymization == null ? null : row.anonymization,
      pastSessions: row.pastSessions == null ? null : row.pastSessions,
      newFolders: row.newFolders != null && typeof row.newFolders === 'object' ? row.newFolders : null,
      workspaceRules: Array.isArray(row.workspaceRules) ? row.workspaceRules : [],
      clientId: row.clientId == null ? null : row.clientId,
      linkedAt: row.linkedAt == null ? new Date().toISOString() : row.linkedAt,
      status: row.status == null ? AccountStatus.LINKED : row.status,
    });
    if (index.default == null) index.default = row.key;
    fs.mkdirSync(accountDir(row.key), { recursive: true, mode: 0o700 });
    writeIndex(index);
    return index;
  });
}

// null and undefined both mean "leave it alone": no caller clears a field.
export function updateAccount(key, patch) {
  return withIndexLock(async () => {
    const index = await readIndex();
    const row = index.accounts.find((a) => a.key === key);
    if (!row) return index;
    for (const field of ['email', 'name', 'tenantId', 'tenantName', 'tenants', 'anonymization', 'pastSessions', 'newFolders', 'workspaceRules', 'clientId', 'linkedAt', 'status']) {
      if (patch[field] == null) continue;
      row[field] = field === 'email' ? String(patch[field]).toLowerCase() : patch[field];
    }
    // A row with no link time measures later joins from its first refresh (newTenantsOf).
    if (row.linkedAt == null && row.reviewBaselineAt == null) row.reviewBaselineAt = new Date().toISOString();
    writeIndex(index);
    return index;
  });
}

// Runs fn(row) on one account row under the index lock and saves the index; a throwing fn saves nothing.
export function mutateRow(key, fn) {
  return withIndexLock(async () => {
    const index = await readIndex();
    const row = index.accounts.find((a) => a.key === key);
    if (!row) throw new UserError(NO_SUCH_ACCOUNT);
    const result = fn(row);
    writeIndex(index);
    return result;
  });
}

export function removeAccount(key) {
  return withIndexLock(async () => {
    const index = await readIndex();
    index.accounts = index.accounts.filter((a) => a.key !== key);
    if (index.default === key) index.default = null;
    writeIndex(index);
    try { removePath(accountDir(key), { recursive: true, force: true }); } catch { /* best-effort */ }
    return index;
  });
}

// A key, an email, or a 1-based position in listAccounts() order.
export async function resolveAccountRef(ref) {
  return matchAccountRef(await listAccounts(), ref);
}

// Strips --account <ref> out of argv; `account` is the resolved key or null.
export async function parseAccountFlag(argv) {
  const { ref, rest } = splitAccountFlag(argv);
  return { account: ref == null ? null : await resolveAccountRef(ref), rest };
}
