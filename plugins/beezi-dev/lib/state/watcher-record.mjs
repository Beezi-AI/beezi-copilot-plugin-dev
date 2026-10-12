// The session watcher's observation watermark (watcher.json): its shape, load/save, the per-session observations and the status read.
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { isWatcherEnabled } from '../config/flags.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { readLease, leaseHolderAlive } from '../platform/lease.mjs';
import { finiteNumber, isPlain } from '../core/guards.mjs';

const MAX_OBSERVATIONS = 2000;
const WATERMARK_VERSION = 1;
export const ELECTION_NAME = 'watcher-election';
// 4.5 ticks, so a renew never races its own expiry.
export const ELECTION_LEASE_MS = 90000;

// Data-root level, outside state/, so pruneStale never deletes it; it records what was last SEEN, never which lines to read.
export function watcherFile() {
  return path.join(beeziHome(), 'watcher.json');
}

// `settled` maps a recipient's settlement key to { sessionId: mtimeMs } for history it settled. Writers before it drop
// the field, which costs at most one repeated history run per session.
export function emptyWatermark() {
  return { version: WATERMARK_VERSION, sessions: {}, housekeepingAt: null, lastScanAt: null, historyAt: {}, settled: {}, updatedAt: null };
}

// Any other version is discarded rather than migrated.
export function loadWatermark() {
  let raw = null;
  try { raw = readJson(watcherFile(), null); } catch { raw = null; }
  if (!isPlain(raw) || raw.version !== WATERMARK_VERSION) return emptyWatermark();
  return {
    version: WATERMARK_VERSION,
    sessions: isPlain(raw.sessions) ? raw.sessions : {},
    housekeepingAt: finiteNumber(raw.housekeepingAt),
    lastScanAt: finiteNumber(raw.lastScanAt),
    historyAt: isPlain(raw.historyAt) ? raw.historyAt : {},
    settled: isPlain(raw.settled) ? raw.settled : {},
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function saveWatermark(record) {
  try {
    writeJsonSecure(watcherFile(), { ...record, updatedAt: new Date().toISOString() });
  } catch { /* a watermark that could not be saved costs one repeated read next pass */ }
}

// The stored observation of a session, or null when it has no usable mtime.
export function observationFor(record, sessionId) {
  if (!Object.prototype.hasOwnProperty.call(record.sessions, sessionId)) return null;
  const entry = record.sessions[sessionId];
  return isPlain(entry) && finiteNumber(entry.mtimeMs) !== null ? entry : null;
}

export function keptField(entry, field) {
  return isPlain(entry) && finiteNumber(entry[field]) !== null ? entry[field] : null;
}

// One recipient (an account, and its workspace when it has several) of the watcher's history repair.
export function settlementKey(accountKey, tenantId) {
  return `${accountKey}:${tenantId == null ? '' : tenantId}`;
}

// The recipient's history settled the session at the mtime the scan entry shows.
export function isSettled(record, key, entry) {
  const settled = isPlain(record.settled) ? record.settled[key] : null;
  return isPlain(settled) && Object.prototype.hasOwnProperty.call(settled, entry.sessionId) && settled[entry.sessionId] === entry.mtimeMs;
}

// → whether anything changed.
export function markSettled(record, key, entry) {
  if (isSettled(record, key, entry)) return false;
  if (!isPlain(record.settled)) record.settled = {};
  if (!isPlain(record.settled[key])) record.settled[key] = {};
  record.settled[key][entry.sessionId] = entry.mtimeMs;
  return true;
}

// Keeps only the settlements of sessions `keep` accepts, and drops recipients left with none. → whether anything changed.
function keepSettled(record, keep) {
  if (!isPlain(record.settled)) return false;
  let changed = false;
  for (const key of Object.keys(record.settled)) {
    const settled = record.settled[key];
    if (isPlain(settled)) {
      for (const id of Object.keys(settled)) {
        if (!keep(id)) { delete settled[id]; changed = true; }
      }
    }
    if (!isPlain(settled) || Object.keys(settled).length === 0) { delete record.settled[key]; changed = true; }
  }
  return changed;
}

// Replaces a session's observation with the scan entry's mtime and size, keeping the hook stamp (and oversizeAt unless given).
// A new observation supersedes the session's history settlements.
export function storeObservation(record, entry, { at, cursorAfter, oversizeAt = null }) {
  if (isPlain(record.settled)) {
    for (const settled of Object.values(record.settled)) if (isPlain(settled)) delete settled[entry.sessionId];
  }
  const stored = record.sessions[entry.sessionId];
  record.sessions[entry.sessionId] = {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    at,
    cursorAfter,
    hookSeenAt: keptField(stored, 'hookSeenAt'),
    oversizeAt: oversizeAt === null ? keptField(stored, 'oversizeAt') : oversizeAt,
  };
}

// Bounded and cleaned: evict the oldest observation first, and drop sessions no longer listed. Returns whether anything went.
export function trimWatermark(record, listedIds) {
  let changed = keepSettled(record, (id) => listedIds.has(id));
  for (const id of Object.keys(record.sessions)) {
    if (!listedIds.has(id)) { delete record.sessions[id]; changed = true; }
  }
  const ids = Object.keys(record.sessions);
  if (ids.length > MAX_OBSERVATIONS) {
    const at = (id) => (isPlain(record.sessions[id]) && finiteNumber(record.sessions[id].at) !== null ? record.sessions[id].at : 0);
    ids.sort((a, b) => at(a) - at(b));
    for (let i = 0; i < ids.length - MAX_OBSERVATIONS; i += 1) delete record.sessions[ids[i]];
    changed = true;
  }
  return changed;
}

// Synchronous, takes no lock, never throws; null when the watcher is off or has left no trace.
export function readWatcherStatus() {
  try {
    if (!isWatcherEnabled(process.env)) return null;
    const record = readJson(watcherFile(), null);
    const lease = readLease(ELECTION_NAME);
    if (!isPlain(record) && lease == null) return null;
    const lastScanAt = isPlain(record) ? finiteNumber(record.lastScanAt) : null;
    const running = lease != null && Date.now() - lease.renewedAt <= ELECTION_LEASE_MS && leaseHolderAlive(lease);
    return { running, lastScanAt, electedPid: lease == null ? null : lease.pid };
  } catch {
    return null;
  }
}
