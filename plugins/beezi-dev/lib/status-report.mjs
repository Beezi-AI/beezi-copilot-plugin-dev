import path from 'path';
import { fileURLToPath } from 'url';
import { listAccounts, getDefaultKey } from './accounts.mjs';
import { accountHealth } from './me.mjs';
import { friendlyMessage } from './friendly-error.mjs';
import { apiBase } from './config.mjs';
import { readTrackingState, TrackingMode } from './tracking.mjs';
import { billingStatus, planLabel } from './billing.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { IdentityStatus } from './copilot-account.mjs';
import { isCorrelationGranted, isTelemetryGranted, readConsent } from './telemetry-consent.mjs';
import { statuslineInstalled } from './statusline-install.mjs';
import { readHooksSeen } from './hook-input.mjs';
import { readJson } from './fs-store.mjs';
import { copilotSettingsFile } from './copilot-paths.mjs';
import { checkForUpdate, readLocalPlugin } from './update-check.mjs';
import { tenantById, tenantsOf, roleLabel, isMultiTenant, isSingleTenant, currentSessionWorkspace } from './workspace.mjs';
import { routeForDir, createRouteContext, shortLabel } from './workspace-rules.mjs';
import { pendingAskSummary, pendingAskNotice } from './workspace-prompt.mjs';

const LABEL_WIDTH = 16;
// The watcher's own disable rule (BEEZI_COPILOT_WATCHER), mirrored so a disabled watcher's module is never imported.
const WATCHER_OFF = ['0', 'false', 'no', 'off', 'disabled'];

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
    const bits = [roleLabel(t), t.tier ? `${capitalize(t.tier)} plan` : ''].filter((b) => b);
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
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
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
  const plan = label == null ? 'unknown — tell Beezi in /beezi-dev-settings refresh' : `${label} (${status.planSource})`;
  return `${plan} · ${identityText(status.identity)}`;
}

function settingsDisableAllHooks() {
  const settings = readJson(copilotSettingsFile(), null);
  return settings != null && typeof settings === 'object' && settings.disableAllHooks === true;
}

// { off: true } | { status: { running, lastScanAt } | null }: the module is imported only when the watcher is enabled.
async function watcherState() {
  const raw = process.env.BEEZI_COPILOT_WATCHER;
  if (raw != null && WATCHER_OFF.indexOf(String(raw).trim().toLowerCase()) !== -1) return { off: true };
  try {
    const mod = await import('./session-watcher.mjs');
    return { status: typeof mod.readWatcherStatus === 'function' ? mod.readWatcherStatus() : null };
  } catch {
    return { status: null };
  }
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

// A one-workspace account's `[]` rule covering the current folder, as "<short> is not tracked (R<n>)"; else null.
function excludedHere(row) {
  try {
    if (!isSingleTenant(row)) return null;
    // The session's own folder, as settings.mjs resolves it: the MCP server's process cwd is not the user's.
    const state = currentSessionWorkspace();
    const dir = state != null && state.cwd != null ? state.cwd : process.cwd();
    const route = routeForDir(row, dir, createRouteContext());
    if (route == null || route.tenantIds.length !== 0) return null;
    return `${shortLabel(route)} is not tracked (R${route.index})`;
  } catch {
    return null;
  }
}

// The accounts block: one heading per linked account, or the not-linked line.
async function accountLines(budgetMs) {
  let accounts;
  try {
    accounts = await listAccounts();
  } catch {
    return ['Beezi · the saved login could not be read on this machine.'];
  }
  if (accounts.length === 0) return ['Beezi · not linked — run /beezi-dev-login'];
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
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    out.push(h != null && !h.ok && h.lines.length > 0 ? signInField(h.lines) : field('Sign-in', 'OK'));
    const tenants = tenantsOf(row) || [];
    if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
    // A multi-workspace account's cached mode describes the web-side workspace, not where sessions go.
    if (!isMultiTenant(row)) out.push(field('Tracking', trackingText(row.key)));
    const excluded = excludedHere(row);
    if (excluded != null) out.push(field('This folder', excluded));
  });
  return out;
}

// User-facing status lines for /beezi-dev-status and the beezi_status tool. Never a token, key or credential path;
// never prints; never throws. `budgetMs` bounds the sign-in checks and the update lookup.
export async function buildStatusReport({ budgetMs = 8000 } = {}) {
  const now = Date.now();
  const out = await accountLines(budgetMs).catch(() => ['Beezi · status could not be read.']);
  try {
    const pending = pendingAskNotice(await pendingAskSummary());
    if (pending != null) out.push('', pending);
  } catch { /* the line is optional */ }

  const machine = ['', 'This machine', field('Beezi API', apiBase())];
  const attempt = (label, produce) => {
    try { machine.push(field(label, produce())); } catch { /* one unreadable field never hides the rest */ }
  };
  attempt('Copilot', copilotText);
  const watcher = await watcherState();
  attempt('Hooks', () => hooksText(readHooksSeen(), watcher, now));
  attempt('Watcher', () => watcherText(watcher, now));
  attempt('Status line', () => (statuslineInstalled() ? 'On' : 'Off'));
  attempt('Crash reports', () => crashText(crashMode()));
  const local = readLocalPlugin();
  if (local != null) machine.push(field('Plugin', `${local.name} ${local.version}`));
  const nudge = await within(Promise.resolve().then(() => checkForUpdate()), budgetMs, null);
  if (nudge != null) machine.push(field('Update', nudge));
  // The skills look for this line by its colon when `${PLUGIN_ROOT}` is not expanded in a skill body (V-26).
  machine.push(field('Plugin root:', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  return out.concat(machine);
}
