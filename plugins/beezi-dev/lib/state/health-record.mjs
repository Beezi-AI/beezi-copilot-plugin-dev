// Per-account delivery health (accounts/<key>/health.json): the last flush failure, refusal and expiry totals, the flush
// backoff and the plugin version whose quarantined reports were already re-posted. /beezi-dev-status reads healthSummary().
import fs from 'fs';
import path from 'path';
import { accountDir, queueDir } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';

const HEALTH_VERSION = 1;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
// A postable report older than this means delivery is stalled.
const STALE_QUEUE_MS = 24 * 60 * 60 * 1000;

function healthFile(key) {
  return path.join(accountDir(key), 'health.json');
}

const countOf = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const textOf = (value) => (typeof value === 'string' && value !== '' ? value : null);
const timeOf = (value) => (typeof value === 'number' && isFinite(value) && value > 0 ? value : null);
const objectOf = (value) => (value != null && typeof value === 'object' ? value : {});
const textsOf = (value) => (Array.isArray(value) ? value.filter((v) => textOf(v) != null) : []);

// The quarantined files already handled under one plugin version, or null.
function triedOf(value) {
  const v = objectOf(value);
  return textOf(v.version) == null ? null : { version: v.version, files: textsOf(v.files) };
}

// A missing, foreign or damaged record reads as a healthy account that never failed.
export function normalizeHealth(raw) {
  const r = raw != null && typeof raw === 'object' && raw.version === HEALTH_VERSION ? raw : {};
  const totals = objectOf(r.totals);
  const backoff = objectOf(r.backoff);
  return {
    version: HEALTH_VERSION,
    lastError: textOf(r.lastError),
    lastErrorAt: timeOf(r.lastErrorAt),
    lastHttpStatus: Number.isInteger(r.lastHttpStatus) ? r.lastHttpStatus : null,
    totals: { rejected: countOf(totals.rejected), expired: countOf(totals.expired), quarantined: countOf(totals.quarantined) },
    backoff: { failures: countOf(backoff.failures), until: timeOf(backoff.until) },
    rejectedRetriedFor: textOf(r.rejectedRetriedFor),
    rejectedTried: triedOf(r.rejectedTried),
  };
}

// Exponential from 30 s to 15 min by consecutive failed passes; a longer Retry-After wins.
export function backoffDelayMs(failures, retryAfterMs = null) {
  const exponential = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failures - 1)), BACKOFF_MAX_MS);
  return retryAfterMs != null && retryAfterMs > exponential ? retryAfterMs : exponential;
}

export function isBackingOff(health, now) {
  return health.backoff.until != null && health.backoff.until > now;
}

// The record after one pass. pass: { delivered, failed, retryAfterMs, error, httpStatus, rejected, expired, quarantined,
// rejectedTried, rejectedDone, version }, every field optional. A pass that delivered nothing and failed, or was told Retry-After, backs off;
// a delivery clears both the backoff and the error. lastErrorAt marks when the current error first appeared.
export function nextHealth(prev, pass, now) {
  const p = objectOf(pass);
  const delivered = countOf(p.delivered);
  const retryAfterMs = typeof p.retryAfterMs === 'number' && isFinite(p.retryAfterMs) && p.retryAfterMs >= 0 ? p.retryAfterMs : null;
  const next = {
    ...prev,
    totals: {
      rejected: prev.totals.rejected + countOf(p.rejected),
      expired: prev.totals.expired + countOf(p.expired),
      quarantined: prev.totals.quarantined + countOf(p.quarantined),
    },
  };
  const error = textOf(p.error);
  if (error != null && error !== prev.lastError) {
    next.lastError = error;
    next.lastErrorAt = now;
    next.lastHttpStatus = Number.isInteger(p.httpStatus) ? p.httpStatus : null;
  } else if (error == null && delivered > 0) {
    next.lastError = null;
    next.lastErrorAt = null;
    next.lastHttpStatus = null;
  }
  if (retryAfterMs != null || (countOf(p.failed) > 0 && delivered === 0)) {
    const failures = prev.backoff.failures + 1;
    next.backoff = { failures, until: now + backoffDelayMs(failures, retryAfterMs) };
  } else if (delivered > 0) {
    next.backoff = { failures: 0, until: null };
  }
  applyReposts(next, p);
  return next;
}

// Every quarantined file handled under this version settles it; until then the handled ones are remembered per file.
function applyReposts(next, p) {
  const version = textOf(p.version);
  if (version == null) return;
  if (p.rejectedDone === true) {
    next.rejectedRetriedFor = version;
    next.rejectedTried = null;
  } else if (Array.isArray(p.rejectedTried)) {
    next.rejectedTried = { version, files: textsOf(p.rejectedTried) };
  }
}

export function readHealth(key) {
  let raw = null;
  try { raw = readJson(healthFile(key), null); } catch { /* reads as healthy */ }
  return normalizeHealth(raw);
}

// Applies one pass and writes only when something changed; createDir off so a logged-out account stays gone. Never throws.
export function recordHealth(key, pass, now = Date.now()) {
  try {
    const prev = readHealth(key);
    const next = nextHealth(prev, pass, now);
    if (JSON.stringify(next) !== JSON.stringify(prev)) writeJsonSecure(healthFile(key), next, { createDir: false });
  } catch { /* best-effort */ }
}

// The account's queue as it stands: postable reports (count, bytes, oldest age) and the quarantined files.
export function queueSnapshot(key, now = Date.now()) {
  const out = { pending: 0, bytes: 0, oldestAgeMs: null, rejected: 0, corrupt: 0 };
  let dir;
  let names;
  try {
    dir = queueDir(key);
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.endsWith('.json.rejected')) out.rejected += 1;
    else if (name.endsWith('.corrupt')) out.corrupt += 1;
    else if (name.endsWith('.json')) addPending(out, path.join(dir, name), now);
  }
  return out;
}

function addPending(out, file, now) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  const age = Math.max(0, now - stat.mtimeMs);
  out.pending += 1;
  out.bytes += stat.size;
  if (out.oldestAgeMs == null || age > out.oldestAgeMs) out.oldestAgeMs = age;
}

// One account's delivery health for status screens: the live queue, the stored record, whether only a new login unblocks it,
// and whether delivery is degraded (backing off, holding refused reports, a report older than a day, or re-auth required).
export function healthSummary(key, now = Date.now()) {
  const health = readHealth(key);
  const queue = queueSnapshot(key, now);
  const backoffUntil = isBackingOff(health, now) ? health.backoff.until : null;
  const stale = queue.oldestAgeMs != null && queue.oldestAgeMs > STALE_QUEUE_MS;
  // A credential pinned to another API origin holds every report until a new login; it never backs off.
  const reauthRequired = health.lastError === AUTH_STATES.REAUTH_REQUIRED;
  return {
    queue,
    lastError: health.lastError,
    lastErrorAt: health.lastErrorAt,
    lastHttpStatus: health.lastHttpStatus,
    totals: health.totals,
    backoffUntil,
    reauthRequired,
    degraded: backoffUntil != null || queue.rejected > 0 || stale || reauthRequired,
  };
}
