// /beezi-dev-settings screens: the menu screen, its option labels and keys, the here card and each section's lines, built from the view passed in.
import { isMultiTenant, isSingleTenant, joinTenantNames, tenantsOf } from '../workspace/tenants.mjs';
import { newFoldersOf } from '../workspace/targets.mjs';
import { rulesOf } from '../workspace/rule-model.mjs';
import { kindWords, placeOfDir, routeOfDir, routeTarget, routeText } from '../workspace/route-describe.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../state/tracking.mjs';
import { planLabel } from '../billing/plan-resolution.mjs';
import {
  UNKNOWN_PLAN_TEXT, crashText, field, identityText, names, planSourceText, signInField, workspaceList,
} from './status-report.mjs';
import { newFoldersLabel } from './workspace-lines.mjs';
import { machineLine } from './machine-lines.mjs';

export const NOT_LINKED_LINE = 'Beezi · not linked — run /beezi-dev-login';
export const NO_MULTI_LINE = 'New folders applies only to an account in several workspaces.';
const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is sent',
};
const CARD_FOOTER = {
  repo: ['The rule follows the repo, so every', 'clone of it stops sending too.'],
  folder: ['The rule covers this folder and', 'everything inside it.'],
  outside: ['The rule covers every session in your', 'home folder, / or a temp folder.'],
};

// "labacus-suite → Acme (default)": where this folder's analytics go, and why.
function thisFolder(row, dir, ctx) {
  const place = placeOfDir(dir, ctx);
  return place == null ? null : `${place.short} ${routeText(row, routeOfDir(row, dir, ctx))}`;
}

// Skipped for a one-workspace account when live tracking is off (audit mode or disabled): "→ Acme" would be wrong there.
function hereShown(row) {
  return !isSingleTenant(row) || isLiveTrackingAllowed(readTrackingState(row.key));
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

// Known workspace count; 0 when unknown.
export function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// The pending-ask notice under a screen, or nothing.
export function pendingLines(notice) {
  return notice == null ? [] : ['', notice];
}

// The status line's state; the badge counts only where the status line is installed.
function statuslineState(statuslineOn, badgeOn) {
  if (!statuslineOn) return 'Off';
  return badgeOn ? 'On, with the Beezi badge' : 'On';
}

// The two machine-wide switches at the foot of the menu screen.
export function machineFields(crash, statuslineOn, badgeOn = false) {
  return [field('Crash reports', crash === 'off' ? 'Off' : 'On'), field('Status line', statuslineState(statuslineOn, badgeOn))];
}

// One account's block of the menu screen; nothing below the title for an account with unknown workspaces.
function screenAccountLines(row, { health, def, dir, ctx }, several) {
  const out = [`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`];
  const h = health[row.key];
  if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
  if (isMultiTenant(row)) {
    const here = thisFolder(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
    out.push(field('Rules', rulesCount(rulesOf(row).length)));
    out.push(field('New folders', newFoldersLabel(row)));
    return out;
  }
  if (!isSingleTenant(row)) return out;
  const here = hereShown(row) ? thisFolder(row, dir, ctx) : null;
  if (here != null) out.push(field('This folder', here));
  const ruleCount = rulesOf(row).length;
  if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  return out;
}

// The menu screen: each account's block, "This machine" when several are linked, then the machine switches.
// `view.machine` is { crash, statusline, badge }, read by the caller.
export function screen(view) {
  const machine = machineFields(view.machine.crash, view.machine.statusline, view.machine.badge);
  if (view.rows.length === 0) return [NOT_LINKED_LINE].concat(machine);
  const several = view.rows.length > 1;
  const out = [];
  view.rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(...screenAccountLines(row, view, several));
  });
  if (several) out.push('', 'This machine');
  return out.concat(machine);
}

