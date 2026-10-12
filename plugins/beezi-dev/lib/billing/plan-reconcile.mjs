import { readBillingConfig, writeBillingConfig, declaredKeyFor } from './billing-config.mjs';
import { IdentityStatus, processEnvAccount } from '../sources/cli/copilot-identity.mjs';
import { readGithubIdentity, readLocalPlanRaw } from './plan-sources.mjs';
import { recordVscodeHosts, vscodeSignedIn } from './billing-local.mjs';
import { CopilotPlan, DECLARABLE_PLANS, PlanSource } from '../contract/billing-vocab.mjs';
import { parseDeclaredPlan, planLabel, resolvePlan } from './plan-resolution.mjs';
import { effectivePlanOf, planOfReading, isKnownPlan } from './plan-normalize.mjs';
import { closePlan } from './plan-history.mjs';
import { UserError } from '../core/errors.mjs';

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

// One observation when the raw strings Copilot reported match, so a rule difference between plugin versions sharing
// this data root never counts as a change; a sku-only reading (VS Code) also compares the plan its entitlement named.
function sameObserved(a, b) {
  if (a == null || b == null) return a === b;
  if (a.rawPlan !== b.rawPlan || a.rawSku !== b.rawSku) return false;
  return a.rawPlan != null || a.plan === b.plan;
}

// The persisted part of a snapshot, without its live identity and auth.
function storedOf(config) {
  const stored = {
    version: config.version,
    observed: config.observed,
    declared: config.declared,
    lastIdentity: config.lastIdentity,
    updatedAt: config.updatedAt,
  };
  if (config.planHistory != null && Object.keys(config.planHistory).length > 0) stored.planHistory = config.planHistory;
  return stored;
}

// The observed entry a reading makes, timed by the reading itself; a sku-only reading (VS Code) naming no plan is none.
function observationOf(raw, nowIso) {
  if (raw == null) return null;
  const plan = planOfReading(raw);
  if (raw.rawPlan == null && plan === CopilotPlan.UNKNOWN) return null;
  const entry = { plan, rawPlan: raw.rawPlan, rawSku: raw.rawSku, capturedAt: raw.at != null ? raw.at : nowIso };
  // Kept so resolution never re-reads this raw plan as a priced one (effectivePlanOf).
  if (raw.canSignupForLimited === true) entry.canSignupForLimited = true;
  return entry;
}

// A different reading replaces the stored one unless it names no plan where the stored one named one, or it is
// older; a known plan always replaces a stored unknown one, whatever its time, since an older plugin stamps its own now.
function supersedes(entry, before) {
  if (before == null) return true;
  if (sameObserved(before, entry)) return false;
  const known = isKnownPlan(entry.plan);
  const knewBefore = isKnownPlan(effectivePlanOf(before));
  if (!known && knewBefore) return false;
  if (known && !knewBefore) return true;
  return !(Date.parse(entry.capturedAt) < Date.parse(before.capturedAt));
}

// Records each key's newest reading; a known plan it replaces is closed in the dated history.
// → { observed, planHistory }, or null when nothing changed.
function observeKeys(config, keys, { entitlements, nowMs, nowIso }) {
  const observed = { ...config.observed };
  let planHistory = config.planHistory != null ? config.planHistory : {};
  let changed = false;
  for (const key of keys) {
    const entry = key == null ? null : observationOf(readLocalPlanRaw(key, { entitlements, now: nowMs }), nowIso);
    const before = observed[key];
    if (entry == null || !supersedes(entry, before)) continue;
    const beforePlan = before == null ? null : effectivePlanOf(before);
    if (isKnownPlan(beforePlan) && beforePlan !== entry.plan) planHistory = closePlan(planHistory, key, beforePlan, entry.capturedAt);
    observed[key] = entry;
    changed = true;
  }
  return changed ? { observed, planHistory } : null;
}

// True when the identity is the account a Copilot app runtime started this process for. Such a process names only
// itself: the stored lastIdentity belongs to the terminal context, so an app hook never moves it nor announces a switch.
function isProcessAccount(identity, env) {
  const own = processEnvAccount(env);
  return own != null && identity.status === IdentityStatus.OK && identity.key === own.key;
}

