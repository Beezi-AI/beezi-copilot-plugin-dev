// The quota vocabulary and the parsers that turn runtime answers and cache entries into named scalars. Pure.
import { identityKey as keyOf, normalizeHost } from '../../core/github-identity.mjs';
import { finiteNumber } from '../../core/guards.mjs';

// Why a probe returned what it returned, for the backoff and for reporting.
export const QuotaReason = Object.freeze({
  OK: 'ok',
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
  NOT_SIGNED_IN: 'not-signed-in',
  NO_QUOTA: 'no-quota',
  TIMEOUT: 'timeout',
  ERROR: 'error',
});

// The portal's allowance enums (snake_case on the wire); a value outside them is dropped, never sent.
export const AllowanceType = Object.freeze({
  LIMITED: 'limited',
  UNLIMITED: 'unlimited',
  UNKNOWN: 'unknown',
});

export const AllowanceUnit = Object.freeze({
  AI_CREDITS: 'ai_credits',
  PREMIUM_REQUESTS: 'premium_requests',
});

// premium_interactions is the only quota type Beezi reports.
const SNAPSHOT_KEY = 'premium_interactions';
// The snapshot's own resetDate has been observed equal to its timestamp, so it counts only well past the fetch.
const SNAPSHOT_RESET_MIN_AHEAD_MS = 24 * 60 * 60 * 1000;

// An ISO string only for a parseable date in 2020-2100; a seconds/milliseconds mix-up lands far outside it.
function isoInRange(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2020 && year <= 2100 ? new Date(ms).toISOString() : null;
}

