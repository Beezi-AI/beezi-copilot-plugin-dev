import crypto from 'crypto';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson } from './fs-store.mjs';
import { accountSyncStateFile } from './paths.mjs';
import { writeAccountJson } from './accounts.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { resolveBilling } from './billing.mjs';
import { accountStamp } from './identity-stamp.mjs';

const STATE_VERSION = 1;

// How long a payload that has not changed is trusted before it is re-sent anyway. The server's
// last_seen_at is the only thing this buys — without it a machine whose account never changes
// would go silent forever after its first check-in.
const RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

// The check-in body, built from one billing snapshot (readBillingConfig): the GitHub identity key and
// the copilot_* plan, both from the same `config`, so the check-in and the reports name one identity.
//
// No `keys[]` and no fingerprint of any credential: a GitHub token authenticates the whole GitHub
// account and the Copilot plan belongs to the account, so a fingerprint adds attribution risk and no
// billing information.
//
// Every field is optional by contract: unknown is first-class, and a machine that can prove
// nothing simply reports nothing.
export function buildAccountSyncPayload({ config = null } = {}) {
  const snapshot = config == null ? _readBillingConfig() : config;
  const payload = {};
  const stamp = accountStamp({ config: snapshot });
  if (stamp.account_uuid != null) payload.accountUuid = stamp.account_uuid;
  const billing = resolveBilling({ config: snapshot });
  if (billing.subscription_plan != null) payload.subscriptionType = billing.subscription_plan;
  return payload;
}

// A payload that names nothing at all: no identity, no plan. It would create no rows
// server-side, so it is not worth a request on a hook path.
export function isEmptyPayload(payload) {
  return payload == null || Object.keys(payload).length === 0;
}

// Deterministic serialization for the change hash: object keys sorted at every level so a
// reordered build can never look like new information. Only the payload is hashed, and the digest
// is one-way regardless.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function readAccountSyncState(key, deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(accountSyncStateFile(key), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

// Through writeAccountJson so a logged-out account's directory is never recreated; false means it is gone.
function writeAccountSyncState(key, state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeAccountJson : deps.writeJsonImpl;
  try {
    write(key, accountSyncStateFile(key), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

function dueForResync(state, nowMs) {
  const at = Date.parse(state == null || state.lastSyncedAt == null ? '' : state.lastSyncedAt);
  if (Number.isNaN(at)) return true;
  // A stamp from the future is a clock change, not a fresh sync.
  return nowMs - at > RESYNC_MS || at > nowMs;
}

// Tell Beezi which GitHub account and Copilot plan this machine is using.
//
// Best-effort by contract: it never throws, never blocks a hook on anything but the bounded POST,
// and swallows every failure — an older API answering 404 is as harmless as being offline. The
// steady state (same payload, synced within the week) reads one small file and sends nothing.
//
// `options.force` skips the hash gate (a user-invoked /beezi-local-login or /beezi-local-settings asked for a
// re-read, and a fresh login may inherit the previous identity's cached hash). `options.via` names
// the caller for local reasoning only — it is NEVER part of the wire body: the API whitelists the
// DTO, so one unknown key would 400 the whole check-in silently.
export async function syncAccountIfNeeded(session, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const now = deps.now == null ? new Date() : deps.now;
  const force = options.force === true;
  if (!session || !session.token) return { synced: false, reason: 'no-token' };

  try {
    let config = null;
    try { config = readConfig(); } catch { config = null; }
    const payload = buildAccountSyncPayload({ config });
    if (isEmptyPayload(payload)) return { synced: false, reason: 'nothing-known' };

    const hash = payloadHash(payload);
    // A keyless session (the pre-index login handshake) still checks in; it just has nowhere to
    // record the marker, so it re-sends next time.
    const stored = session.key == null ? null : readAccountSyncState(session.key, deps);
    // A workspace-scoped check-in keeps its own marker under byTenant in the same file.
    const tenantId = session.tenantId == null ? null : session.tenantId;
    const byTenant = stored != null && stored.byTenant != null && typeof stored.byTenant === 'object' ? stored.byTenant : {};
    const state = tenantId == null ? stored : (byTenant[tenantId] == null ? null : byTenant[tenantId]);
    const unchanged = state != null && state.lastSyncedHash === hash;
    if (!force && unchanged && !dueForResync(state, now.getTime())) {
      return { synced: false, reason: 'unchanged' };
    }

    const res = await postJson(`${apiBase()}${ENDPOINTS.accountSync}`, session, payload, { fetchImpl });
    if (res != null && res.status >= 200 && res.status < 300) {
      if (session.key != null) {
        const marker = { lastSyncedHash: hash, lastSyncedAt: now.toISOString() };
        // Re-read after the POST: parallel check-ins of other workspaces may have written meanwhile.
        const latest = readAccountSyncState(session.key, deps);
        const base = latest == null ? {} : { ...latest };
        delete base.version;
        const latestByTenant = base.byTenant != null && typeof base.byTenant === 'object' ? base.byTenant : {};
        writeAccountSyncState(session.key, tenantId == null
          ? { ...base, ...marker }
          : { ...base, byTenant: { ...latestByTenant, [tenantId]: marker } }, deps);
      }
      return { synced: true, status: res.status };
    }
    // The marker is left untouched on any refusal, so the next trigger retries.
    return { synced: false, status: res == null ? null : res.status, reason: 'rejected' };
  } catch {
    return { synced: false, reason: 'network' };
  }
}
