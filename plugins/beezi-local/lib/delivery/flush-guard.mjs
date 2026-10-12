// The account-level frame around one queue pass: the per-account flush lock (owner-checked), the backoff window,
// the once-per-plugin-version re-post of quarantined reports, the pass's failure tally and the health record it leaves.
import fs from 'fs';
import path from 'path';
import { beeziHome, queueDir } from '../config/paths.mjs';
import { readPluginManifest } from '../config/plugin-root.mjs';
import { isBackingOff, readHealth, recordHealth } from '../state/health-record.mjs';
import { acquireDirLock } from '../state/dir-lock.mjs';
import { createReposts } from './rejected-reposts.mjs';

// Two retry answers in a row read as an outage, not one poisoned file: the rest waits for the backoff.
const MAX_RETRIES_IN_A_ROW = 2;
// A hook killed mid-flush must not park the account for long: the holder touches the lock per file, so a minute
// without progress means it died (single-instance-lock's ten minutes fits whole scans, not one flush).
const FLUSH_LOCK_STALE_MS = 60 * 1000;
// A user-run sync waits this long for a live flush to finish; a hook never waits.
const SYNC_LOCK_WAIT_MS = 5 * 1000;

export const FlushSkip = Object.freeze({ BACKOFF: 'backoff', BUSY: 'busy' });

let cachedVersion;

function pluginVersion() {
  if (cachedVersion === undefined) cachedVersion = readPluginManifest().version;
  return cachedVersion;
}

// The postable reports a skipped pass leaves for later.
export function countPostable(dir) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length; } catch { return 0; }
}

// heartbeat() keeps the flush lock fresh and answers whether it is still held; the drain calls it once per queue file.
// reposts: createReposts' answer.
function newPass(reposts, heartbeat) {
  return { reposts, heartbeat, failed: 0, inARow: 0, retryAfterMs: null, error: null, httpStatus: null };
}

// A delivered or judged answer ends a run of retries.
export function noteSettled(pass) {
  pass.inARow = 0;
}

// An answer that is not a delivery; its text and status become the pass's last error.
export function noteError(pass, error, httpStatus) {
  pass.error = error;
  pass.httpStatus = httpStatus;
}

// A retry answer (a missing route, a throttle or a 5xx); true when the pass should stop.
export function noteRetry(pass, error, httpStatus) {
  pass.failed += 1;
  pass.inARow += 1;
  noteError(pass, error, httpStatus);
  return pass.inARow >= MAX_RETRIES_IN_A_ROW;
}

export function noteTransport(pass, kind) {
  pass.failed += 1;
  noteError(pass, kind, null);
}

// An answer that every later post of this target would get too (a dead token, a revoked seat): counted as a failure so
// the account backs off instead of posting its whole queue on every hook.
export function noteRefusal(pass) {
  pass.failed += 1;
}

function passHealth(result, pass, version, dir) {
  return {
    delivered: result.flushed,
    failed: pass.failed,
    retryAfterMs: pass.retryAfterMs,
    error: pass.error,
    httpStatus: pass.httpStatus,
    rejected: result.rejected,
    expired: result.expired,
    quarantined: result.quarantined,
    ...pass.reposts.outcome(dir),
    version,
  };
}

// Runs drain(pass) under the account's flush lock unless the account is backing off (ignoreBackoff skips that gate and
// waits a few seconds for a live holder) or another process is flushing it. → null when it ran, else a FlushSkip.
export async function runGuarded(key, { now, ignoreBackoff, sleep }, drain) {
  const health = readHealth(key);
  if (!ignoreBackoff && isBackingOff(health, now())) return FlushSkip.BACKOFF;
  const lock = await acquireDirLock(path.join(beeziHome(), `queue-flush-${key}.lock`), {
    staleMs: FLUSH_LOCK_STALE_MS, waitMs: ignoreBackoff ? SYNC_LOCK_WAIT_MS : 0, sleep,
  });
  if (lock == null) return FlushSkip.BUSY;
  try {
    const version = pluginVersion();
    // Re-read under the lock: the holder a sync waited for may have just handled some quarantined reports.
    const pass = newPass(createReposts(readHealth(key), version), lock.touch);
    const result = await drain(pass);
    recordHealth(key, passHealth(result, pass, version, queueDir(key)), now());
    return null;
  } finally {
    lock.release();
  }
}
