import fs from 'fs';
import path from 'path';
import { accountsIndexFile, beeziHome, queueDir, stateDir, telemetryDir } from '../config/paths.mjs';
import { recordHealth } from './health-record.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;
const QUEUE_KEEP_MS = 30 * DAY_MS;

// How long a queue file is kept by name: a writer's leftover `.tmp` a day; payloads, `.json.rejected`
// and `.corrupt` 30 days, so a fixed build or a sync can still resend them.
export function queueRetentionMs(name) {
  return name.endsWith('.tmp') ? DAY_MS : QUEUE_KEEP_MS;
}

// Deletes the files, and empty directories such as session-state's *.lock dirs, in `dir` whose mtime is older than
// retentionOf(name); returns the names deleted.
function pruneDir(dir, retentionOf, now) {
  const deleted = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return deleted; } // dir missing → skip
  for (const file of files) {
    const p = path.join(dir, file);
    try {
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > retentionOf(file)) {
        // rmdirSync refuses a non-empty or busy directory, which the catch skips.
        if (stat.isDirectory()) fs.rmdirSync(p);
        else fs.unlinkSync(p);
        deleted.push(file);
      }
    } catch { /* skip unreadable/racing file */ }
  }
  return deleted;
}

// The single-account migration journal outlives its use once the accounts index exists; before that a migration may
// still be reading it.
function pruneMigrationJournal() {
  try {
    if (fs.existsSync(accountsIndexFile())) fs.unlinkSync(path.join(beeziHome(), 'accounts.migration.json'));
  } catch { /* absent or racing */ }
}

// Sweeps state/ and telemetry/ by maxAgeMs and every account's queue/ by queueRetentionMs, counting each queued report
// that ages out into that account's health record. Best-effort: never throws. `now` injectable for deterministic tests.
export function pruneStale({ accountKeys = [], now = Date.now(), maxAgeMs = FOURTEEN_DAYS_MS } = {}) {
  for (const dir of [stateDir(), telemetryDir()]) pruneDir(dir, () => maxAgeMs, now);
  pruneMigrationJournal();
  for (const key of accountKeys) {
    let dir;
    // queueDir throws on a malformed key; one bad row must not abort the sweep.
    try { dir = queueDir(key); } catch { continue; }
    const expired = pruneDir(dir, queueRetentionMs, now).filter((name) => name.endsWith('.json')).length;
    if (expired > 0) recordHealth(key, { expired }, now);
  }
}