// The sections that apply here, in menu order.
function menuLabels(rows) {
  const menu = [];
  if (rows.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (rows.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports & status line');
  return menu;
}

function rulesLabel({ rows, dir, ctx }) {
  const ruled = rows.filter((a) => workspaceCount(a) >= 1);
  if (ruled.length !== 1 || !hereShown(ruled[0]) || placeOfDir(dir, ctx) == null) return 'Rules';
  return `Rules: here → ${routeTarget(ruled[0], routeOfDir(ruled[0], dir, ctx))}`;
}

function newFoldersMenuLabel(rows) {
  const multi = rows.filter((a) => isMultiTenant(a));
  if (multi.length !== 1) return 'New folders';
  const nf = newFoldersOf(multi[0]);
  if (nf.mode === 'send') return `New folders: send to ${joinTenantNames(multi[0], nf.tenantIds)}`;
  return nf.mode === 'none' ? 'New folders: don\'t send' : 'New folders: ask me';
}

function accountMenuLabel(rows) {
  if (rows.length === 0) return 'Account';
  return rows.length === 1 ? `Account: ${rows[0].email || rows[0].name || rows[0].key}` : `Account: ${rows.length} linked`;
}

// One menu option label per `menu=` label, in order, each with its current state when one account decides it.
export function menuLabelLines(view) {
  return menuLabels(view.rows).map((label) => {
    if (label === 'Rules') return rulesLabel(view);
    if (label === 'New folders') return newFoldersMenuLabel(view.rows);
    if (label === 'Account') return accountMenuLabel(view.rows);
    return `Crash reports ${view.machine.crash === 'off' ? 'off' : 'on'}, ${statuslineWords(view.machine)}`;
  });
}

function statuslineWords(machine) {
  if (!machine.statusline) return 'status line off';
  return machine.badge ? 'status line on with badge' : 'status line on';
}

// For the skill's routing only; never shown. `withBadge` adds the badge state for the views (`keys` stays as the wizard parses it).
export function keyLines({ rows, def, machine }, withBadge = false) {
  const out = [machineLine([['menu', menuLabels(rows).join('|')]])];
  for (const a of rows) {
    out.push(machineLine([
      ['account', a.key], ['default', a.key === def ? 'yes' : 'no'], ['multi', isMultiTenant(a) ? 'yes' : 'no'],
      ['workspaces', workspaceCount(a)], ['status', a.status || 'linked'], ['email', a.email || 'unknown'],
    ]));
  }
  const switches = [['crash', machine.crash], ['statusline', machine.statusline ? 'on' : 'off']];
  if (withBadge) switches.push(['badge', machine.badge ? 'on' : 'off']);
  out.push(machineLine(switches));
  return out;
}

// The `<here-card>` text: where this folder is, where it sends now, and for one workspace what Don't track changes.
export function hereCardLines(row, dir, ctx) {
  if (!hereShown(row)) return null;
  const place = placeOfDir(dir, ctx);
  if (place == null) return null;
  const route = routeOfDir(row, dir, ctx);
  const out = ['● You\'re here', `  ${place.kind === 'outside' ? 'outside a project folder' : `${place.short}, ${kindWords(place)}`}`];
  if (place.path != null) out.push(`  ${place.path}`);
  if (place.remote != null) out.push(`  ${place.remote}`);
  out.push('', `Now     ${routeText(row, route)}`);
  if (isSingleTenant(row) && route.ids.length > 0) out.push('After   → not tracked (new rule)', '', ...CARD_FOOTER[place.kind]);
  return out;
}

// The Copilot plan block for the Account section; `vscode` only when VS Code's Copilot Chat signs in as another account.
export function copilotBlockLines(status, vscode) {
  const label = planLabel(status.plan);
  const lines = [
    'This machine',
    field('Copilot plan', label == null ? UNKNOWN_PLAN_TEXT : label),
    field('Plan source', planSourceText(status.planSource)),
    field('GitHub sign-in', identityText(status.identity)),
  ];
  if (vscode != null) {
    const vscodeLabel = planLabel(vscode.plan);
    lines.push(field('VS Code login', vscode.key));
    lines.push(field('VS Code plan', vscodeLabel == null
      ? UNKNOWN_PLAN_TEXT
      : `${vscodeLabel} (${planSourceText(vscode.planSource)})`));
  }
  return lines;
}

// One block per account in several workspaces.
export function newFoldersLines(rows, dir, ctx) {
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

// One block per linked account, then the machine's Copilot block.
export function accountLines(rows, health, def, machine) {
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

export function privacyLines(crash, statuslineOn, badgeOn = false) {
  const state = statuslineState(statuslineOn, badgeOn);
  return [
    field('Crash reports', crashText(crash)),
    field('Status line', statuslineOn ? `${state} — records model, context and allow-all state for Beezi` : state),
  ];
}

// Every section under its own `## Title` heading; a section's first line that repeats the title is dropped.
export function sectionsDocument(parts) {
  const out = [];
  parts.forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    out.push(`## ${title}`, '');
    out.push(...(lines[0] === title ? lines.slice(1) : lines));
  });
  return out;
}
