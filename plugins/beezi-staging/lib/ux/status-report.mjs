import { AccountStatus, listAccounts, getDefaultKey } from '../accounts/index-store.mjs';
import { accountHealth } from './account-health.mjs';
import { friendlyMessage } from '../core/errors.mjs';
import { apiBase } from '../config/api.mjs';
import { isTenantDark, readTrackingState, TrackingMode } from '../state/tracking.mjs';
import { billingStatus, planLabel } from '../billing/plan-resolution.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { IdentityStatus } from '../sources/cli/copilot-identity.mjs';
import { isCorrelationGranted, isTelemetryGranted, readConsent } from '../telemetry/consent.mjs';
import { statuslineInstalled } from '../statusline/install.mjs';
import { readHooksSeen } from '../state/hooks-seen.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { copilotSettingsFile } from '../config/copilot-paths.mjs';
import { pluginInfo, pluginText, readLatest, readLocalPlugin, updateSteps } from './update-check.mjs';
import { tenantById, tenantsOf, roleLabel, isMultiTenant, joinTenantNames } from '../workspace/tenants.mjs';
import { choiceDir, readSessionWorkspace, resolveSession } from '../workspace/session-routes.mjs';
import { resolveSessionId } from '../host/session-resolver.mjs';
import { placeOfDir, routeOfDir, routeText } from '../workspace/route-describe.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { pendingAskSummary, pendingAskNotice } from './workspace-prompt.mjs';
import { pluginRoot } from '../config/plugin-root.mjs';
import { isWatcherEnabled } from '../config/flags.mjs';
import { readWatcherStatus } from '../state/watcher-record.mjs';
import { healthSummary } from '../state/health-record.mjs';
import { describeCredentialStorage } from '../credentials/generation-store.mjs';
import { loadSqlite } from '../platform/sqlite.mjs';
import { vscodePolicy } from '../sources/vscode/account.mjs';
import { appNonLocalSessions } from '../sources/app/app-db.mjs';
import {
  accuracyText, credentialText, deliveryText, durationText, nonLocalText, policyText, usageHoldText,
} from './capture-health.mjs';

const LABEL_WIDTH = 16;
const PLACE_LABELS = { repo: 'This repo', folder: 'This folder', outside: 'Here' };
const PLAN_SOURCE_TEXT = Object.freeze({ declared: 'declared by you', observed: 'read from Copilot', none: 'not known yet' });
export const UNKNOWN_PLAN_TEXT = 'unknown — tell Beezi in /beezi-staging-settings refresh';

// Where the plan came from, as the status and settings screens word it; an unmapped source reads as itself.
export function planSourceText(source) {
  return PLAN_SOURCE_TEXT[source] || source;
}

// One aligned "  Label   value" line, shared with scripts/settings.mjs.
export function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

// Workspace names for a list of ids.
export function names(row, ids) {
  return ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  }).join(', ');
}

