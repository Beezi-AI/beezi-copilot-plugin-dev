// The billing vocabulary shared with the Beezi API. Wire values: never rename one without a portal change first.

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
