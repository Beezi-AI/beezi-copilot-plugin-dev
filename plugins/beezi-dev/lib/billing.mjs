import { readBillingConfig, configForAccount } from './billing-config.mjs';
import { IdentityStatus } from './copilot-account.mjs';

// The billing vocabulary shared with the Beezi API. Defined once so a stray literal typo in a
// comparison can't silently misclassify.
export const BillingSource = Object.freeze({
  SUBSCRIPTION: 'subscription',
  // No evidence either way: BYOK, offline, or no usable GitHub sign-in. Never a guess.
  UNKNOWN: 'unknown',
});

export const CopilotPlan = Object.freeze({
  FREE: 'copilot_free',
  STUDENT: 'copilot_student',
  PRO: 'copilot_pro',
  PRO_PLUS: 'copilot_pro_plus',
  MAX: 'copilot_max',
  BUSINESS: 'copilot_business',
  ENTERPRISE: 'copilot_enterprise',
  UNKNOWN: 'unknown',
});

export const SubscriptionType = Object.freeze({
  INDIVIDUAL: 'individual',
  ORGANIZATION: 'organization',
  ENTERPRISE: 'enterprise',
});

// Where the plan in force came from.
export const PlanSource = Object.freeze({ DECLARED: 'declared', OBSERVED: 'observed', NONE: 'none' });

// The values `billing-capture.mjs --plan` and the skills accept.
export const DECLARABLE_PLANS = Object.freeze([
  'copilot_free', 'copilot_student', 'copilot_pro', 'copilot_pro_plus',
  'copilot_max', 'copilot_business', 'copilot_enterprise',
]);

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

// (copilot_plan, access_type_sku) from the runtime's account.getCurrentAuth, first match wins.
// Observed: business + copilot_for_business_seat_quota. Anything unmatched is 'unknown', never a priced guess.
const PLAN_RULES = Object.freeze([
  { plan: /^enterprise$/, sku: null, to: CopilotPlan.ENTERPRISE },
  { plan: /^business$/, sku: null, to: CopilotPlan.BUSINESS },
  { plan: null, sku: /^free_limited/, to: CopilotPlan.FREE },
  { plan: null, sku: /educational|student/, to: CopilotPlan.STUDENT },
  { plan: /^individual_pro$/, sku: null, to: CopilotPlan.PRO_PLUS },
  { plan: null, sku: /pro_?plus/, to: CopilotPlan.PRO_PLUS },
  { plan: null, sku: /(^|_)max(_|$)/, to: CopilotPlan.MAX },
  { plan: /^individual$/, sku: /subscriber_quota$|(^|_)pro(_|$)/, to: CopilotPlan.PRO },
]);

export function normalizeCopilotPlan(rawPlan, rawSku) {
  const plan = typeof rawPlan === 'string' ? rawPlan.trim().toLowerCase() : '';
  const sku = typeof rawSku === 'string' ? rawSku.trim().toLowerCase() : '';
  for (const rule of PLAN_RULES) {
    if (rule.plan != null && !rule.plan.test(plan)) continue;
    if (rule.sku != null && !rule.sku.test(sku)) continue;
    return rule.to;
  }
  return CopilotPlan.UNKNOWN;
}

// The plan in force for the snapshot's identity. Pure.
// A declaration made for key K never applies under another key; '*' applies only while the identity
// cannot be named (env token or several signed-in users).
export function resolvePlan(config) {
  const none = { plan: null, source: PlanSource.NONE };
  const identity = config == null ? null : config.identity;
  if (identity == null) return none;
  let slot = null;
  if (identity.status === IdentityStatus.OK && identity.key != null) slot = identity.key;
  else if (identity.status === IdentityStatus.ENV_TOKEN || identity.status === IdentityStatus.AMBIGUOUS) slot = '*';
  const declared = config.declared != null && typeof config.declared === 'object' ? config.declared : {};
  if (slot != null && Object.prototype.hasOwnProperty.call(declared, slot) && declared[slot] != null) {
    const plan = parseDeclaredPlan(declared[slot].plan);
    if (plan != null) return { plan, source: PlanSource.DECLARED };
  }
  const observed = config.observed;
  if (observed != null && identity.status === IdentityStatus.OK && identity.key != null && observed.key === identity.key) {
    const plan = parseDeclaredPlan(observed.plan);
    if (plan != null) return { plan, source: PlanSource.OBSERVED };
  }
  return none;
}

function resolveAll(config) {
  const identity = config.identity;
  const auth = config.auth != null ? config.auth : {};
  const shown = { status: identity.status, key: identity.key };
  const unknown = { source: BillingSource.UNKNOWN, plan: null, planSource: PlanSource.NONE, identity: shown };
  if (auth.byok || auth.offline) return unknown;
  if (identity.status === IdentityStatus.LOGGED_OUT || identity.status === IdentityStatus.UNREADABLE) return unknown;
  const resolved = resolvePlan(config);
  return { source: BillingSource.SUBSCRIPTION, plan: resolved.plan, planSource: resolved.source, identity: shown };
}

// Sync and snapshot-only: it runs on every checkpoint, so no read, spawn, network or write happens here.
// Subscription fields are omitted, never null or 'unknown', when no plan is known.
// `account` is a session's bound identity key; its plan, never the current account's, is the one sent.
export function resolveBilling({ config, account = null } = {}) {
  try {
    const all = resolveAll(configForAccount(config == null ? readBillingConfig() : config, account));
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
