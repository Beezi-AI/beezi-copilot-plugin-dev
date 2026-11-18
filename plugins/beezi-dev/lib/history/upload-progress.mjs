import path from 'path';
import { accountDir, beeziHome, tenantTag } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';

const LIVE_MS = 120000;

// Root-level and not under state/: the state dir's `*.json` scans read every file there as a session.
function progressDir() {
  return path.join(beeziHome(), 'upload-progress');
}

// accountDir rejects any key but 8 lowercase hex, so the key never escapes into the file name.
export function progressPath(key, tenantId) {
  return path.join(progressDir(), `${path.basename(accountDir(key))}-${tenantTag(tenantId)}.json`);
}

// One run's record: writes at most once per throttleMs while running, and always on finish; a finish with failed: true marks a run that didn't end clean.
export function createProgressWriter({ key, tenantId, workspace, now = Date.now, throttleMs = 1000 }) {
  let startedAt = null;
  let lastWriteMs = null;
  function write({ processed, total, sent, failed }, atMs, finished) {
    const at = new Date(atMs).toISOString();
    if (startedAt == null) startedAt = at;
    lastWriteMs = atMs;
    const record = {
      key, tenantId, workspace, processed, total, sent,
      startedAt, updatedAt: at, finishedAt: finished ? at : null, reported: false,
    };
    if (failed === true) record.failed = true;
    writeJsonSecure(progressPath(key, tenantId), record);
  }
  return {
    update(counts) {
      const atMs = now();
      if (lastWriteMs != null && atMs - lastWriteMs < throttleMs) return;
      write(counts, atMs, false);
    },
    finish(counts) {
      write(counts, now(), true);
    },
  };
}

// A key that fails the account-key check reads as no record.
export function readProgress(key, tenantId) {
  let file;
  try {
    file = progressPath(key, tenantId);
  } catch {
    return null;
  }
  return readJson(file, null);
}

export function isLive(record, nowMs) {
  return record != null && record.finishedAt == null && nowMs - Date.parse(record.updatedAt) <= LIVE_MS;
}

export function markReported(key, tenantId) {
  const record = readProgress(key, tenantId);
  if (record == null) return;
  writeJsonSecure(progressPath(key, tenantId), Object.assign({}, record, { reported: true }));
}
