import path from 'path';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { accountDir, beeziHome } from './paths.mjs';
import { acquireLock, releaseLock } from './single-instance-lock.mjs';
import { listAccounts, AccountStatus, writeAccountJson } from './accounts.mjs';
import { linkedRowByKey, tenantById, QUEUE_HOLD_MS } from './workspace.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { resolveBilling } from './billing.mjs';
import { maybeRefreshQuotaInBackground, AllowanceType, AllowanceUnit } from './quota-copilot.mjs';

// Records the monthly Copilot quota readings worth sending and drains them to /me/copilot/usage.
//
// THE READING IS MACHINE-LEVEL, THE QUEUE IS NOT. A quota reading describes the GitHub account Copilot is
// signed in as, not a Beezi workspace, so one series decides what is material; what is per account is
// delivery: every linked Beezi account is owed the same row, and each drains its own copy per target workspace.
// Each row is fully stamped (identity and plan) when it is recorded, and the drain never adds or changes those.

// Same thresholds as the other agents' limit series, so a cross-agent comparison is not an artefact of debounce.
export const MATERIAL_DELTA_PCT = 5;
export const RECORD_FLOOR_MS = 15 * 60 * 1000;
export const MAX_PENDING = 40;

const DEFAULT_BUDGET_MS = 3000;
const REQUEST_CAP_MS = 3000;
const SERIES_LOCK = 'usage-series';
const STATE_VERSION = 1;
// UsageSnapshotRequestDto caps every allowance amount here; a larger one 400s the row.
const MAX_ALLOWANCE_AMOUNT = 10000000;

// Allowance values the DTO would reject are dropped, not sent: one 400 stalls that account's queue.
function allowanceAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_ALLOWANCE_AMOUNT ? value : null;
}

function allowanceEnum(value, enumeration) {
  return typeof value === 'string' && Object.values(enumeration).indexOf(value) !== -1 ? value : null;
}

// The API deep-whitelists nested limit entries (forbidNonWhitelisted): one unknown key 400s the whole
// snapshot. Only kind, percent and resets_at are ever sent, each omitted when null.
function sanitizeLimit(limit) {
  const out = {};
  if (limit.kind != null) out.kind = limit.kind;
  if (limit.percent != null) out.percent = limit.percent;
  if (limit.resets_at != null) out.resets_at = limit.resets_at;
  return out;
}

// The /me/copilot/usage body. Every key is on UsageSnapshotRequestDto; an unknown one 400s the whole row.
// Identity and plan keys are omitted, never nulled: the server treats an explicit null as a claim.
export function buildUsageRow(quota, planFields = {}) {
  const row = {};
  if (quota.identityKey != null) row.account_uuid = quota.identityKey;
  row.fetched_at = quota.fetchedAt;
  if (planFields.subscription_type != null) row.subscription_type = planFields.subscription_type;
  if (planFields.subscription_plan != null) row.subscription_plan = planFields.subscription_plan;
  row.five_hour_pct = null;
  row.five_hour_resets_at = null;
  row.seven_day_pct = null;
  row.seven_day_resets_at = null;
  const percent = quota.percentUsed;
  row.limits = percent == null && quota.resetsAt == null
    ? null
    : [sanitizeLimit({ kind: 'monthly', percent, resets_at: quota.resetsAt })];
  row.raw = {
    entitlement: quota.entitlement,
    used: quota.used,
    remaining_percent: percent == null ? null : Math.max(0, 100 - percent),
    source: 'sdk_quota',
  };
  // The allowance keys are omitted when null, like identity: the server reads a missing key as no reading.
  const allowanceType = allowanceEnum(quota.allowanceType, AllowanceType);
  if (allowanceType != null) row.allowance_type = allowanceType;
  const allowanceUnit = allowanceEnum(quota.unit, AllowanceUnit);
  if (allowanceUnit != null) row.allowance_unit = allowanceUnit;
  const entitlement = allowanceAmount(quota.entitlement);
  if (entitlement != null) row.monthly_entitlement = entitlement;
  const used = allowanceAmount(quota.used);
  if (used != null) row.monthly_used = used;
  const overage = allowanceAmount(quota.overage);
  if (overage != null) row.monthly_overage = overage;
  if (Number.isInteger(percent) && percent >= 0) row.monthly_pct = percent;
  if (typeof quota.overagePermitted === 'boolean') row.overage_permitted = quota.overagePermitted;
  if (typeof quota.resetsAt === 'string') row.monthly_resets_at = quota.resetsAt;
  return row;
}

