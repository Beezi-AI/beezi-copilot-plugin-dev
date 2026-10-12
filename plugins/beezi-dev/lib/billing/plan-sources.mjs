// Where the live GitHub identity and its raw plan are read from: the Copilot runtime (its probe answer or its own user cache)
// first, then VS Code's resolved entitlement, then the token sku VS Code's Copilot Chat logged.
import { readCopilotIdentity } from '../sources/cli/copilot-identity.mjs';
import { userCacheEntry } from '../sources/cli/user-cache.mjs';
import { vscodeSignedIn } from './billing-local.mjs';
import { quotaCacheFile } from '../config/paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { cacheEntryOf } from './quota/snapshot.mjs';
import { planFromEntitlement, isKnownPlan } from './plan-normalize.mjs';

// How long the probe's account answer stands as this key's plan; the user cache carries its own retrievedAt.
const RUNTIME_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

// The GitHub account Copilot is signed in as (readCopilotIdentity), with VS Code's Copilot Chat sign-in (under its
// install's recorded host) standing in when config.json names no user. Never throws.
export function readGithubIdentity({ env = process.env, readJsonImpl } = {}) {
  return readCopilotIdentity({ env, readJsonImpl, fallbackSignIn: vscodeSignedIn });
}

function reading(rawPlan, rawSku, canSignupForLimited, entitlement, at) {
  return { rawPlan, rawSku, canSignupForLimited, entitlement, at };
}

// The probe's cached account.getCurrentAuth answer for key while it is a day old at most.
function runtimeReading(key, nowMs) {
  const auth = cacheEntryOf(readJson(quotaCacheFile(), null)).auth;
  if (auth == null || auth.key !== key || (auth.rawPlan == null && auth.rawSku == null)) return null;
  const at = Date.parse(auth.fetchedAt);
  if (nowMs - at > RUNTIME_PLAN_MAX_AGE_MS || at > nowMs + CLOCK_SKEW_MS) return null;
  return reading(auth.rawPlan, auth.rawSku, auth.canSignupForLimited === true, null, auth.fetchedAt);
}

function userCacheReading(key, readUserCache) {
  const entry = readUserCache(key);
  if (entry == null || (entry.rawPlan == null && entry.rawSku == null)) return null;
  return reading(entry.rawPlan, entry.rawSku, entry.canSignupForLimited, null, entry.retrievedAt);
}

function newer(a, b) {
  if (a == null || b == null) return a == null ? b : a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

// VS Code's newest login with its logged sku, timed by that log line. The entitlement (5–11) counts only from the
// signed-in install's own setupContext carrying that same sku, since setupContext names no login.
function vscodeReading(key, entitlements) {
  const vscode = vscodeSignedIn();
  if (vscode == null || vscode.key !== key || vscode.rawSku == null || !Number.isFinite(vscode.atMs)) return null;
  const sku = vscode.rawSku.toLowerCase();
  let entitlement = null;
  for (const e of Array.isArray(entitlements) ? entitlements : []) {
    if (e == null || e.userDir !== vscode.userDir || e.sku !== sku || !isKnownPlan(planFromEntitlement(e.entitlement))) continue;
    entitlement = e.entitlement;
  }
  return reading(null, vscode.rawSku, false, entitlement, new Date(vscode.atMs).toISOString());
}

// The newest raw plan reading for this identity key: { rawPlan, rawSku, canSignupForLimited, entitlement, at }, or null.
// `entitlements` is readVscodeEntitlements()'s answer (null: not read). Never throws.
export function readLocalPlanRaw(key, { entitlements = null, now = Date.now(), readUserCache = userCacheEntry } = {}) {
  if (key == null) return null;
  try {
    const cli = newer(runtimeReading(key, now), userCacheReading(key, readUserCache));
    return cli != null ? cli : vscodeReading(key, entitlements);
  } catch {
    return null;
  }
}
