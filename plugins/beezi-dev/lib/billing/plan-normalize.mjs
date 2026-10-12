// Turns what Copilot itself reports (copilot_plan, access_type_sku, VS Code's entitlement enum) into a CopilotPlan. Pure.
import { CopilotPlan, DECLARABLE_PLANS } from '../contract/billing-vocab.mjs';

// VS Code 1.141's doResolveEntitlement order: these skus first, then can_signup_for_limited, then copilot_plan.
const SKU_PLANS = Object.freeze({ free_limited_copilot: CopilotPlan.FREE, free_educational_quota: CopilotPlan.STUDENT });
const NO_PLAN_SKU = 'no_auth_limited_copilot';
const RAW_PLANS = Object.freeze({
  individual_edu: CopilotPlan.STUDENT,
  individual: CopilotPlan.PRO,
  individual_pro: CopilotPlan.PRO_PLUS,
  individual_max: CopilotPlan.MAX,
  business: CopilotPlan.BUSINESS,
  enterprise: CopilotPlan.ENTERPRISE,
});
// Only without any copilot_plan (VS Code's Copilot Chat log names the sku alone) do the seat sku families name the plan.
const SEAT_SKU_FAMILIES = Object.freeze([
  [/^copilot_enterprise_/, CopilotPlan.ENTERPRISE],
  [/^copilot_for_business_/, CopilotPlan.BUSINESS],
]);
// VS Code's ChatEntitlement values 5–11 (state.vscdb chat.setupContext); 1–4 name no plan.
const ENTITLEMENT_PLANS = Object.freeze({
  5: CopilotPlan.FREE,
  6: CopilotPlan.PRO,
  7: CopilotPlan.PRO_PLUS,
  8: CopilotPlan.BUSINESS,
  9: CopilotPlan.ENTERPRISE,
  10: CopilotPlan.STUDENT,
  11: CopilotPlan.MAX,
});

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// Anything unmatched is 'unknown', never a priced guess.
export function normalizeCopilotPlan(rawPlan, rawSku, canSignupForLimited = false) {
  const plan = lower(rawPlan);
  const sku = lower(rawSku);
  if (sku === NO_PLAN_SKU) return CopilotPlan.UNKNOWN;
  if (own(SKU_PLANS, sku)) return SKU_PLANS[sku];
  if (canSignupForLimited === true) return CopilotPlan.UNKNOWN;
  if (own(RAW_PLANS, plan)) return RAW_PLANS[plan];
  if (plan !== '') return CopilotPlan.UNKNOWN;
  for (const [family, to] of SEAT_SKU_FAMILIES) if (family.test(sku)) return to;
  return CopilotPlan.UNKNOWN;
}

export function planFromEntitlement(entitlement) {
  return Number.isInteger(entitlement) && own(ENTITLEMENT_PLANS, entitlement) ? ENTITLEMENT_PLANS[entitlement] : CopilotPlan.UNKNOWN;
}

// The plan a local reading names: VS Code's entitlement when it carries one, else the runtime's plan and sku.
export function planOfReading(reading) {
  return reading.entitlement != null
    ? planFromEntitlement(reading.entitlement)
    : normalizeCopilotPlan(reading.rawPlan, reading.rawSku, reading.canSignupForLimited);
}

export function isKnownPlan(plan) {
  return DECLARABLE_PLANS.indexOf(plan) !== -1;
}

// The plan a stored observation names under the current rules: its plan string when known, else its raw copilot_plan
// and sku re-read, so an 'unknown' an older plugin wrote for a plan these rules map still resolves. Pure.
export function effectivePlanOf(entry) {
  if (entry == null || isKnownPlan(entry.plan) || typeof entry.rawPlan !== 'string' || entry.canSignupForLimited === true) {
    return entry == null ? null : entry.plan;
  }
  const derived = normalizeCopilotPlan(entry.rawPlan, entry.rawSku);
  return isKnownPlan(derived) ? derived : entry.plan;
}
