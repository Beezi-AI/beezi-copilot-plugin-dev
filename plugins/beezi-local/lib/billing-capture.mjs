import { readBillingConfig, writeBillingConfig, declaredKeyFor } from './billing-config.mjs';
import { readLocalPlanRaw, IdentityStatus } from './copilot-account.mjs';
import { readVscodeSignedIn } from './vscode-account.mjs';
import { CopilotPlan, DECLARABLE_PLANS, normalizeCopilotPlan, parseDeclaredPlan, planLabel, resolvePlan } from './billing.mjs';
import { UserError } from './friendly-error.mjs';

// What a reconcile found, for the callers that print or nudge. Never string-matched inline.
export const ReconcileOutcome = Object.freeze({
  CAPTURED: 'captured',
  UNCHANGED: 'unchanged',
  IDENTITY_CHANGED: 'identity-changed',
  NO_SIGNAL: 'no-signal',
});

const VIA_VALUES = ['login', 'refresh', 'login-user', 'refresh-user'];
const USAGE = 'Usage: billing-capture.mjs (--from-copilot [--via <login|refresh>] | --plan <copilot_plan|clear> [--github <host/login>] [--via <login-user|refresh-user>]) [--account <ref>] [--tenant <ref>]';

// argv after --account and --tenant were stripped: { fromCopilot, plan (a copilot_* value or null), clear, github, via }.
export function parseArgs(argv) {
  const out = { fromCopilot: false, plan: null, clear: false, github: null, via: null };
  let planGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-copilot') {
      out.fromCopilot = true;
    } else if (arg === '--plan') {
      const value = argv[++i];
      if (value == null || value.startsWith('--')) throw new UserError(`--plan needs a value: ${DECLARABLE_PLANS.join(', ')} or clear.`);
      planGiven = true;
      if (value.trim().toLowerCase() === 'clear') {
        out.clear = true;
      } else {
        out.plan = parseDeclaredPlan(value);
        if (out.plan == null) throw new UserError(`Unknown Copilot plan "${value}". Use one of: ${DECLARABLE_PLANS.join(', ')}, or clear.`);
      }
    } else if (arg === '--github') {
      const value = argv[++i];
      if (value == null || value.startsWith('--')) throw new UserError('--github needs a GitHub account, like github.com/<login>.');
      out.github = value.trim().toLowerCase();
    } else if (arg === '--via') {
      const value = argv[++i];
      if (VIA_VALUES.indexOf(value) === -1) throw new UserError(`--via needs one of: ${VIA_VALUES.join(', ')}.`);
      out.via = value;
    } else {
      throw new UserError(`Unknown argument "${arg}". ${USAGE}`);
    }
  }
  if (out.fromCopilot === planGiven || (out.github != null && !planGiven)) throw new UserError(USAGE);
  return out;
}

function sameObserved(a, b) {
  if (a == null || b == null) return a === b;
  return a.plan === b.plan && a.rawPlan === b.rawPlan && a.rawSku === b.rawSku;
}

// The persisted part of a snapshot, without its live identity and auth.
function storedOf(config) {
  return {
    version: config.version,
    observed: config.observed,
    declared: config.declared,
    lastIdentity: config.lastIdentity,
    updatedAt: config.updatedAt,
  };
}

