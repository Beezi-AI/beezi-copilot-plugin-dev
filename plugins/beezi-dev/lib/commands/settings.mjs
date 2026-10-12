// settings.mjs: the /beezi-dev-settings menu screen, its sections and the machine keys the skill routes on.
import { getDefaultKey, listAccounts } from '../accounts/index-store.mjs';
import { accountHealth } from '../ux/account-health.mjs';
import { currentSessionWorkspace } from '../workspace/session-routes.mjs';
import { isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { rulesTableLines } from '../ux/rules-table.mjs';
import { pendingAskNotice, pendingAskSummary } from '../ux/workspace-prompt.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { billingStatus, vscodeBillingStatus } from '../billing/plan-resolution.mjs';
import { statuslineInstalled } from '../statusline/install.mjs';
import { buildStatusReport, crashMode } from '../ux/status-report.mjs';
import { readUsageHold } from '../pipeline/usage-hold.mjs';
import { UserError, friendlyMessage } from '../core/errors.mjs';
import { machineLine } from '../ux/machine-lines.mjs';
import {
  NOT_LINKED_LINE, NO_MULTI_LINE, accountLines, copilotBlockLines, machineFields, newFoldersLines, pendingLines, privacyLines, screenLines,
  sectionsDocument,
} from '../ux/settings-screens.mjs';

const USAGE = 'Usage: settings.mjs [keys | rules | new-folders | account | privacy | status | all]';

function currentDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

// Each account's health; a failed check reads as a sign-in problem with the error as its line.
async function healthOf(accounts) {
  const health = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      health[a.key] = await accountHealth(a);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }));
  return health;
}

// The line for analytics held in other folders until a rule answers, or nothing.
async function pending() {
  return pendingLines(pendingAskNotice(await pendingAskSummary()));
}

async function screen() {
  const machine = machineFields(crashMode(), statuslineInstalled());
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    console.log([NOT_LINKED_LINE].concat(machine).join('\n'));
    return;
  }
  // Health checks refresh each account's workspaces, so the index is read again after.
  const health = await healthOf(accounts);
  const rows = await listAccounts();
  const def = await getDefaultKey();
  const out = screenLines(rows, { health, def, dir: currentDir(), ctx: createRouteContext() });
  console.log(out.concat(machine, await pending()).join('\n'));
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
  console.log(machineLine([['menu', menu.join('|')]]));
  for (const a of accounts) {
    console.log(machineLine([
      ['account', a.key], ['default', a.key === def ? 'yes' : 'no'], ['multi', isMultiTenant(a) ? 'yes' : 'no'],
      ['workspaces', workspaceCount(a)], ['status', a.status || 'linked'], ['email', a.email || 'unknown'],
    ]));
  }
  console.log(machineLine([['crash', crashMode()], ['statusline', statuslineInstalled() ? 'on' : 'off']]));
}

// The Copilot plan block, from the same resolution the reports use.
function copilotBlock() {
  const config = readBillingConfig();
  return copilotBlockLines(billingStatus({ config }), vscodeBillingStatus({ config }));
}

async function rulesSection() {
  const rows = await listAccounts();
  if (rows.length === 0) return [NOT_LINKED_LINE];
  return rulesTableLines(rows, currentDir(), createRouteContext()).concat(await pending());
}

async function newFoldersSection() {
  const rows = (await listAccounts()).filter((row) => isMultiTenant(row));
  if (rows.length === 0) return [NO_MULTI_LINE];
  return newFoldersLines(rows, currentDir(), createRouteContext());
}

async function accountSection() {
  const accounts = await listAccounts();
  const machine = copilotBlock();
  if (accounts.length === 0) return [NOT_LINKED_LINE, ''].concat(machine);
  const health = await healthOf(accounts);
  const rows = await listAccounts();
  return accountLines(rows, health, await getDefaultKey(), machine);
}

function privacySection() {
  return privacyLines(crashMode(), statuslineInstalled());
}

async function allSections() {
  return sectionsDocument([
    ['Rules', await rulesSection()],
    ['New folders', await newFoldersSection()],
    ['Account', await accountSection()],
    ['Crash reports & status line', privacySection()],
  ]);
}

const SECTIONS = {
  rules: rulesSection,
  'new-folders': newFoldersSection,
  account: accountSection,
  privacy: async () => privacySection(),
  status: () => buildStatusReport({ budgetMs: 8000, usageHold: readUsageHold() }),
  all: allSections,
};

export async function runSettings(argv) {
  const cmd = argv[0];
  if (cmd == null) { await screen(); return; }
  if (cmd === 'keys') { await keys(); return; }
  if (Object.prototype.hasOwnProperty.call(SECTIONS, cmd)) {
    console.log((await SECTIONS[cmd]()).join('\n'));
    return;
  }
  throw new UserError(USAGE);
}
