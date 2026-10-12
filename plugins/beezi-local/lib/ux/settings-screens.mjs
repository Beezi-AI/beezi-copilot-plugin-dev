// /beezi-local-settings screens: the menu screen and each section's lines, built from the accounts, health and machine facts passed in.
import { isMultiTenant, isSingleTenant, tenantsOf } from '../workspace/tenants.mjs';
import { newFoldersOf } from '../workspace/targets.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { routeKeyForDir } from '../workspace/route-key.mjs';
import { rulesOf, shortLabel } from '../workspace/rule-model.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../state/tracking.mjs';
import { planLabel } from '../billing/plan-resolution.mjs';
import {
  UNKNOWN_PLAN_TEXT, crashText, field, identityText, names, planSourceText, signInField, workspaceList,
} from './status-report.mjs';
import { newFoldersLabel } from './workspace-lines.mjs';

export const NOT_LINKED_LINE = 'Beezi · not linked — run /beezi-local-login';
export const NO_MULTI_LINE = 'New folders applies only to an account in several workspaces.';
const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is uploaded',
};

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

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

// The pending-ask notice under a screen, or nothing.
export function pendingLines(notice) {
  return notice == null ? [] : ['', notice];
}

// The two machine-wide switches at the foot of the menu screen.
export function machineFields(crash, statuslineOn) {
  return [field('Crash reports', crash === 'off' ? 'Off' : 'On'), field('Status line', statuslineOn ? 'On' : 'Off')];
}

// One account's block of the menu screen; nothing below the title for an account with unknown workspaces.
function screenAccountLines(row, { health, def, dir, ctx, several }) {
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
  const here = thisFolderSingle(row, dir, ctx);
  if (here != null) out.push(field('This folder', here));
  const ruleCount = rulesOf(row).length;
  if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  return out;
}

// The menu screen's account blocks, then "This machine" when several accounts are linked.
export function screenLines(rows, facts) {
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(...screenAccountLines(row, { ...facts, several }));
  });
  if (several) out.push('', 'This machine');
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

export function privacyLines(crash, statuslineOn) {
  return [
    field('Crash reports', crashText(crash)),
    field('Status line', statuslineOn ? 'On — records model, context and allow-all state for Beezi' : 'Off'),
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