// File-only (no spawn, no network): SessionStart can run it on every start. Records the observed plan for
// the live identity and notes an identity change; `declared` entries are never touched here. Never throws.
export function reconcileBillingConfig({ now = new Date(), config = readBillingConfig() } = {}) {
  try {
    const identity = config.identity;
    const nowIso = now.toISOString();
    const next = storedOf(config);

    // The Copilot CLI identity and VS Code's Copilot Chat account sign in separately; each keeps its own observed plan.
    const vscode = readVscodeSignedIn();
    const keys = [identity.key];
    if (vscode != null && vscode.key !== identity.key) keys.push(vscode.key);
    const observed = { ...config.observed };
    let observedChanged = false;
    for (const key of keys) {
      const raw = key != null ? readLocalPlanRaw(key) : null;
      const plan = raw == null ? null : normalizeCopilotPlan(raw.rawPlan, raw.rawSku);
      // A sku-only reading (VS Code) that names no plan is no reading, so it never replaces a runtime answer.
      if (raw == null || (raw.rawPlan == null && plan === CopilotPlan.UNKNOWN)) continue;
      const entry = { plan, rawPlan: raw.rawPlan, rawSku: raw.rawSku, capturedAt: nowIso };
      if (!sameObserved(observed[key], entry)) {
        observed[key] = entry;
        observedChanged = true;
      }
    }
    if (observedChanged) next.observed = observed;

    const last = config.lastIdentity;
    const lastKey = last == null ? null : last.key;
    const keyChanged = lastKey !== identity.key;
    if (last == null || keyChanged || last.status !== identity.status) {
      // `since` is when this key was first seen, so it moves only when the key does.
      next.lastIdentity = { status: identity.status, key: identity.key, since: keyChanged || last == null ? nowIso : last.since };
    }

    const changed = next.observed !== config.observed || next.lastIdentity !== config.lastIdentity;
    if (changed) {
      next.updatedAt = nowIso;
      writeBillingConfig(next);
    }
    const updated = { ...config, ...next };
    let outcome = changed ? ReconcileOutcome.CAPTURED : ReconcileOutcome.UNCHANGED;
    if (lastKey != null && identity.key != null && lastKey !== identity.key) outcome = ReconcileOutcome.IDENTITY_CHANGED;
    else if (identity.status === IdentityStatus.LOGGED_OUT || identity.status === IdentityStatus.UNREADABLE) outcome = ReconcileOutcome.NO_SIGNAL;
    return { config: updated, outcome, changes: describeBillingChanges(config, updated) };
  } catch {
    // A failed write captured nothing.
    return { config, outcome: ReconcileOutcome.UNCHANGED, changes: [] };
  }
}

// The user-facing notices for a reconcile, one line each; SessionStart shows them verbatim.
export function describeBillingChanges(previous, next) {
  const lines = [];
  const previousKey = previous.lastIdentity == null ? null : previous.lastIdentity.key;
  const key = next.identity.key;
  const label = planLabel(resolvePlan(next).plan);
  if (previousKey != null && key != null && previousKey !== key) {
    lines.push(`Beezi: Copilot now uses GitHub account ${key} (was ${previousKey}). Plan: ${label != null ? label : 'unknown — tell Beezi in /beezi-local-settings'}.`);
  } else if (key != null && previousKey === key) {
    const before = planLabel(resolvePlan(previous).plan);
    if (label != null && label !== before) lines.push(`Beezi: Copilot plan changed to ${label}.`);
  }
  return lines;
}

// Declares (or, with 'clear', drops) the plan for the identity's slot, or for `github` when that is VS Code's Copilot Chat
// account. Throws UserError on an unknown value or an account not signed in here.
export function declarePlan(value, { now = new Date(), config = readBillingConfig(), github = null } = {}) {
  let key = declaredKeyFor(config.identity);
  if (github != null && github !== config.identity.key) {
    const vscode = readVscodeSignedIn();
    if (vscode == null || vscode.key !== github) throw new UserError(`${github} is not signed in to Copilot on this machine.`);
    key = github;
  }
  const declared = { ...config.declared };
  if (String(value).trim().toLowerCase() === 'clear') {
    delete declared[key];
  } else {
    const plan = parseDeclaredPlan(value);
    if (plan == null) throw new UserError(`Unknown Copilot plan "${value}". Use one of: ${DECLARABLE_PLANS.join(', ')}, or clear.`);
    declared[key] = { plan, declaredAt: now.toISOString() };
  }
  const next = { ...storedOf(config), declared, updatedAt: now.toISOString() };
  writeBillingConfig(next);
  return { config: { ...config, ...next }, key };
}
