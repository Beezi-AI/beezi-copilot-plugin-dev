import { billingConfigFile } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { copilotAuthEnv, IdentityStatus } from '../sources/cli/copilot-identity.mjs';
import { readGithubIdentity } from './plan-sources.mjs';
import { mergePlanHistory, normalizePlanHistory } from './plan-history.mjs';
import { readBillingLocal, writeBillingLocal } from './billing-local.mjs';
import { isPlain, str } from '../core/guards.mjs';

export const BILLING_CONFIG_VERSION = 1;

// The stored plan string is kept as written (an older plugin may have written 'unknown'); resolution re-reads it.
function observedEntry(entry) {
  if (!isPlain(entry) || str(entry.plan) == null) return null;
  const out = { plan: entry.plan, rawPlan: str(entry.rawPlan), rawSku: str(entry.rawSku), capturedAt: str(entry.capturedAt) };
  if (entry.canSignupForLimited === true) out.canSignupForLimited = true;
  return out;
}

// One observed plan per GitHub account, like `declared`; a pre-0.6.2 file holds a single `{ key, plan, … }`.
function normalizeObserved(raw) {
  const observed = {};
  if (!isPlain(raw)) return observed;
  const legacy = str(raw.key) != null ? { [raw.key]: raw } : raw;
  for (const key of Object.keys(legacy)) {
    const entry = observedEntry(legacy[key]);
    if (entry != null) observed[key] = entry;
  }
  return observed;
}

// Keeps only the named fields of billing.json: the file is data, never an identity or a plan source by itself.
function normalizeStored(raw) {
  const stored = isPlain(raw) ? raw : {};
  const observed = normalizeObserved(stored.observed);
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

// The dated history lives in billing-local.json; a pre-release 0.8 billing.json may still carry one, merged in.
function planHistoryOf(stored) {
  const legacy = normalizePlanHistory(isPlain(stored) ? stored.planHistory : null);
  return mergePlanHistory(legacy, readBillingLocal().planHistory);
}

// The one snapshot: billing.json plus the live GitHub identity. Everything that stamps a report, a
// usage row or a check-in takes this object, so they all name the same identity.
// The live identity is re-read on every call, so an account switch shows up without a reconcile.
export function readBillingConfig({ env = process.env } = {}) {
  let stored = null;
  try { stored = readJson(billingConfigFile(), null); } catch { stored = null; }
  const config = normalizeStored(stored);
  const planHistory = planHistoryOf(stored);
  // Present only once a plan was superseded, so a machine without history keeps the pre-0.8 snapshot shape.
  if (Object.keys(planHistory).length > 0) config.planHistory = planHistory;
  return { ...config, identity: readGithubIdentity({ env }), auth: copilotAuthEnv(env) };
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

// The snapshot's live parts are never persisted. billing.json keeps exactly its pre-0.8 keys, which 0.7.x reads and
// rewrites whole; the plan history goes to billing-local.json, where no older plugin erases it.
export function writeBillingConfig(config) {
  const { identity, auth, planHistory, ...rest } = config;
  if (planHistory != null && Object.keys(planHistory).length > 0) writeBillingLocal({ planHistory });
  writeJsonSecure(billingConfigFile(), { ...rest, version: BILLING_CONFIG_VERSION });
}

// Which declared-plan slot this identity owns: its own key, or '*' when it cannot be named.
export function declaredKeyFor(identity) {
  return identity != null && identity.status === IdentityStatus.OK && identity.key != null ? identity.key : '*';
}
