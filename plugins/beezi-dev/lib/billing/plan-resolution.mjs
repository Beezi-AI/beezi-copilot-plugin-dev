import { readBillingConfig, configForAccount } from './billing-config.mjs';
import { IdentityStatus } from '../sources/cli/copilot-identity.mjs';
import { vscodeSignedIn } from './billing-local.mjs';
import { observedAt } from './plan-history.mjs';
import { effectivePlanOf } from './plan-normalize.mjs';
import { BillingSource, CopilotPlan, SubscriptionType, PlanSource, DECLARABLE_PLANS } from '../contract/billing-vocab.mjs';

const PLAN_LABELS = Object.freeze({
  copilot_free: 'Free',
  copilot_student: 'Student',
  copilot_pro: 'Pro',
  copilot_pro_plus: 'Pro+',
  copilot_max: 'Max',
  copilot_business: 'Business',
  copilot_enterprise: 'Enterprise',
});

// The plan as a person names it; null when there is none to name.
export function planLabel(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : null;
}

// 'copilot_pro_plus' or the bare tier 'pro_plus' → 'copilot_pro_plus'; anything else → null.
export function parseDeclaredPlan(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (DECLARABLE_PLANS.indexOf(v) !== -1) return v;
  return DECLARABLE_PLANS.indexOf(`copilot_${v}`) !== -1 ? `copilot_${v}` : null;
}

export function subscriptionTypeOf(plan) {
  switch (plan) {
    case CopilotPlan.FREE:
    case CopilotPlan.STUDENT:
    case CopilotPlan.PRO:
    case CopilotPlan.PRO_PLUS:
    case CopilotPlan.MAX:
      return SubscriptionType.INDIVIDUAL;
    case CopilotPlan.BUSINESS:
      return SubscriptionType.ORGANIZATION;
    case CopilotPlan.ENTERPRISE:
      return SubscriptionType.ENTERPRISE;
    default:
      return null;
  }
}

function entryOf(map, key) {
  return map != null && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key) && map[key] != null ? map[key] : null;
}

// Both instants parse and `a` is later; an unparseable declaredAt keeps the declaration in force.
function isAfter(a, b) {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs > bMs;
}

// The plan in force for the snapshot's identity at `at` (ISO or ms; null: now). Pure.
// A declaration made for key K never applies under another key; '*' applies only while the identity
// cannot be named (env token or several signed-in users). An observation newer than the declaration wins.
export function resolvePlan(config, at = null) {
  const none = { plan: null, source: PlanSource.NONE };
  const identity = config == null ? null : config.identity;
  if (identity == null) return none;
  const named = identity.status === IdentityStatus.OK && identity.key != null;
  let slot = null;
  if (named) slot = identity.key;
  else if (identity.status === IdentityStatus.ENV_TOKEN || identity.status === IdentityStatus.AMBIGUOUS) slot = '*';
  const declaredEntry = slot == null ? null : entryOf(config.declared, slot);
  const declared = declaredEntry == null ? null : parseDeclaredPlan(declaredEntry.plan);
  const history = named ? entryOf(config.planHistory, identity.key) : null;
  const current = named ? entryOf(config.observed, identity.key) : null;
  const seen = named ? observedAt(current == null ? null : { ...current, plan: effectivePlanOf(current) }, history, at) : null;
  const observed = seen == null ? null : parseDeclaredPlan(seen.plan);
  if (declared != null && !(observed != null && isAfter(seen.since, declaredEntry.declaredAt))) return { plan: declared, source: PlanSource.DECLARED };
  if (observed != null) return { plan: observed, source: PlanSource.OBSERVED };
  return none;
}

// VS Code's Copilot Chat account and its own plan, when it is not the Copilot CLI identity: { key, login, plan, planSource },
// or null. Reads VS Code's log, so it serves the views and the login/refresh questions, never a checkpoint.
export function vscodeBillingStatus({ config } = {}) {
  try {
    const snapshot = config == null ? readBillingConfig() : config;
    const vscode = vscodeSignedIn();
    if (vscode == null || (snapshot.identity != null && snapshot.identity.key === vscode.key)) return null;
    const resolved = resolvePlan(configForAccount(snapshot, vscode.key));
    return { key: vscode.key, login: vscode.login, plan: resolved.plan, planSource: resolved.source };
  } catch {
    return null;
  }
}

// `byok` is the session's own BYOK verdict; when given it replaces the env's, which describes only this process.
function resolveAll(config, { at = null, byok = null } = {}) {
  const identity = config.identity;
  const auth = config.auth != null ? config.auth : {};
  const shown = { status: identity.status, key: identity.key };
  const unknown = { source: BillingSource.UNKNOWN, plan: null, planSource: PlanSource.NONE, identity: shown };
  if ((typeof byok === 'boolean' ? byok : auth.byok) || auth.offline) return unknown;
  if (identity.status === IdentityStatus.LOGGED_OUT || identity.status === IdentityStatus.UNREADABLE) return unknown;
  const resolved = resolvePlan(config, at);
  return { source: BillingSource.SUBSCRIPTION, plan: resolved.plan, planSource: resolved.source, identity: shown };
}

// Sync and snapshot-only: it runs on every checkpoint, so no read, spawn, network or write happens here.
// Subscription fields are omitted, never null or 'unknown', when no plan is known.
// `account` is a session's bound identity key; its plan, never the current account's, is the one sent.
// `at` is the session's start, so a late report carries the plan it ran on; `byok` is the session's BYOK verdict.
export function resolveBilling({ config, account = null, at = null, byok = null } = {}) {
  try {
    const all = resolveAll(configForAccount(config == null ? readBillingConfig() : config, account), { at, byok });
    if (all.source !== BillingSource.SUBSCRIPTION) return { billing_source: BillingSource.UNKNOWN };
    const out = { billing_source: BillingSource.SUBSCRIPTION };
    if (all.plan != null) {
      const type = subscriptionTypeOf(all.plan);
      if (type != null) out.subscription_type = type;
      out.subscription_plan = all.plan;
    }
    return out;
  } catch {
    return { billing_source: BillingSource.UNKNOWN };
  }
}

// The same resolution, unflattened, for the status and settings views.
export function billingStatus({ config } = {}) {
  try {
    return resolveAll(config == null ? readBillingConfig() : config);
  } catch {
    return {
      source: BillingSource.UNKNOWN,
      plan: null,
      planSource: PlanSource.NONE,
      identity: { status: IdentityStatus.UNREADABLE, key: null },
    };
  }
}
