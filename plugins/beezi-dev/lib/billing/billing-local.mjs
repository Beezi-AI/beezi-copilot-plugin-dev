// Owns billing-local.json: the billing facts an older plugin sharing this data root must not erase when it rewrites
// billing.json: the dated plan history and each VS Code install's GitHub host. Also the VS Code
// sign-in as billing sees it, keyed under that recorded host.
import path from 'path';
import { billingConfigFile } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { currentVscodeAccount, readVscodeSignedIn } from '../sources/vscode/account.mjs';
import { normalizePlanHistory } from './plan-history.mjs';
import { isPlain } from '../core/guards.mjs';

const LOCAL_VERSION = 1;

// Next to billing.json, which 0.7.x rewrites whole; 0.7.x never opens this file.
function localFile() {
  return path.join(path.dirname(billingConfigFile()), 'billing-local.json');
}

// userDir → host, or null for an enterprise install whose tenant is unknown.
function normalizeHosts(raw) {
  const hosts = {};
  if (!isPlain(raw)) return hosts;
  for (const dir of Object.keys(raw)) if (typeof raw[dir] === 'string' || raw[dir] === null) hosts[dir] = raw[dir];
  return hosts;
}

// { planHistory, vscodeHosts }, both {} when the file is absent or unreadable. Never throws.
export function readBillingLocal() {
  let raw = null;
  try { raw = readJson(localFile(), null); } catch { raw = null; }
  const stored = isPlain(raw) ? raw : {};
  return { planHistory: normalizePlanHistory(stored.planHistory), vscodeHosts: normalizeHosts(stored.vscodeHosts) };
}

// Writes the file with `patch` over what it holds; only when something changed. Throws on a failed write.
export function writeBillingLocal(patch) {
  const current = readBillingLocal();
  const next = { ...current, ...patch };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  writeJsonSecure(localFile(), { version: LOCAL_VERSION, ...next });
  return true;
}

// Records each install's host from readVscodeEntitlements()'s answer (null: not read); → true when the map changed.
export function recordVscodeHosts(entitlements) {
  if (!Array.isArray(entitlements)) return false;
  const hosts = { ...readBillingLocal().vscodeHosts };
  for (const e of entitlements) {
    if (e != null && typeof e.userDir === 'string' && (typeof e.host === 'string' || e.host === null)) hosts[e.userDir] = e.host;
  }
  try { return writeBillingLocal({ vscodeHosts: hosts }); } catch { return false; }
}

function recordedHosts() {
  try { return readBillingLocal().vscodeHosts; } catch { return null; }
}

// VS Code's Copilot Chat sign-in (readVscodeSignedIn) keyed under its install's recorded host. Sync. Never throws.
export function vscodeSignedIn() {
  return readVscodeSignedIn({ hosts: recordedHosts() });
}

// currentVscodeAccount under the recorded hosts. Sync. Never throws.
export function currentVscodeSignIn(session) {
  return currentVscodeAccount(session, { hosts: recordedHosts() });
}
