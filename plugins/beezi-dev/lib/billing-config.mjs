import { billingConfigFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { readCopilotIdentity, copilotAuthEnv, IdentityStatus } from './copilot-account.mjs';

export const BILLING_CONFIG_VERSION = 1;

function isPlain(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// Keeps only the named fields of billing.json: the file is data, never an identity or a plan source by itself.
function normalizeStored(raw) {
  const stored = isPlain(raw) ? raw : {};
  const observed = isPlain(stored.observed) && str(stored.observed.key) != null && str(stored.observed.plan) != null
    ? {
      key: stored.observed.key,
      plan: stored.observed.plan,
      rawPlan: str(stored.observed.rawPlan),
      rawSku: str(stored.observed.rawSku),
      capturedAt: str(stored.observed.capturedAt),
    }
    : null;
  const declared = {};
  if (isPlain(stored.declared)) {
    for (const key of Object.keys(stored.declared)) {
      const entry = stored.declared[key];
      if (isPlain(entry) && str(entry.plan) != null) declared[key] = { plan: entry.plan, declaredAt: str(entry.declaredAt) };
    }
  }
  const last = stored.lastIdentity;
  const lastIdentity = isPlain(last) && str(last.status) != null
    ? { status: last.status, key: str(last.key), since: str(last.since) }
    : null;
  return { version: BILLING_CONFIG_VERSION, observed, declared, lastIdentity, updatedAt: str(stored.updatedAt) };
}

// The one snapshot: billing.json plus the live GitHub identity. Everything that stamps a report, a
// usage row or a check-in takes this object, so they all name the same identity (R-20).
// The live identity is re-read on every call, so an account switch shows up without a reconcile.
export function readBillingConfig({ env = process.env } = {}) {
  let stored = null;
  try { stored = readJson(billingConfigFile(), null); } catch { stored = null; }
  return { ...normalizeStored(stored), identity: readCopilotIdentity({ env }), auth: copilotAuthEnv(env) };
}

// The snapshot as seen by a session bound to accountKey: same stored plans, that account as the identity,
// so resolvePlan picks only the plan declared or observed for that key. Unchanged when the key matches or is unusable.
export function configForAccount(config, accountKey) {
  if (config == null || typeof accountKey !== 'string' || accountKey.length > 64) return config;
  const cut = accountKey.indexOf('/');
  if (cut <= 0 || cut === accountKey.length - 1) return config;
  const current = config.identity;
  if (current != null && current.status === IdentityStatus.OK && current.key === accountKey) return config;
  const identity = { status: IdentityStatus.OK, host: accountKey.slice(0, cut), login: accountKey.slice(cut + 1), id: null, key: accountKey };
  return { ...config, identity };
}

// The snapshot's live parts are never persisted.
export function writeBillingConfig(config) {
  const { identity, auth, ...rest } = config;
  writeJsonSecure(billingConfigFile(), { ...rest, version: BILLING_CONFIG_VERSION });
}

// Which declared-plan slot this identity owns: its own key, or '*' when it cannot be named.
export function declaredKeyFor(identity) {
  return identity != null && identity.status === IdentityStatus.OK && identity.key != null ? identity.key : '*';
}

