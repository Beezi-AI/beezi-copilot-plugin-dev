// workspace.mjs setup [everything [<refs>] | chosen]: the setup's tracking listing, and the two answers that record the choice.
import { AccountStatus, parseAccountFlag } from '../../accounts/index-store.mjs';
import { markTenantsReviewed, markTrackingChosen } from '../../workspace/settings-store.mjs';
import { answerSetupListing, saveSetupListing } from '../../workspace/history-offer-record.mjs';
import { isMultiTenant, tenantsOf } from '../../workspace/tenants.mjs';
import { newFoldersOf } from '../../workspace/targets.mjs';
import { anonymizationFor, kindsOf } from '../../core/anon-target.mjs';
import { setupPlaces } from '../../history/setup-places.mjs';
import { UserError } from '../../core/errors.mjs';
import { combinedHeader, hidesPhrase, offerLines } from '../../ux/history-offer-lines.mjs';
import {
  commandLine, idList, labeled, ruleAddCommandLine, sessionsCount, tenantName, workspaceLines,
} from '../../ux/workspace-lines.mjs';
import { machineLine, withFields } from '../../ux/machine-lines.mjs';
import { uncheckedLine } from '../history/offer-count.mjs';
import { USAGE, mayPersist, parseSessionFlag, resolveAccount } from './args.mjs';
import { NOT_LINKED } from './rules.mjs';
import { printNoFolder } from './routes.mjs';
import { newFolders } from './new-folders.mjs';

const NOTHING_LISTED = Object.freeze({ places: [], sessionIds: [], noFolder: 0 });

async function linkedAccount(account) {
  const row = await resolveAccount(account);
  if (row.status !== AccountStatus.LINKED) throw new UserError(NOT_LINKED);
  return row;
}

// Answered here before, or (several workspaces) New folders was already set.
const trackingChosen = (row) => row.trackingChosenAt != null || (isMultiTenant(row) && newFoldersOf(row).set);

const hiddenKinds = (row, tenantId) => kindsOf(anonymizationFor(row, tenantId));

// One workspace: its offer lines without the question; several: the combined header and what each one hides.
function checklistLines(row, found) {
  const tenants = tenantsOf(row);
  const { firstMs, lastMs } = found;
  const count = found.sessionIds.length;
  if (tenants.length === 1) {
    const folders = found.places.map((place) => place.short);
    return offerLines({ count, firstMs, lastMs, folders, kinds: hiddenKinds(row, tenants[0].id), workspace: tenantName(row, tenants[0].id) }).lines;
  }
  return combinedHeader({ count, firstMs, lastMs }).concat(tenants.map((t) => `  ${tenantName(row, t.id)} · ${hidesPhrase(hiddenKinds(row, t.id))}`));
}

function printPlaces(row, places) {
  places.forEach((place, i) => {
    const now = place.tracked == null ? 'default' : idList(place.tracked);
    console.log(withFields(`T${i + 1}. ${labeled(place)}, ${sessionsCount(place.sessions)}`, [
      ['account', row.key], ['kind', place.kind], ['now', now], ['match', place.match],
    ]));
    console.log(ruleAddCommandLine(`T${i + 1}-command`, place, row));
  });
}

// The consent record of a listing that asks: the sessions listed and each workspace's hidden kinds; true when it replaced one for the same workspaces.
function saveListing(row, tenants, found) {
  const kinds = {};
  tenants.forEach((t) => { kinds[t.id] = hiddenKinds(row, t.id); });
  const listing = { sessionIds: found.sessionIds, kinds, tenantIds: tenants.map((t) => t.id), listedAt: new Date().toISOString() };
  return saveSetupListing(row.key, listing);
}

// The tracking question's listing; a workspace that could not be scanned prints its ✗ line alone and exits 1.
async function setupListing(argv, deps) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await linkedAccount(account);
  const tenants = tenantsOf(row) || [];
  const chosen = trackingChosen(row);
  const found = tenants.length === 0 || chosen ? NOTHING_LISTED : await setupPlaces(row, deps);
  if (found.failed != null) {
    console.log(uncheckedLine(row, found.failed));
    process.exitCode = 1;
    return;
  }
  const same = tenants.length > 0 && !chosen && (await saveListing(row, tenants, found));
  if (found.places.length > 0) console.log(['<checklist>', ...checklistLines(row, found), '</checklist>'].join('\n'));
  if (tenants.length > 0) {
    for (const line of workspaceLines(row)) console.log(line);
    printPlaces(row, found.places);
    console.log(commandLine('everything-command', `setup everything --account ${row.key} <tenants>`));
    console.log(commandLine('chosen-command', `setup chosen --account ${row.key}`));
  }
  printNoFolder(found.noFolder);
  if (same) console.log('same-list=yes');
  console.log(machineLine([
    ['setup', found.places.length], ['sessions', found.sessionIds.length], ['workspaces', tenants.length], ['chosen', chosen ? 'yes' : 'no'],
  ]));
}

// The account's workspaces count as reviewed, so the join prompt skips them, the setup won't ask again, and the listing's record is answered.
async function recordChoice(row) {
  await markTenantsReviewed(row.key, (tenantsOf(row) || []).map((t) => t.id));
  const nowIso = new Date().toISOString();
  await markTrackingChosen(row.key, nowIso);
  await answerSetupListing(row.key, nowIso);
}

// Everything: several workspaces send new folders to <refs>, rules stay; one workspace has nothing to route. Chosen: several ask.
async function setupWrite(answer, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (answer === 'chosen' && rest.length !== 0) throw new UserError(USAGE);
  const row = await linkedAccount(account);
  if (!(await mayPersist('saving the tracking choice', session))) return;
  if (isMultiTenant(row)) await newFolders(answer === 'chosen' ? ['ask', '--account', row.key] : ['send', ...rest, '--account', row.key]);
  await recordChoice(row);
  console.log(machineLine([['setup', answer]]));
}

export async function setup(argv, deps = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'everything' || sub === 'chosen') return setupWrite(sub, rest);
  return setupListing(argv, deps);
}