function capitalize(text) {
  const t = String(text);
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export function workspaceList(row) {
  const tenants = tenantsOf(row) || [];
  return tenants.map((t) => {
    // The Beezi workspace's tier, worded so it never reads as the Copilot plan.
    const bits = [roleLabel(t), t.tier ? `${capitalize(t.tier)} workspace plan` : ''].filter((b) => b);
    return `${t.name || t.id}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }).join(', ');
}

// correlate, on (correlation never answered), anonymous (correlation declined) or off.
export function crashMode() {
  if (!isTelemetryGranted()) return 'off';
  if (isCorrelationGranted()) return 'correlate';
  const consent = readConsent();
  return consent != null && consent.correlation === 'denied' ? 'anonymous' : 'on';
}

export function crashText(mode) {
  if (mode === 'correlate') return 'On, with an installation ID so support can find your reports';
  if (mode === 'anonymous' || mode === 'on') return 'On, anonymous';
  return 'Off';
}

// accountHealth's lines folded into one: "Beezi: " dropped, sentences joined.
export function signInField(lines) {
  const text = lines.map((l) => l.trim()).join(' ').replace(/^Beezi: /, '');
  return field('Sign-in', text.charAt(0).toUpperCase() + text.slice(1));
}

// Resolves to `fallback` when the promise has not settled in `ms` (or rejects).
function within(promise, ms, fallback) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, ms));
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

function trackingText(key) {
  const state = readTrackingState(key);
  const mode = state == null || state.trackingMode == null ? null : state.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY) return 'audit mode';
  return mode === TrackingMode.DISABLED ? 'off' : 'live';
}

function ago(iso, now) {
  return `${durationText(now - Date.parse(iso))} ago`;
}

// The account's delivery and credential-storage lines; each is left out when there is nothing to say.
function accountCaptureLines(key, now) {
  const out = [];
  const optional = (label, produce) => {
    try {
      const text = produce();
      if (text != null) out.push(field(label, text));
    } catch { /* one unreadable field never hides the rest */ }
  };
  optional('Delivery', () => deliveryText(healthSummary(key, now), now));
  optional('Credentials', () => credentialText(describeCredentialStorage(key)));
  return out;
}

// Copilot's GitHub sign-in as a person would say it; shared with scripts/settings.mjs.
export function identityText(identity) {
  switch (identity.status) {
    case IdentityStatus.OK: return `GitHub account ${identity.key}`;
    case IdentityStatus.ENV_TOKEN: return 'GitHub sign-in through an environment token';
    case IdentityStatus.AMBIGUOUS: return 'several GitHub accounts are signed in';
    case IdentityStatus.LOGGED_OUT: return 'not signed in to GitHub in Copilot';
    default: return 'GitHub sign-in could not be read';
  }
}

function copilotText() {
  const status = billingStatus({ config: readBillingConfig() });
  const label = planLabel(status.plan);
  const plan = label == null ? UNKNOWN_PLAN_TEXT : `${label} (${planSourceText(status.planSource)})`;
  return `${plan} · ${identityText(status.identity)}`;
}

function settingsDisableAllHooks() {
  const settings = readJson(copilotSettingsFile(), null);
  return settings != null && typeof settings === 'object' && settings.disableAllHooks === true;
}

// { off: true } | { status: { running, lastScanAt } | null }.
function watcherState() {
  if (!isWatcherEnabled(process.env)) return { off: true };
  return { status: readWatcherStatus() };
}

function watcherText(state, now) {
  if (state.off) return 'off (BEEZI_COPILOT_WATCHER)';
  if (state.status == null || !state.status.running) return 'not running';
  return state.status.lastScanAt == null ? 'running' : `running, last scan ${ago(new Date(state.status.lastScanAt).toISOString(), now)}`;
}

function hooksText(seen, watcher, now) {
  const parts = ['SessionStart', 'Stop', 'SessionEnd'].filter((e) => seen[e] != null).map((e) => `${e} ${ago(seen[e], now)}`);
  if (parts.length > 0) return parts.join(' · ');
  if (settingsDisableAllHooks()) return 'not seen on this machine yet — disableAllHooks is on in settings.json';
  const watching = watcher.status != null && watcher.status.running;
  return watching
    ? 'not seen on this machine yet — normal on VS Code Agent Host; the session watcher captures instead'
    : 'not seen on this machine yet';
}

// Why a tracked route still sends nothing live: a one-workspace account's audit or off mode, or a multi-workspace target that answered TRACKING_DISABLED.
export function liveOffNote(row, tracking, route) {
  if (route.ids.length === 0) return null;
  if (isMultiTenant(row)) {
    const dark = route.ids.filter((id) => isTenantDark(tracking, id));
    return dark.length === 0 ? null : `analytics are off in ${joinTenantNames(row, dark)}`;
  }
  const mode = tracking == null ? null : tracking.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY) return 'new sessions are not tracked (audit mode)';
  if (mode === TrackingMode.DISABLED) return 'analytics are off for this workspace';
  return null;
}

// "labacus-suite → Acme (default)" under its place's label, with the note when nothing goes live; null for a revoked
// account, an unknown place or unknown workspaces, or when the route cannot be read (only this account's line drops).
export function placeField(row, dir, ctx, tracking) {
  if (row.status === AccountStatus.REVOKED) return null;
  try {
    const place = placeOfDir(dir, ctx);
    if (place == null) return null;
    const route = routeOfDir(row, dir, ctx);
    if (route.reason.kind === 'unknown') return null;
    const where = place.kind === 'outside' ? 'sessions outside a project' : place.short;
    const off = liveOffNote(row, tracking, route);
    return field(PLACE_LABELS[place.kind] || 'Here', `${where} ${routeText(row, route)}${off == null ? '' : `, but ${off}`}`);
  } catch {
    return null;
  }
}

// The accounts block: one heading per linked account, or the not-linked line.
async function accountLines(budgetMs, now, here) {
  let accounts;
  try {
    accounts = await listAccounts();
  } catch {
    return ['Beezi · the saved login could not be read on this machine.'];
  }
  if (accounts.length === 0) return ['Beezi · not linked — run /beezi-staging-login'];
  const deadline = Date.now() + budgetMs;
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    const fallback = { ok: false, lines: ['Beezi: could not be checked just now.'] };
    health[a.key] = await within(
      accountHealth(a).catch((error) => ({ ok: false, lines: [friendlyMessage(error)] })),
      deadline - Date.now(),
      fallback,
    );
  }));
  // The health checks refresh each account's workspaces, so the index is read again after.
  let rows = accounts;
  try { rows = await listAccounts(); } catch { /* keep the first read */ }
  const def = await getDefaultKey().catch(() => null);
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row) => {
    let block;
    try {
      block = accountBlock(row, { isDefault: several && row.key === def, health: health[row.key], now, here });
    } catch {
      // One unreadable account drops only its own lines.
      return;
    }
    if (out.length > 0) out.push('');
    out.push(...block);
  });
  return out;
}

// One account's heading and fields; `isDefault` marks the default among several.
function accountBlock(row, { isDefault, health: h, now, here }) {
  const out = [`Beezi · ${row.email || row.name || 'linked account'}${isDefault ? ' (default)' : ''}`];
  out.push(h != null && !h.ok && h.lines.length > 0 ? signInField(h.lines) : field('Sign-in', 'OK'));
  const tenants = tenantsOf(row) || [];
  if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
  // A multi-workspace account's cached mode describes the web-side workspace, not where sessions go.
  if (!isMultiTenant(row)) out.push(field('Tracking', trackingText(row.key)));
  const place = placeField(row, here.dir, here.ctx, readTrackingState(row.key));
  if (place != null) out.push(place);
  return out.concat(accountCaptureLines(row.key, now));
}

// Machine facts read from other stores, each bounded by budgetMs: { perCall, policy, nonLocal } (null when unread).
async function captureFacts(budgetMs) {
  const [sqlite, policy, nonLocal] = await Promise.all([
    within(Promise.resolve().then(() => loadSqlite()), budgetMs, undefined),
    within(Promise.resolve().then(() => vscodePolicy()), budgetMs, null),
    within(Promise.resolve().then(() => appNonLocalSessions()), budgetMs, null),
  ]);
  return { perCall: sqlite === undefined ? null : sqlite != null, policy, nonLocal };
}

function pushCaptureLines(machine, facts, usageHold) {
  const optional = (label, text) => { if (text != null) machine.push(field(label, text)); };
  optional('Token detail', accuracyText(facts.perCall));
  optional('Usage store', usageHoldText(usageHold));
  optional('VS Code', policyText(facts.policy));
  optional('Copilot app', nonLocalText(facts.nonLocal));
}

// The folder this session runs in, by the same resolution settings uses; with `ownCwd` false (the MCP server, whose cwd
// is not the user's) only the folder recorded for the session the env names exactly, never a newest or same-cwd guess.
function sessionDir(ownCwd) {
  try {
    if (ownCwd) return choiceDir(resolveSession(null).state);
    const found = resolveSessionId({ env: process.env, cwd: process.cwd() });
    if (found == null || found.source !== 'env' || found.ambiguous) return null;
    const state = readSessionWorkspace(found.sessionId);
    return state != null && state.cwd != null ? state.cwd : null;
  } catch {
    return ownCwd ? process.cwd() : null;
  }
}

// User-facing status lines for /beezi-staging-status and the beezi_status tool. Never a token, key or credential path;
// never prints; never throws. `budgetMs` bounds the sign-in checks, the store reads and the update lookup.
// `usageHold` is the caller's readUsageHold() answer (the flag lives with the pipeline), or null.
// `ownCwd` false falls back to no folder instead of this process's cwd. `dir`, `ctx` and `update` (readLatest's deps)
// replace the session folder, the route context and the update reading (tests).
export async function buildStatusReport({
  budgetMs = 8000, usageHold = null, ownCwd = true, dir = null, ctx = null, update = {},
} = {}) {
  const now = Date.now();
  const factsPromise = captureFacts(budgetMs).catch(() => ({ perCall: null, policy: null, nonLocal: null }));
  const unread = { local: readLocalPlugin(update), record: null, stale: false };
  const latestPromise = within(readLatest(update), budgetMs, unread);
  const here = { dir: dir == null ? sessionDir(ownCwd) : dir, ctx: ctx == null ? createRouteContext() : ctx };
  const out = await accountLines(budgetMs, now, here).catch(() => ['Beezi · status could not be read.']);
  try {
    const pending = pendingAskNotice(await pendingAskSummary());
    if (pending != null) out.push('', pending);
  } catch { /* the line is optional */ }

  const machine = ['', 'This machine', field('Beezi API', apiBase())];
  const attempt = (label, produce) => {
    try { machine.push(field(label, produce())); } catch { /* one unreadable field never hides the rest */ }
  };
  attempt('Copilot', copilotText);
  const watcher = watcherState();
  attempt('Hooks', () => hooksText(readHooksSeen(), watcher, now));
  attempt('Watcher', () => watcherText(watcher, now));
  attempt('Status line', () => (statuslineInstalled() ? 'On' : 'Off'));
  attempt('Crash reports', () => crashText(crashMode()));
  pushCaptureLines(machine, await factsPromise, usageHold);
  const plugin = pluginInfo(await latestPromise);
  machine.push(field('Plugin', pluginText(plugin)));
  // The skills look for this line by its colon when `${PLUGIN_ROOT}` is not expanded in a skill body.
  machine.push(field('Plugin root:', pluginRoot()));
  const steps = updateSteps(plugin);
  return out.concat(machine, steps.length > 0 ? [''].concat(steps) : []);
}
