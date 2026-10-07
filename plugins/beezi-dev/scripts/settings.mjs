import { getDefaultKey, listAccounts } from '../lib/accounts.mjs';
import { accountHealth } from '../lib/me.mjs';
import { currentSessionWorkspace, isMultiTenant, isSingleTenant, newFoldersOf, tenantsOf } from '../lib/workspace.mjs';
import { createRouteContext, routeForDir, routeKeyForDir, rulesOf, rulesTableLines, shortLabel } from '../lib/workspace-rules.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../lib/tracking.mjs';
import { pendingAskNotice, pendingAskSummary } from '../lib/workspace-prompt.mjs';
import { readBillingConfig } from '../lib/billing-config.mjs';
import { billingStatus, planLabel } from '../lib/billing.mjs';
import { statuslineInstalled } from '../lib/statusline-install.mjs';
import {
  buildStatusReport, crashMode, crashText, field, identityText, names, signInField, workspaceList,
} from '../lib/status-report.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${names(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// Where this folder's analytics go: its rule, else New folders.
function thisFolder(row, dir, ctx) {
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null) return `${place} → ${route.tenantIds.length === 0 ? 'not tracked' : names(row, route.tenantIds)}`;
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `${place} → ${names(row, newFolders.tenantIds)} (new folder default)`;
  if (newFolders.mode === 'none') return `${place} → not uploaded (new folders: don't send)`;
  return `${place} → no rule yet (asks at the next session start)`;
}

// This folder's status for a one-workspace account: not tracked (with its rule) or tracked.
// Skipped entirely when live tracking is off (audit mode or disabled): "→ tracked" would be wrong there.
function thisFolderSingle(row, dir, ctx) {
  if (!isLiveTrackingAllowed(readTrackingState(row.key))) return null;
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null && route.tenantIds.length === 0) return `${place} → not tracked (R${route.index})`;
  return `${place} → tracked`;
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

// The line for analytics held in other folders until a rule answers, or nothing.
async function pendingLines() {
  const notice = pendingAskNotice(await pendingAskSummary());
  return notice == null ? [] : ['', notice];
}

async function screen() {
  const machine = [
    field('Crash reports', crashMode() === 'off' ? 'Off' : 'On'),
    field('Status line', statuslineInstalled() ? 'On' : 'Off'),
  ];
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    console.log(['Beezi · not linked — run /beezi-dev-login'].concat(machine).join('\n'));
    return;
  }
  // Health checks refresh each account's workspaces, so the index is read again after.
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      health[a.key] = await accountHealth(a);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }));
  const rows = await listAccounts();
  const def = await getDefaultKey();
  const state = currentSessionWorkspace();
  const dir = state != null && state.cwd != null ? state.cwd : process.cwd();
  const ctx = createRouteContext();
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    if (isMultiTenant(row)) {
      const here = thisFolder(row, dir, ctx);
      if (here != null) out.push(field('This folder', here));
      out.push(field('Rules', rulesCount(rulesOf(row).length)));
      out.push(field('New folders', newFoldersLabel(row)));
      return;
    }
    if (!isSingleTenant(row)) return;
    const here = thisFolderSingle(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
    const ruleCount = rulesOf(row).length;
    if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  });
  if (several) out.push('', 'This machine');
  console.log(out.concat(machine, await pendingLines()).join('\n'));
}

// Known workspace count; 0 when unknown.
function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// For the skill's routing only; never shown.
async function keys() {
  const accounts = await listAccounts();
  const def = await getDefaultKey();
  const menu = [];
  if (accounts.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (accounts.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports & status line');
  console.log(`menu=${menu.join('|')}`);
  for (const a of accounts) {
    console.log(`account=${a.key} default=${a.key === def ? 'yes' : 'no'} multi=${isMultiTenant(a) ? 'yes' : 'no'} workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}`);
  }
  console.log(`crash=${crashMode()} statusline=${statuslineInstalled() ? 'on' : 'off'}`);
}

const PLAN_SOURCE_TEXT = { declared: 'declared by you', observed: 'read from Copilot', none: 'not known yet' };

// The Copilot plan block for the Account section, from the same resolution the reports use.
function copilotBlock() {
  const status = billingStatus({ config: readBillingConfig() });
  const label = planLabel(status.plan);
  return [
    'This machine',
    field('Copilot plan', label == null ? 'unknown — tell Beezi in /beezi-dev-settings refresh' : label),
    field('Plan source', PLAN_SOURCE_TEXT[status.planSource] || status.planSource),
    field('GitHub sign-in', identityText(status.identity)),
  ];
}

function currentDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is uploaded',
};

async function rulesSection() {
  const rows = await listAccounts();
  if (rows.length === 0) return ['Beezi · not linked — run /beezi-dev-login'];
  return rulesTableLines(rows, currentDir(), createRouteContext()).concat(await pendingLines());
}

async function newFoldersSection() {
  const rows = (await listAccounts()).filter((row) => isMultiTenant(row));
  if (rows.length === 0) return ['New folders applies only to an account in several workspaces.'];
  const dir = currentDir();
  const ctx = createRouteContext();
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(heading('New folders', row, rows.length > 1));
    const nf = newFoldersOf(row);
    out.push(field('Setting', nf.mode === 'send' ? `Send to ${names(row, nf.tenantIds)}` : NEW_FOLDERS_TEXT[nf.mode]));
    out.push(field('Workspaces', workspaceList(row)));
    const here = thisFolder(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
  });
  return out;
}

async function accountSection() {
  const accounts = await listAccounts();
  const machine = copilotBlock();
  if (accounts.length === 0) return ['Beezi · not linked — run /beezi-dev-login', ''].concat(machine);
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      health[a.key] = await accountHealth(a);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }));
  const rows = await listAccounts();
  const def = await getDefaultKey();
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row) => {
    out.push(`Account · ${row.email || row.name || row.key}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    else out.push(field('Sign-in', 'OK'));
    const tenants = tenantsOf(row) || [];
    if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
    if (several) out.push(field('Analytics reads', row.key === def ? 'yes (default account)' : 'no'));
    out.push('');
  });
  return out.concat(machine);
}

function privacySection() {
  return [
    field('Crash reports', crashText(crashMode())),
    field('Status line', statuslineInstalled() ? 'On — records model, context and allow-all state for Beezi' : 'Off'),
  ];
}

async function allSections() {
  const parts = [
    ['Rules', await rulesSection()],
    ['New folders', await newFoldersSection()],
    ['Account', await accountSection()],
    ['Crash reports & status line', privacySection()],
  ];
  const out = [];
  parts.forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    out.push(`## ${title}`, '');
    // The heading already names the section.
    out.push(...(lines[0] === title ? lines.slice(1) : lines));
  });
  return out;
}

const SECTIONS = {
  rules: rulesSection,
  'new-folders': newFoldersSection,
  account: accountSection,
  privacy: async () => privacySection(),
  status: () => buildStatusReport({ budgetMs: 8000 }),
  all: allSections,
};

async function main() {
  const cmd = process.argv[2];
  if (cmd == null) { await screen(); return; }
  if (cmd === 'keys') { await keys(); return; }
  if (Object.prototype.hasOwnProperty.call(SECTIONS, cmd)) {
    console.log((await SECTIONS[cmd]()).join('\n'));
    return;
  }
  throw new UserError('Usage: settings.mjs [keys | rules | new-folders | account | privacy | status | all]');
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
