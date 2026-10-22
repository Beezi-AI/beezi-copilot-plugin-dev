// settings.mjs: the /beezi-local-settings views (one read call each), the machine keys the setup wizard parses, and the status screen.
import { getDefaultKey, listAccounts } from '../accounts/index-store.mjs';
import { accountHealth } from '../ux/account-health.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { rulesTableLines } from '../ux/rules-table.mjs';
import { choiceDir, resolveSession } from '../workspace/session-routes.mjs';
import { mayPersist, sessionCountsByKey } from './workspace/args.mjs';
import { rules as printRulesListing } from './workspace/rules.mjs';
import { newFolders as printNewFoldersListing } from './workspace/new-folders.mjs';
import { pendingAskNotice, pendingAskSummary } from '../ux/workspace-prompt.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { billingStatus, vscodeBillingStatus } from '../billing/plan-resolution.mjs';
import { statuslineInstalled } from '../statusline/install.mjs';
import { badgeEnabled, setBadgeEnabled } from '../state/statusline-badge.mjs';
import { buildStatusReport, crashMode } from '../ux/status-report.mjs';
import { readUsageHold } from '../pipeline/usage-hold.mjs';
import { UserError, friendlyMessage } from '../core/errors.mjs';
import {
  NOT_LINKED_LINE, NO_MULTI_LINE, accountLines, copilotBlockLines, hereCardLines, keyLines, menuLabelLines, newFoldersLines,
  pendingLines, privacyLines, screen, sectionsDocument, workspaceCount,
} from '../ux/settings-screens.mjs';

const USAGE = 'Usage: settings.mjs [keys | rules | new-folders | account | privacy | status | all | set badge=<on|off>]';

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

function machineState() {
  return { crash: crashMode(), statusline: statuslineInstalled(), badge: badgeEnabled() };
}

// Everything the views read, loaded once; health checks only when a view shows sign-in.
// The directory and live session come from the same resolution the workspace commands use, so the table, the listings and the card agree.
async function loadView(withHealth) {
  const accounts = await listAccounts();
  const health = withHealth ? await healthOf(accounts) : {};
  // Health checks refresh each account's workspaces, so the index is read again after.
  const rows = withHealth && accounts.length > 0 ? await listAccounts() : accounts;
  const current = resolveSession(null);
  return {
    rows, health, def: await getDefaultKey(), dir: choiceDir(current.state), ctx: createRouteContext(),
    liveSessionId: current.sessionId, machine: machineState(),
  };
}

async function menuSection(view) {
  return view.rows.length === 0 ? screen(view) : screen(view).concat(await pending());
}

async function rulesSection(view) {
  if (view.rows.length === 0) return [NOT_LINKED_LINE];
  const countsByKey = await sessionCountsByKey(view.rows, view.ctx, view.liveSessionId);
  return rulesTableLines(view.rows, view.dir, view.ctx, { countsByKey }).concat(await pending());
}

function newFoldersSection(view) {
  const rows = view.rows.filter((row) => isMultiTenant(row));
  return rows.length === 0 ? [NO_MULTI_LINE] : newFoldersLines(rows, view.dir, view.ctx);
}

// The accounts, then the Copilot plan block from the same resolution the reports use.
function accountSection(view) {
  const config = readBillingConfig();
  const machine = copilotBlockLines(billingStatus({ config }), vscodeBillingStatus({ config }));
  if (view.rows.length === 0) return [NOT_LINKED_LINE, ''].concat(machine);
  return accountLines(view.rows, view.health, view.def, machine);
}

function privacySection(view) {
  return privacyLines(view.machine.crash, view.machine.statusline, view.machine.badge);
}

async function allSections(view) {
  return sectionsDocument([
    ['Rules', await rulesSection(view)],
    ['New folders', newFoldersSection(view)],
    ['Account', accountSection(view)],
    ['Crash reports & status line', privacySection(view)],
  ]);
}

// What each view's one read call prints after `<show>` and `<keys>`: the menu's option labels, the workspace listings
// (`rules`, `new-folders`) per account, and the here card per Rules account.
const VIEWS = {
  menu: { show: menuSection, health: true, labels: true, rules: true, hereCards: true, newFolders: true },
  rules: { show: rulesSection, health: false, rules: true, hereCards: true },
  'new-folders': { show: newFoldersSection, health: false, newFolders: true },
  account: { show: accountSection, health: true },
  privacy: { show: privacySection, health: false },
  all: { show: allSections, health: true },
};

function block(tag, lines) {
  console.log([`<${tag}>`, ...lines, `</${tag.split(' ')[0]}>`].join('\n'));
}

// A workspace listing, run in-process, between its tag lines.
async function listing(tag, key, print) {
  console.log(`<${tag} account="${key}">`);
  await print(['--account', key]);
  console.log(`</${tag}>`);
}

async function printView(spec) {
  const view = await loadView(spec.health);
  block('show', await spec.show(view));
  block('keys', keyLines(view, true));
  if (spec.labels) block('labels', menuLabelLines(view));
  const ruled = view.rows.filter((row) => workspaceCount(row) >= 1);
  if (spec.rules) for (const row of ruled) await listing('rules', row.key, printRulesListing);
  if (spec.hereCards) {
    for (const row of ruled) {
      const card = hereCardLines(row, view.dir, view.ctx);
      if (card != null) block(`here-card account="${row.key}"`, card);
    }
  }
  if (spec.newFolders) {
    for (const row of view.rows.filter((r) => isMultiTenant(r))) await listing('new-folders', row.key, printNewFoldersListing);
  }
}

// `set badge=<on|off>`: the badge ends the CLI status line, so it turns on only where Beezi's status line is installed.
async function setBadge(argv, deps) {
  const value = argv.length === 1 && argv[0].indexOf('badge=') === 0 ? argv[0].slice('badge='.length) : null;
  if (value !== 'on' && value !== 'off') throw new UserError(USAGE);
  const installed = deps.statuslineInstalled == null ? statuslineInstalled : deps.statuslineInstalled;
  if (value === 'on' && !installed()) {
    console.log('✗ Beezi: the status line is not installed, so the badge has nowhere to show. Turn it on first: /beezi-local-settings statusline on');
    return;
  }
  if (!(await mayPersist('changing the Beezi badge'))) return;
  setBadgeEnabled(value === 'on');
  console.log(value === 'on' ? '✓ Beezi badge on: the status line ends with where this folder\'s analytics go.' : '✓ Beezi badge off.');
}

// `deps.statuslineInstalled` stands in for the settings.json check.
export async function runSettings(argv, deps = {}) {
  const cmd = argv[0];
  // `keys` stays tag-free and health-free: the setup wizard parses it.
  if (cmd === 'keys') {
    console.log(keyLines({ rows: await listAccounts(), def: await getDefaultKey(), machine: machineState() }).join('\n'));
    return;
  }
  if (cmd === 'set') {
    await setBadge(argv.slice(1), deps);
    return;
  }
  if (cmd === 'status') {
    console.log((await buildStatusReport({ budgetMs: 8000, usageHold: readUsageHold() })).join('\n'));
    return;
  }
  const view = cmd == null ? 'menu' : cmd;
  if (!Object.prototype.hasOwnProperty.call(VIEWS, view)) throw new UserError(USAGE);
  await printView(VIEWS[view]);
}