function seriesFile() {
  return path.join(beeziHome(), 'usage-series.json');
}

function pendingFile(key) {
  return path.join(accountDir(key), 'usage-pending.json');
}

function readSeries() {
  const raw = readJson(seriesFile(), null);
  if (raw == null || typeof raw !== 'object' || raw.version !== STATE_VERSION) return null;
  return raw;
}

function isMaterial(quota, nextMs, last) {
  if (last == null) return true;
  const lastMs = Date.parse(last.recordedAt);
  // The baseline only moves forward: an older reading never replaces a newer one.
  if (Number.isFinite(lastMs) && nextMs < lastMs) return false;
  if (quota.identityKey !== last.identityKey) return true;
  if (quota.resetsAt !== last.resetsAt) return true;
  // A series written before these two fields existed reads as null, so its first new reading is material once.
  const nextType = typeof quota.allowanceType === 'string' ? quota.allowanceType : null;
  if (nextType !== (typeof last.allowanceType === 'string' ? last.allowanceType : null)) return true;
  const nextEntitlement = typeof quota.entitlement === 'number' ? quota.entitlement : null;
  if (nextEntitlement !== (typeof last.entitlement === 'number' ? last.entitlement : null)) return true;
  const next = quota.percentUsed;
  const prev = typeof last.percentUsed === 'number' ? last.percentUsed : null;
  if (next != null && prev != null && Math.abs(next - prev) >= MATERIAL_DELTA_PCT) return true;
  if (next != null && next >= 100 && (prev == null || prev < 100)) return true;
  // The heartbeat: a series with no material change still reports once per floor.
  return !Number.isFinite(lastMs) || nextMs - lastMs >= RECORD_FLOOR_MS;
}

function isRow(value) {
  return value != null && typeof value === 'object' && typeof value.fetched_at === 'string' && Number.isFinite(Date.parse(value.fetched_at));
}

// { version, rows, sent: { <target tag>: <fetched_at of the last confirmed row> } }; '' is the headerless target.
function readPending(key) {
  const raw = readJson(pendingFile(key), null);
  const ok = raw != null && typeof raw === 'object' && raw.version === STATE_VERSION;
  const sent = {};
  if (ok && raw.sent != null && typeof raw.sent === 'object') {
    for (const tag of Object.keys(raw.sent)) if (typeof raw.sent[tag] === 'string') sent[tag] = raw.sent[tag];
  }
  return { rows: ok && Array.isArray(raw.rows) ? raw.rows.filter(isRow) : [], sent };
}

// Appends one row to an account's queue under that account's lock, keeping the newest MAX_PENDING within the hold window.
// Written with writeAccountJson, so a logged-out account is never recreated; false when busy or gone.
function appendRow(key, row) {
  const lock = `usage-pending-${key}`;
  try { accountDir(key); } catch { return false; }
  if (!acquireLock(lock)) return false;
  try {
    const state = readPending(key);
    if (state.rows.some((r) => r.fetched_at === row.fetched_at)) return true;
    const cutoff = Date.now() - QUEUE_HOLD_MS;
    const rows = state.rows.concat([row]).filter((r) => Date.parse(r.fetched_at) >= cutoff).slice(-MAX_PENDING);
    return writeAccountJson(key, pendingFile(key), { version: STATE_VERSION, rows, sent: state.sent });
  } finally {
    releaseLock(lock);
  }
}

// Idempotent: a repeat of the same reading within the floor is not material and records nothing. Never throws.
// Callers: the quota worker, the MCP-side refresh, and maybePostUsageSnapshot when the checkpoint hands it a quota.
export async function recordQuotaObservation(quota, deps = {}) {
  try {
    const nextMs = quota != null && typeof quota.fetchedAt === 'string' ? Date.parse(quota.fetchedAt) : NaN;
    if (!Number.isFinite(nextMs)) return { recorded: false, reason: 'invalid' };
    let row = null;
    if (!acquireLock(SERIES_LOCK)) return { recorded: false, reason: 'busy' };
    try {
      if (!isMaterial(quota, nextMs, readSeries())) return { recorded: false, reason: 'immaterial' };
      // Plan fields at observation time, one snapshot, and only for the identity the reading belongs to.
      const config = (deps.readBillingConfig || readBillingConfig)();
      const plan = config.identity.key === quota.identityKey ? resolveBilling({ config }) : {};
      row = buildUsageRow(quota, { subscription_type: plan.subscription_type, subscription_plan: plan.subscription_plan });
      writeJsonSecure(seriesFile(), {
        version: STATE_VERSION,
        identityKey: quota.identityKey,
        percentUsed: quota.percentUsed,
        resetsAt: quota.resetsAt,
        allowanceType: quota.allowanceType == null ? null : quota.allowanceType,
        entitlement: quota.entitlement == null ? null : quota.entitlement,
        recordedAt: quota.fetchedAt,
      });
    } finally {
      releaseLock(SERIES_LOCK);
    }
    const accounts = await (deps.listAccounts || listAccounts)();
    for (const account of accounts) {
      if (account.status === AccountStatus.LINKED) appendRow(account.key, row);
    }
    return { recorded: true, reason: 'ok' };
  } catch {
    return { recorded: false, reason: 'error' };
  }
}

