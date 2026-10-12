// The quota cache file, its failure backoff and the probe lock it shares with the refresh; file I/O only, never spawns.
import fs from 'fs';
import path from 'path';
import { beeziHome, quotaCacheFile } from '../../config/paths.mjs';
import { readJson, writeJsonSecure } from '../../platform/fs-store.mjs';
import { LOCK_STALE_MS } from '../../platform/single-instance-lock.mjs';
import { userCacheEntry } from '../../sources/cli/user-cache.mjs';
import { readGithubIdentity } from '../plan-sources.mjs';
import { QuotaReason, cacheEntryOf, readUserCacheSnapshot } from './snapshot.mjs';

export const QUOTA_FRESH_MS = 15 * 60 * 1000;
export const PROBE_LOCK = 'quota-probe';

const LONG_BACKOFF_MS = 6 * 60 * 60 * 1000;
const SHORT_BACKOFF_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

function cacheFile() {
  return quotaCacheFile();
}

export function readCache() {
  return cacheEntryOf(readJson(cacheFile(), null));
}

export function writeCache(cache) {
  writeJsonSecure(cacheFile(), cache);
}

export function backoffActive(cache, now) {
  return cache.backoffUntil != null && cache.backoffUntil > now;
}

export function backoffFor(reason) {
  if (reason === QuotaReason.OK) return 0;
  const long = reason === QuotaReason.UNAVAILABLE || reason === QuotaReason.DISABLED || reason === QuotaReason.NOT_SIGNED_IN;
  return long ? LONG_BACKOFF_MS : SHORT_BACKOFF_MS;
}

// The probe lock is a directory; a young one means a probe is running.
export function lockHeld(now) {
  try { return now - fs.statSync(path.join(beeziHome(), `${PROBE_LOCK}.lock`)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

// Whether an observation names this (named) identity and was fetched within maxAgeMs.
function freshFor(observation, key, nowMs, maxAgeMs) {
  if (observation == null || key == null || observation.identityKey !== key) return false;
  const at = Date.parse(observation.fetchedAt);
  return !(at > nowMs + CLOCK_SKEW_MS || nowMs - at > maxAgeMs);
}

// The probe's cached observation while it is fresh and belongs to the live GitHub identity, else null. Sync, file reads only,
// never spawns. A different identity makes the cache stale: account A's quota is never served as B's, and an identity that
// cannot be named is served none. The refresh gates on this alone, so the probe keeps refreshing the runtime's account.
export function readProbeQuota({ maxAgeMs = QUOTA_FRESH_MS, env = process.env, now = () => Date.now() } = {}) {
  try {
    const { observation } = readCache();
    if (observation == null) return null;
    return freshFor(observation, readGithubIdentity({ env }).key, now(), maxAgeMs) ? observation : null;
  } catch {
    return null;
  }
}

// The probe's observation for the live identity while fresh. Only an identity the probe never measured (app-only and
// VS Code-only machines) falls back to the Copilot runtime's own user cache, under the same freshness rule and
// never persisted, so a pooled seat never alternates between the two sources. Sync, file reads only, never spawns.
export function readCachedQuota({ maxAgeMs = QUOTA_FRESH_MS, env = process.env, now = () => Date.now(), userCache = userCacheEntry } = {}) {
  try {
    const key = readGithubIdentity({ env }).key;
    if (key == null) return null;
    const { observation } = readCache();
    const chosen = observation != null && observation.identityKey === key ? observation : readUserCacheSnapshot(userCache(key));
    return freshFor(chosen, key, now(), maxAgeMs) ? chosen : null;
  } catch {
    return null;
  }
}