function oneOf(value, enumeration) {
  return typeof value === 'string' && Object.values(enumeration).indexOf(value) !== -1 ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// The account's own reset date wins; the snapshot's resetDate is a fallback only when it is clearly in the future.
function resetsAtOf(snap, auth, fetchedAt) {
  if (auth.quotaResetAt != null) return auth.quotaResetAt;
  const fromSnap = isoInRange(snap.resetDate);
  return fromSnap != null && Date.parse(fromSnap) > Date.parse(fetchedAt) + SNAPSHOT_RESET_MIN_AHEAD_MS ? fromSnap : null;
}

// token-based billing means the allowance is counted in AI credits; its absence leaves the unit unknown.
function unitOf(tokenBased) {
  if (tokenBased === true) return AllowanceUnit.AI_CREDITS;
  if (tokenBased === false) return AllowanceUnit.PREMIUM_REQUESTS;
  return null;
}

// One observation from the premium snapshot's numbers, whichever source read them, so equal inputs give equal readings.
function observationOf({ entitlement, used, remainingPct, overage, unlimitedFlag, overagePermitted, unit, resetsAt, source, fetchedAt, identityKey }) {
  const unlimited = unlimitedFlag === true || entitlement === -1;
  let percentUsed = null;
  if (!unlimited) {
    // Floored at 0; overage may push it past 100.
    if (remainingPct != null) percentUsed = Math.max(0, Math.round(100 - remainingPct));
    else if (entitlement != null && entitlement > 0 && used != null) percentUsed = Math.round((used / entitlement) * 100);
  }
  // Limited only on an explicit flag or a positive entitlement; a zero entitlement with no flag is not a reading.
  let allowanceType = AllowanceType.UNKNOWN;
  if (unlimited) allowanceType = AllowanceType.UNLIMITED;
  else if (unlimitedFlag === false || (entitlement != null && entitlement > 0)) allowanceType = AllowanceType.LIMITED;
  return {
    percentUsed,
    resetsAt,
    entitlement: unlimited ? null : entitlement,
    // Kept on pooled (unlimited) seats too: GitHub's per-user count is the only cycle usage Beezi can report there.
    used,
    unlimited,
    allowanceType,
    unit,
    overage: overage != null && overage >= 0 ? overage : null,
    overagePermitted,
    source,
    fetchedAt,
    identityKey,
  };
}

// Only the named fields of the chosen snapshot are read; the rest of the response is discarded unread.
export function readSnapshot(result, auth, fetchedAt) {
  const snapshots = result != null && typeof result === 'object' ? result.quotaSnapshots : null;
  if (snapshots == null || typeof snapshots !== 'object' || !Object.prototype.hasOwnProperty.call(snapshots, SNAPSHOT_KEY)) return null;
  const snap = snapshots[SNAPSHOT_KEY];
  if (snap == null || typeof snap !== 'object') return null;
  return observationOf({
    entitlement: finiteNumber(snap.entitlementRequests),
    used: finiteNumber(snap.usedRequests),
    remainingPct: finiteNumber(snap.remainingPercentage),
    overage: finiteNumber(snap.overage),
    unlimitedFlag: typeof snap.isUnlimitedEntitlement === 'boolean' ? snap.isUnlimitedEntitlement : null,
    overagePermitted: bool(snap.overageAllowedWithExhaustedQuota),
    unit: unitOf(typeof snap.tokenBasedBilling === 'boolean' ? snap.tokenBasedBilling : auth.tokenBasedBilling),
    resetsAt: resetsAtOf(snap, auth, fetchedAt),
    source: 'sdk_quota',
    fetchedAt,
    identityKey: auth.key,
  });
}

// The premium snapshot of a user-cache entry (sources/cli/user-cache.mjs) as an observation, or null without one.
// That answer counts what remains, not what was used, so a pooled seat's use stays unknown.
export function readUserCacheSnapshot(entry) {
  const snap = entry == null ? null : entry.premium;
  if (snap == null) return null;
  const limited = snap.unlimited !== true && snap.entitlement != null && snap.entitlement > 0;
  return observationOf({
    entitlement: snap.entitlement,
    used: limited && snap.remaining != null ? Math.max(0, snap.entitlement - snap.remaining) : null,
    remainingPct: snap.percentRemaining,
    overage: snap.overageCount,
    unlimitedFlag: snap.unlimited,
    overagePermitted: snap.overagePermitted,
    unit: unitOf(snap.tokenBasedBilling != null ? snap.tokenBasedBilling : entry.tokenBasedBilling),
    resetsAt: quotaResetOf(entry.quotaResetDateUtc, entry.quotaResetDate),
    source: 'user_cache',
    fetchedAt: entry.retrievedAt,
    identityKey: entry.key,
  });
}

// The cycle end: the full UTC instant when present, else the date-only field read as that day at 00:00 UTC.
function quotaResetOf(utcValue, dayValue) {
  const utc = isoInRange(utcValue);
  if (utc != null) return utc;
  const day = str(dayValue);
  return day != null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? isoInRange(`${day}T00:00:00.000Z`) : null;
}

// Only these scalars leave account.getCurrentAuth. A token-carrying variant's frame is parsed in memory with the rest,
// but its token fields are never read or stored; envVar is the variable's name only.
export function readAuth(result) {
  const info = result != null && typeof result === 'object' ? result.authInfo : null;
  if (info == null || typeof info !== 'object') return null;
  const user = info.copilotUser != null && typeof info.copilotUser === 'object' ? info.copilotUser : {};
  // The runtime reports the host as a URL ('https://github.com'); keys use the bare host, as config.json does.
  const host = normalizeHost(info.host);
  const login = str(info.login) || str(user.login);
  const key = keyOf(host, login);
  if (key == null) return null;
  return {
    key,
    host,
    login,
    authType: str(info.type),
    envVar: str(info.envVar),
    rawPlan: str(user.copilot_plan),
    rawSku: str(user.access_type_sku),
    canSignupForLimited: bool(user.can_signup_for_limited),
    quotaResetAt: quotaResetOf(user.quota_reset_date_utc, user.quota_reset_date),
    tokenBasedBilling: bool(user.token_based_billing),
  };
}

// A cached observation with each field coerced, or null when it is not an sdk_quota reading with a parseable fetch time.
function validObservation(raw) {
  if (raw == null || typeof raw !== 'object' || raw.source !== 'sdk_quota') return null;
  if (typeof raw.fetchedAt !== 'string' || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
  return {
    percentUsed: finiteNumber(raw.percentUsed),
    resetsAt: isoInRange(raw.resetsAt),
    entitlement: finiteNumber(raw.entitlement),
    used: finiteNumber(raw.used),
    unlimited: raw.unlimited === true,
    allowanceType: oneOf(raw.allowanceType, AllowanceType),
    unit: oneOf(raw.unit, AllowanceUnit),
    overage: finiteNumber(raw.overage),
    overagePermitted: bool(raw.overagePermitted),
    source: 'sdk_quota',
    fetchedAt: raw.fetchedAt,
    identityKey: typeof raw.identityKey === 'string' ? raw.identityKey : null,
  };
}

// The runtime-reported account (read back by readRuntimeAuth in sources/cli/copilot-identity.mjs).
function validAuth(raw) {
  if (raw == null || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  if (typeof raw.fetchedAt !== 'string' || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
  return {
    key: raw.key,
    host: str(raw.host),
    login: str(raw.login),
    authType: str(raw.authType),
    envVar: str(raw.envVar),
    rawPlan: str(raw.rawPlan),
    rawSku: str(raw.rawSku),
    canSignupForLimited: bool(raw.canSignupForLimited),
    quotaResetAt: isoInRange(raw.quotaResetAt),
    tokenBasedBilling: bool(raw.tokenBasedBilling),
    fetchedAt: raw.fetchedAt,
  };
}

// { version: 1, observation, auth, lastAttemptAt (ms), lastReason, backoffUntil (ms) }, tolerant of a missing or foreign file.
export function cacheEntryOf(raw) {
  const ok = raw != null && typeof raw === 'object' && raw.version === 1;
  return {
    version: 1,
    observation: ok ? validObservation(raw.observation) : null,
    auth: ok ? validAuth(raw.auth) : null,
    lastAttemptAt: ok ? finiteNumber(raw.lastAttemptAt) : null,
    lastReason: ok && typeof raw.lastReason === 'string' ? raw.lastReason : null,
    backoffUntil: ok ? finiteNumber(raw.backoffUntil) : null,
  };
}
