// Owns the machine's record of the last offer scan per workspace (the exact session ids and hidden kinds its question showed)
// and the session ids each workspace's offers were declined for; every read-modify-write runs under the accounts index lock.
import crypto from 'crypto';
import { historyOfferFile } from '../config/paths.mjs';
import { readJson, writeJsonSecure, removePath } from '../platform/fs-store.mjs';
import { withIndexLock } from '../accounts/index-store.mjs';
import { changedSince, hiddenKindsOf } from './pending-history.mjs';

const RECORD_VERSION = 1;
const MODES = ['sync', 'backfill'];

const isMap = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const isIdList = (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id !== '');

function readRecord(key) {
  const raw = readJson(historyOfferFile(key), null);
  if (raw == null || raw.version !== RECORD_VERSION) return { scans: {}, declined: {} };
  return { scans: isMap(raw.scans) ? raw.scans : {}, declined: isMap(raw.declined) ? raw.declined : {} };
}

// createDir off: a missing accounts/<key>/ means a logout won the race, and this write must not bring it back.
function writeRecord(key, { scans, declined }) {
  try {
    if (Object.keys(scans).length === 0 && Object.keys(declined).length === 0) removePath(historyOfferFile(key), { force: true });
    else writeJsonSecure(historyOfferFile(key), { version: RECORD_VERSION, scans, declined }, { createDir: false });
  } catch { /* a failed write leaves the previous record, which the next scan or decline rewrites */ }
}

function mutateRecord(key, change) {
  return withIndexLock(async () => {
    const record = readRecord(key);
    const result = change(record);
    writeRecord(key, record);
    return result;
  });
}

function declinedEntry(record, tenantId) {
  const entry = record.declined[tenantId];
  if (!isMap(entry) || !isIdList(entry.ids)) return null;
  return { changedAt: typeof entry.changedAt === 'string' ? entry.changedAt : null, ids: entry.ids };
}

// The workspace's scan, or null when there is none or it is malformed; shownKinds missing or invalid reads as every kind.
export function readOfferScan(key, tenantId) {
  const scan = readRecord(key).scans[tenantId];
  if (!isMap(scan) || !isIdList(scan.sessionIds) || MODES.indexOf(scan.mode) === -1) return null;
  return { ...scan, shownKinds: hiddenKindsOf(scan.shownKinds) };
}

export function writeOfferScan(key, tenantId, { sessionIds, mode, unrouted, count, firstMs, lastMs, audit, scannedAt, shownKinds }) {
  return mutateRecord(key, (record) => {
    record.scans[tenantId] = { sessionIds, mode, unrouted, count, firstMs, lastMs, audit, scannedAt, shownKinds };
  });
}

// Deletes the workspace's scan only while it is still the one stamped scannedAt; resolves whether it deleted.
export function clearOfferScan(key, tenantId, { scannedAt }) {
  return mutateRecord(key, (record) => {
    const scan = record.scans[tenantId];
    if (!isMap(scan) || scan.scannedAt !== scannedAt) return false;
    delete record.scans[tenantId];
    return true;
  });
}

// The token an <offer> block's accept command carries: a short hash of the session ids and the hidden kinds it showed.
export function offerToken(sessionIds, shownKinds) {
  const preimage = `${sessionIds.join('\n')}\0${shownKinds.slice().sort().join(',')}`;
  return crypto.createHash('sha256').update(preimage).digest('hex').slice(0, 12);
}

// Unions into the remembered declines while changedAt has not moved past them, else starts over under changedAt.
export function rememberDeclined(key, tenantId, { ids, changedAt }) {
  return mutateRecord(key, (record) => {
    const stored = declinedEntry(record, tenantId);
    record.declined[tenantId] = stored == null || changedSince(changedAt, stored.changedAt)
      ? { changedAt, ids: [...new Set(ids)] }
      : { changedAt: stored.changedAt, ids: [...new Set([...stored.ids, ...ids])] };
  });
}

export function forgetDeclined(key, tenantId, ids) {
  return mutateRecord(key, (record) => {
    const stored = declinedEntry(record, tenantId);
    if (stored == null) return;
    const kept = stored.ids.filter((id) => ids.indexOf(id) === -1);
    if (kept.length === 0) delete record.declined[tenantId];
    else record.declined[tenantId] = { changedAt: stored.changedAt, ids: kept };
  });
}

export function declinedIds(key, tenantId, changedAt) {
  const stored = declinedEntry(readRecord(key), tenantId);
  return stored == null || changedSince(changedAt, stored.changedAt) ? new Set() : new Set(stored.ids);
}