// Moves one target's marker forward to the last confirmed row; a busy lock skips it (the server dedupes a resend).
function advanceMarker(key, tag, fetchedAt) {
  const lock = `usage-pending-${key}`;
  if (!acquireLock(lock)) return;
  try {
    const state = readPending(key);
    const before = Object.prototype.hasOwnProperty.call(state.sent, tag) ? Date.parse(state.sent[tag]) : NaN;
    if (Number.isFinite(before) && before >= Date.parse(fetchedAt)) return;
    writeAccountJson(key, pendingFile(key), { version: STATE_VERSION, rows: state.rows, sent: { ...state.sent, [tag]: fetchedAt } });
  } finally {
    releaseLock(lock);
  }
}

// Ships one account's queued rows to one target workspace, in order, stopping at the first refusal or at the shared deadline.
async function drainTarget(clone, tag, deadline, fetchImpl) {
  const state = readPending(clone.key);
  const sentMs = Object.prototype.hasOwnProperty.call(state.sent, tag) ? Date.parse(state.sent[tag]) : NaN;
  let due;
  // A target with no marker gets only the newest row, never a backlog.
  if (!Number.isFinite(sentMs)) due = state.rows.slice(-1);
  else due = state.rows.filter((r) => Date.parse(r.fetched_at) > sentMs);
  if (due.length === 0) return { posted: 0, deferred: 0, stop: null };
  const url = `${apiBase()}${ENDPOINTS.usageSnapshot}`;
  let posted = 0;
  let stop = null;
  let confirmed = null;
  for (const row of due) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { stop = 'deadline'; break; }
    let res = null;
    try {
      res = await postJson(url, clone, row, { fetchImpl, timeoutMs: Math.min(REQUEST_CAP_MS, remaining) });
    } catch {
      stop = 'network';
      break;
    }
    if (res == null || res.status < 200 || res.status >= 300) { stop = 'rejected'; break; }
    posted += 1;
    confirmed = row.fetched_at;
  }
  if (confirmed != null) advanceMarker(clone.key, tag, confirmed);
  return { posted, deferred: due.length - posted, stop };
}

// The checkpoint hands in `sessions` (its senders, already expanded per target and gated) and the one quota it read
// this run. Returns within budgetMs plus one request's kill latency; every clone shares the one deadline. Never rejects.
// reason: drained | deadline | rejected | network | empty | no-sessions.
export async function maybePostUsageSnapshot({ sessions, session, quota = null, budgetMs, fetchImpl } = {}) {
  const out = { posted: 0, deferred: 0, reason: 'no-sessions' };
  try {
    const deadline = Date.now() + (Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS);
    // Neither step waits on the Copilot runtime.
    if (quota != null) await recordQuotaObservation(quota);
    maybeRefreshQuotaInBackground();
    const clones = Array.isArray(sessions) ? sessions : (session != null ? [session] : []);
    let eligible = 0;
    let stop = null;
    for (const clone of clones) {
      if (clone == null || !clone.token || clone.key == null) continue;
      const row = linkedRowByKey(clone.key);
      if (row == null) continue;
      // A workspace the account has left is never a target.
      if (clone.tenantId != null && tenantById(row, clone.tenantId) == null) continue;
      eligible += 1;
      const result = await drainTarget(clone, clone.tenantId == null ? '' : clone.tenantId, deadline, fetchImpl);
      out.posted += result.posted;
      out.deferred += result.deferred;
      if (result.stop != null && stop == null) stop = result.stop;
      if (result.stop === 'deadline') break;
    }
    if (stop != null) out.reason = stop;
    else if (eligible === 0) out.reason = 'no-sessions';
    else out.reason = out.posted > 0 ? 'drained' : 'empty';
    return out;
  } catch {
    return out;
  }
}