// The config the reconcile works on: VS Code's install hosts recorded first, and the identity re-read when they
// changed, since a VS Code stand-in identity is keyed under its install's host.
function withRecordedHosts(config, entitlements, env) {
  if (!recordVscodeHosts(entitlements)) return config;
  return { ...config, identity: readGithubIdentity({ env }) };
}

// The stored lastIdentity after this reconcile: unchanged in an app runtime's process; `since` moves only with the key.
function nextLastIdentity(last, identity, appContext, nowIso) {
  if (appContext) return last;
  const keyChanged = last == null || last.key !== identity.key;
  if (!keyChanged && last.status === identity.status) return last;
  return { status: identity.status, key: identity.key, since: keyChanged ? nowIso : last.since };
}

// File-only (no spawn, no network): SessionStart can run it on every start. Records the observed plan for
// the live identity and notes an identity change; `declared` entries are never touched here. Never throws.
// `entitlements` is readVscodeEntitlements()'s answer, read by an async caller beforehand (null: not read).
export function reconcileBillingConfig({ now = new Date(), config = readBillingConfig(), entitlements = null, env = process.env } = {}) {
  try {
    const base = withRecordedHosts(config, entitlements, env);
    const identity = base.identity;
    const nowIso = now.toISOString();
    const next = storedOf(base);

    // The Copilot CLI identity and VS Code's Copilot Chat account sign in separately; each keeps its own observed plan.
    const vscode = vscodeSignedIn();
    const keys = [identity.key];
    if (vscode != null && vscode.key !== identity.key) keys.push(vscode.key);
    const seen = observeKeys(base, keys, { entitlements, nowMs: now.getTime(), nowIso });
    if (seen != null) {
      next.observed = seen.observed;
      if (Object.keys(seen.planHistory).length > 0) next.planHistory = seen.planHistory;
    }

    const appContext = isProcessAccount(identity, env);
    const last = base.lastIdentity;
    const lastKey = last == null ? null : last.key;
    next.lastIdentity = nextLastIdentity(last, identity, appContext, nowIso);

    const changed = next.observed !== base.observed || next.lastIdentity !== base.lastIdentity;
    if (changed) {
      next.updatedAt = nowIso;
      writeBillingConfig(next);
    }
    const updated = { ...base, ...next };
    let outcome = changed ? ReconcileOutcome.CAPTURED : ReconcileOutcome.UNCHANGED;
    if (!appContext && lastKey != null && identity.key != null && lastKey !== identity.key) outcome = ReconcileOutcome.IDENTITY_CHANGED;
    else if (identity.status === IdentityStatus.LOGGED_OUT || identity.status === IdentityStatus.UNREADABLE) outcome = ReconcileOutcome.NO_SIGNAL;
    // An app runtime's process compares its own account's plan with itself, never with the terminal's account.
    const previous = appContext ? { ...base, lastIdentity: { status: identity.status, key: identity.key, since: null } } : base;
    return { config: updated, outcome, changes: describeBillingChanges(previous, updated) };
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
  const current = resolvePlan(next);
  const label = planLabel(current.plan);
  if (previousKey != null && key != null && previousKey !== key) {
    lines.push(`Beezi: Copilot now uses GitHub account ${key} (was ${previousKey}). Plan: ${label != null ? label : 'unknown — tell Beezi in /beezi-dev-settings'}.`);
  } else if (key != null && previousKey === key) {
    const prior = resolvePlan(previous);
    const before = planLabel(prior.plan);
    if (label == null || label === before) return lines;
    // A newer observation replaced the plan the user set; said once, as the next reconcile resolves the same plan.
    const replacedDeclared = prior.source === PlanSource.DECLARED && current.source === PlanSource.OBSERVED && before != null;
    lines.push(replacedDeclared ? `Beezi: Copilot now reports ${label}, replacing the ${before} plan you set.` : `Beezi: Copilot plan changed to ${label}.`);
  }
  return lines;
}

// Declares (or, with 'clear', drops) the plan for the identity's slot, or for `github` when that is VS Code's Copilot Chat
// account. Throws UserError on an unknown value or an account not signed in here.
export function declarePlan(value, { now = new Date(), config = readBillingConfig(), github = null } = {}) {
  let key = declaredKeyFor(config.identity);
  if (github != null && github !== config.identity.key) {
    const vscode = vscodeSignedIn();
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
