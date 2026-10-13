// The Copilot runtime's own cache of GitHub's copilot_internal/user answers (copilot-user-cache.json): read-only JSONC,
// one answer per hashed key. The file is parsed in memory; only the named scalars below leave an entry, never a token field.
import fs from 'fs';
import { copilotUserCacheFiles } from '../../config/copilot-paths.mjs';
import { identityKey } from '../../core/github-identity.mjs';
import { isPlain, finiteNumber, nonEmpty } from '../../core/guards.mjs';

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const PREMIUM_SNAPSHOT = 'premium_interactions';
// api[.business|.enterprise|.individual].githubcopilot.com serve github.com accounts; any other host (GHE.com) is unverified.
const GITHUB_COM_API = /^https:\/\/([a-z0-9-]+\.)*githubcopilot\.com(:\d+)?(\/|$)/i;

function text(value) {
  return nonEmpty(value) ? value.trim() : null;
}

function flag(value) {
  return typeof value === 'boolean' ? value : null;
}

// The account host behind the answer's Copilot API endpoint, or null when it is not a known github.com one.
export function hostOfApi(api) {
  return nonEmpty(api) && GITHUB_COM_API.test(api.trim()) ? 'github.com' : null;
}

function premiumOf(snapshots) {
  const snap = isPlain(snapshots) && isPlain(snapshots[PREMIUM_SNAPSHOT]) ? snapshots[PREMIUM_SNAPSHOT] : null;
  if (snap == null) return null;
  return {
    entitlement: finiteNumber(snap.entitlement),
    remaining: finiteNumber(snap.remaining),
    percentRemaining: finiteNumber(snap.percent_remaining),
    unlimited: flag(snap.unlimited),
    overageCount: finiteNumber(snap.overage_count),
    overagePermitted: flag(snap.overage_permitted),
    tokenBasedBilling: flag(snap.token_based_billing),
  };
}

// One cached answer's named scalars, or null unless it is a schema-1 answer naming a github.com account.
export function readEntry(entry) {
  if (!isPlain(entry) || entry.schemaVersion !== SCHEMA_VERSION || !isPlain(entry.response)) return null;
  const retrievedAt = text(entry.retrievedAt);
  if (retrievedAt == null || !Number.isFinite(Date.parse(retrievedAt))) return null;
  const user = entry.response;
  const host = hostOfApi(isPlain(user.endpoints) ? user.endpoints.api : null);
  const login = text(user.login);
  const key = identityKey(host, login);
  if (key == null) return null;
  return {
    key,
    host,
    login,
    retrievedAt,
    rawPlan: text(user.copilot_plan),
    rawSku: text(user.access_type_sku),
    canSignupForLimited: user.can_signup_for_limited === true,
    tokenBasedBilling: flag(user.token_based_billing),
    quotaResetDateUtc: text(user.quota_reset_date_utc),
    quotaResetDate: text(user.quota_reset_date),
    premium: premiumOf(user.quota_snapshots),
  };
}

function isNewer(entry, than) {
  return than == null || Date.parse(entry.retrievedAt) > Date.parse(than.retrievedAt);
}

// The newest entry per account in one cache file's text; [] when it is not the expected shape. Pure.
export function parseUserCache(raw) {
  let parsed = null;
  try {
    // The file opens with `//` comment lines, like config.json.
    const body = String(raw).replace(/^﻿/, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const cache = isPlain(parsed) && isPlain(parsed.copilotUserCache) ? parsed.copilotUserCache : null;
  if (cache == null) return [];
  const newest = new Map();
  for (const slot of Object.keys(cache)) {
    const entry = readEntry(cache[slot]);
    if (entry != null && isNewer(entry, newest.get(entry.key))) newest.set(entry.key, entry);
  }
  return Array.from(newest.values());
}

function readCapped(file) {
  const stat = fs.statSync(file);
  return stat.isFile() && stat.size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8') : null;
}

// The newest cached answer for identity key across the runtime's user cache files, or null. Sync; never throws.
export function userCacheEntry(key, { files = null, readText = readCapped } = {}) {
  if (key == null) return null;
  let best = null;
  try {
    for (const file of files == null ? copilotUserCacheFiles() : files) {
      let raw = null;
      try { raw = readText(file); } catch { raw = null; }
      if (raw == null) continue;
      for (const entry of parseUserCache(raw)) if (entry.key === key && isNewer(entry, best)) best = entry;
    }
  } catch {
    return null;
  }
  return best;
}
