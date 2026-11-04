// history-offer.mjs: the past-sessions offer. A scan counts every workspace of a row, prints one block (or a combined one for
// several), then consents the no-ask ones and records the asked ones' decline; accept and decline answer it.
import { prepareRowScan, scanOffer as _scanOffer } from '../../history/offer-scan.mjs';
import { createRunCache as _createRunCache } from '../../history/run-cache.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import {
  declinedIds, forgetDeclined, offerToken, readOfferScan, rememberDeclined, writeOfferScan,
} from '../../workspace/history-offer-record.mjs';
import { readTrackingState } from '../../state/tracking.mjs';
import { anonymizationFor, kindsOf, pastSessionsFor, unionOf } from '../../core/anon-target.mjs';
import { UserError } from '../../core/errors.mjs';
import { joinNames } from '../../core/text.mjs';
import { pluginRoot } from '../../config/plugin-root.mjs';
import { AccountStatus, INDEX_LOCK_BUSY, getAccount, listAccounts, parseAccountFlag } from '../../accounts/index-store.mjs';
import { isMultiTenant, offerableTenantIds, tenantById } from '../../workspace/tenants.mjs';
import { OfferAction, OfferState, offerAction, offerTrackingDisabled, pendingHistoryOf } from '../../workspace/pending-history.mjs';
import { clearHistoryOfferPlaces, consentPastSessions, stampHistoryOffer } from '../../workspace/settings-store.mjs';
import {
  SYNC_COMMAND, acceptLine, allChoice, combinedLines, combinedQuestion, declineLine, noAskLines, offerLines, progressLine,
} from '../../ux/history-offer-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { parseTenantFlags, refParts } from '../tenant-flags.mjs';
import { mayPersist, parseSessionFlag } from '../workspace/args.mjs';

const VIAS = ['session-start', 'login', 'setup', 'sync'];
const USAGE = 'Usage: history-offer.mjs --via <session-start|login|setup|sync> [--account <ref>] [--session <id>] [--tenant <ids>]'
  + ' | accept --account <key> --tenant <id>[,<id>...] --offer <token>[,<token>...] [--session <id>]'
  + ' | decline --account <key> --tenant <id>[,<id>...]';
const UNKNOWN_WORKSPACE_LINE = "✗ Beezi: this account's workspace isn't known yet. Start a new Copilot session or run /beezi-dev-login, then try again.";
const CHANGED_LINE = `✗ Beezi: these past sessions changed after the question was shown, so nothing was uploaded. Run ${SYNC_COMMAND} to see them again.`;

const pick = (value, fallback) => (value == null ? fallback : value);

function workspaceName(row, tenantId) {
  const tenant = tenantById(row, tenantId);
  if (tenant != null && tenant.name) return tenant.name;
  return row.tenantName || tenantId;
}

// Strips `flag <value>` out of argv; a flag with no value throws.
function takeFlag(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return { value: null, rest: argv };
  if (argv[at + 1] == null) throw new UserError(USAGE);
  return { value: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

const uncheckedLine = (row, tenantId) => `✗ Beezi: couldn't check past sessions for ${workspaceName(row, tenantId)} right now. Run ${SYNC_COMMAND} later.`;

// Runs write; resolves true, or false on an index-lock timeout; any other error is rethrown.
async function lockedWrite(write) {
  try {
    await write();
    return true;
  } catch (error) {
    if (error instanceof UserError && error.message === INDEX_LOCK_BUSY) return false;
    throw error;
  }
}

const offerCommand = () => `node "${pluginRoot()}/scripts/history-offer.mjs"`;
const sessionArg = (sessionId) => (sessionId == null ? '' : ` --session ${sessionId}`);
const tokenOf = (record) => offerToken(record.sessionIds, record.shownKinds);
const totalOf = (shown) => shown.reduce((n, s) => n + s.count, 0);
const namesOf = (shown) => joinNames(shown.map((s) => s.workspace));
// One line for the uploads started: today's accepted line, with the workspaces' names joined.
const backgroundLine = (shown) => acceptLine(totalOf(shown), namesOf(shown));

function stampAs(row, tenantId, state, changedAt, deps) {
  const stamp = { state, changedAt, nowIso: new Date().toISOString() };
  return lockedWrite(() => pick(deps.stampHistoryOffer, stampHistoryOffer)(row.key, tenantId, stamp));
}

// A counted workspace's K7 summary { lines, question }.
function summaryOf(row, { tenantId, record, folders }) {
  const { count, firstMs, lastMs, shownKinds } = record;
  return offerLines({ count, firstMs, lastMs, folders, kinds: shownKinds, workspace: workspaceName(row, tenantId) });
}

// <offer>: `lines`, then the question and its two commands.
function offerBlock(row, item, lines, sessionId) {
  const target = `--account ${row.key} --tenant ${item.tenantId}`;
  return [
    `<offer account="${row.key}" tenant="${item.tenantId}">`,
    ...lines,
    machineLine([['question', summaryOf(row, item).question]]),
    machineLine([['accept-command', `${offerCommand()} accept ${target} --offer ${tokenOf(item.record)}${sessionArg(sessionId)}`]]),
    machineLine([['decline-command', `${offerCommand()} decline ${target}`]]),
    '</offer>',
  ];
}

const shownOf = (row, items) => items.map(({ tenantId, record }) => ({ workspace: workspaceName(row, tenantId), count: record.count, kinds: record.shownKinds }));

// <upload> → { head: the K7 summary and the notice, tail }; the consent lines go between them; no question (R7).
function uploadBlock(row, item) {
  const head = [`<upload account="${row.key}" tenant="${item.tenantId}">`, ...summaryOf(row, item).lines];
  head.push(...noAskLines(item.record.count, workspaceName(row, item.tenantId)));
  return { head, tail: () => ['</upload>'] };
}

// <offers> → { head: the several-workspace summary and no-ask progress, tail(too): one question for 2+ asked ones, their <offer>s }.
function offersBlock(row, uploads, asks, sessionId) {
  const records = uploads.concat(asks).map((item) => item.record);
  const ids = new Set();
  records.forEach((record) => record.sessionIds.forEach((id) => ids.add(id)));
  const uploaded = shownOf(row, uploads);
  const asked = shownOf(row, asks);
  const lines = [`<offers account="${row.key}">`, ...combinedLines({
    count: ids.size,
    firstMs: Math.min(...records.map((record) => record.firstMs)),
    lastMs: Math.max(...records.map((record) => record.lastMs)),
    uploads: uploaded,
    asks: asked,
  })];
  if (uploaded.length > 0) lines.push(progressLine(totalOf(uploaded), namesOf(uploaded)));
  return { head: lines, tail: (too) => offersTail(row, asks, too, sessionId) };
}

// One question for 2+ asked workspaces, " too" only when a no-ask one was consented (R16), then their <offer>s and </offers>.
function offersTail(row, asks, too, sessionId) {
  const tail = [];
  if (asks.length > 1) {
    // Comma lists go in single quotes, as every list the skills run does: PowerShell splits a bare one.
    const target = `--account ${row.key} --tenant '${asks.map((item) => item.tenantId).join(',')}'`;
    const tokens = `'${asks.map((item) => tokenOf(item.record)).join(',')}'`;
    tail.push(
      machineLine([['question', combinedQuestion(asks.map((item) => workspaceName(row, item.tenantId)), too)]]),
      machineLine([['all-choice', allChoice(asks.length)]]),
      machineLine([['accept-all-command', `${offerCommand()} accept ${target} --offer ${tokens}${sessionArg(sessionId)}`]]),
      machineLine([['decline-all-command', `${offerCommand()} decline ${target}`]]),
    );
  }
  asks.forEach((item) => tail.push(...offerBlock(row, item, [], sessionId)));
  tail.push('</offers>');
  return tail;
}

// Count phase, one workspace: the gate (not for sync), the scan and its record → { tenantId, record, folders, changedAt, upload },
// or null when it shows nothing.
async function countOne(row, tenantId, cx, deps) {
  // An accepted upload still owed keeps its scan record until it settles, so nothing rescans that workspace.
  if (pendingHistoryOf(row).some((e) => e.tenantId === tenantId)) {
    if (cx.via === 'sync') console.log(`✓ Beezi: past sessions for ${workspaceName(row, tenantId)} are already uploading in the background.`);
    return null;
  }
  const pastSessions = pastSessionsFor(row, tenantId);
  const { changedAt } = pastSessions;
  let places = null;
  if (cx.via !== 'sync') {
    const gate = offerAction(row, tenantId, { pastSessions, trackingDisabled: offerTrackingDisabled(row, tenantId, cx.tracking) });
    if (gate.action === OfferAction.SKIP) return null;
    places = gate.places;
  }
  const scanOffer = pick(deps.scanOffer, _scanOffer);
  const scope = cx.via === 'sync' ? 'sync' : 'offer';
  // Offer scope drops the sessions already declined under this changedAt; sync lists them again (PK2).
  const excludeIds = scope === 'offer' ? declinedIds(row.key, tenantId, changedAt) : null;
  const options = { scope, places, unrouted: cx.unrouted, excludeIds, prepared: await cx.prepared() };
  const scan = await scanOffer(row, tenantId, options, { ...deps, createRunCache: () => cx.runCache });
  const unchecked = () => {
    console.log(uncheckedLine(row, tenantId));
    return null;
  };
  if (scan.status === 'unavailable' || scan.status === 'busy') return unchecked();
  if (scan.status === 'refused' || (scan.count === 0 && places == null)) {
    return (await stampAs(row, tenantId, OfferState.SETTLED, changedAt, deps)) ? null : unchecked();
  }
  if (scan.count === 0) return (await lockedWrite(() => clearHistoryOfferPlaces(row.key, tenantId))) ? null : unchecked();
  const { sessionIds, mode, count, firstMs, lastMs, audit } = scan;
  const shownKinds = kindsOf(anonymizationFor(row, tenantId));
  const record = { sessionIds, mode, unrouted: cx.unrouted, count, firstMs, lastMs, audit, scannedAt: new Date().toISOString(), shownKinds };
  // An index-lock timeout on the record prints this workspace's ✗ line in place of its block.
  if (!(await lockedWrite(() => pick(deps.writeOfferScan, writeOfferScan)(row.key, tenantId, record)))) return unchecked();
  // In sync, a session it would upload that was declined under the scan's fresh changedAt asks first (R18).
  const freshDeclined = scope === 'sync' && scan.upload === true ? declinedIds(row.key, tenantId, scan.changedAt) : new Set();
  // No-ask only on the scan's fresh `upload` (R17); a --tenant override (R6) and an audit workspace (R15) ask first.
  const upload = scan.upload === true && !cx.override && audit !== true && !sessionIds.some((id) => freshDeclined.has(id));
  return { tenantId, record, folders: scan.folders, changedAt, upload };
}

// No-ask workspaces drop out unprinted and unstamped where nothing may be saved; they never record a decline.
async function allowNoAsk(items, cx) {
  if (!items.some((item) => item.upload) || (await mayPersist('uploading past sessions', cx.sessionId))) return items;
  return items.filter((item) => !item.upload);
}

// Consents each no-ask workspace, then prints one background line for the consented and a ✗ line per lock timeout; → the count.
async function consentNoAsk(row, uploads, deps) {
  const consented = [];
  const failed = [];
  for (const item of uploads) {
    if (await lockedWrite(() => consentOffer(row, item.tenantId, item.record, deps))) consented.push(item);
    else failed.push(item);
  }
  if (consented.length > 0) console.log(backgroundLine(shownOf(row, consented)));
  failed.forEach((item) => console.log(uncheckedLine(row, item.tenantId)));
  return consented.length;
}

// An asked workspace's shown question counts as declined until answered.
async function recordAsked(row, { tenantId, record, changedAt }, deps) {
  try {
    await pick(deps.rememberDeclined, rememberDeclined)(row.key, tenantId, { ids: record.sessionIds, changedAt });
  } catch { /* best-effort: without the remembered decline the next offer asks about these again */ }
  // An index-lock timeout on the DECLINED stamp leaves the printed block standing.
  await stampAs(row, tenantId, OfferState.DECLINED, changedAt, deps);
}

// Render phase, one row: one workspace keeps its own block, several share <offers> (R1); → { uploads, offers }.
async function renderRow(row, items, sessionId, deps) {
  const uploads = items.filter((item) => item.upload);
  const asks = items.filter((item) => !item.upload);
  let block = { head: [], tail: () => [] };
  if (items.length > 1) block = offersBlock(row, uploads, asks, sessionId);
  else if (uploads.length === 1) block = uploadBlock(row, uploads[0]);
  else if (asks.length === 1) block = { head: offerBlock(row, asks[0], summaryOf(row, asks[0]).lines, sessionId), tail: () => [] };
  for (const line of block.head) console.log(line);
  // Consented and started after the notice prints, so nothing is owed or uploads before it is shown.
  const consented = await consentNoAsk(row, uploads, deps);
  for (const line of block.tail(consented > 0)) console.log(line);
  if (consented > 0) await startHistoryWorker(row.key, deps);
  for (const item of asks) await recordAsked(row, item, deps);
  return { uploads: consented, offers: asks.length };
}

// Per row: count every workspace, print, then consent the no-ask ones; ends with `uploads=<n>` and `offers=<n>`.
// --via sync skips the gate and scans every session.
export async function printOffers(rows, { via, tenantOverride = [], sessionId = null }, deps = {}) {
  const readTracking = pick(deps.readTracking, readTrackingState);
  const createRunCache = pick(deps.createRunCache, _createRunCache);
  let uploads = 0;
  let offers = 0;
  for (const row of rows) {
    const unrouted = tenantOverride.length > 0 && isMultiTenant(row);
    let prepared = null;
    // One git cache, plan, listing and login per account, shared by its workspaces' scans; prepared on the first scan only.
    const cx = {
      via, unrouted, override: tenantOverride.length > 0, sessionId, tracking: readTracking(row.key), runCache: createRunCache(),
      prepared: () => prepared || (prepared = prepareRowScan(row, deps)),
    };
    const tenantIds = unrouted ? tenantOverride : offerableTenantIds(row);
    if (via === 'sync' && tenantIds.length === 0) console.log(UNKNOWN_WORKSPACE_LINE);
    const counted = [];
    for (const tenantId of tenantIds) {
      const item = await countOne(row, tenantId, cx, deps);
      if (item != null) counted.push(item);
    }
    const shown = await renderRow(row, await allowNoAsk(counted, cx), sessionId, deps);
    uploads += shown.uploads;
    offers += shown.offers;
  }
  console.log(machineLine([['uploads', uploads]]));
  console.log(machineLine([['offers', offers]]));
  return offers;
}

// accept / decline: the account row and the comma-listed workspaces the offer could have asked about.
async function answerTarget(argv) {
  const { session, rest } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(rest);
  const { value: tenantList, rest: left } = takeFlag(afterAccount, '--tenant');
  const row = account == null ? null : await getAccount(account);
  const tenantIds = tenantList == null ? [] : refParts(tenantList);
  if (row == null || tenantIds.length === 0 || left.length > 0) throw new UserError(USAGE);
  const foreign = tenantIds.find((id) => offerableTenantIds(row).indexOf(id) === -1);
  if (foreign != null) throw new UserError(`Beezi: ${foreign} is not a workspace of this account.`);
  return { row, tenantIds, sessionId: session };
}

// Consents to exactly the record's sessions and forgets their declines; the entry carries the record's ids and shown kinds.
async function consentOffer(row, tenantId, record, deps) {
  const accepted = {
    sessionIds: record.sessionIds,
    mode: record.mode,
    unrouted: record.unrouted,
    // Kinds shown hidden stay hidden at the yes (PK1), plus any turned on since.
    hiddenKinds: unionOf(record.shownKinds, kindsOf(anonymizationFor(row, tenantId))),
    scannedAt: record.scannedAt,
  };
  await pick(deps.consentPastSessions, consentPastSessions)(row.key, tenantId, { changedAt: pastSessionsFor(row, tenantId).changedAt, accepted });
  try {
    await pick(deps.forgetDeclined, forgetDeclined)(row.key, tenantId, record.sessionIds);
  } catch { /* best-effort: a stale decline only hides these ids from a session-start offer */ }
}

// A yes answers only the question it was shown with: the token must match the record's ids and shown kinds; → the record, or null.
async function consentShown(row, tenantId, token, deps) {
  const record = readOfferScan(row.key, tenantId);
  if (record == null) {
    console.log(`✗ Beezi: there is nothing to upload for ${workspaceName(row, tenantId)}. Run ${SYNC_COMMAND} to check again.`);
    return null;
  }
  if (token !== tokenOf(record)) {
    console.log(CHANGED_LINE);
    return null;
  }
  await consentOffer(row, tenantId, record, deps);
  return record;
}

// Tokens pair with the tenants by position; one that doesn't match skips only its workspace. The worker starts once.
async function accept({ row, tenantIds, sessionId }, tokenList, deps) {
  if (!(await mayPersist('uploading past sessions', sessionId))) return;
  const tokens = tokenList == null ? [] : refParts(tokenList);
  const consented = [];
  for (let i = 0; i < tenantIds.length; i += 1) {
    const record = await consentShown(row, tenantIds[i], tokens[i], deps);
    if (record != null) consented.push({ workspace: workspaceName(row, tenantIds[i]), count: record.count });
  }
  if (consented.length === 0) return;
  await startHistoryWorker(row.key, deps);
  console.log(backgroundLine(consented));
}

async function decline({ row, tenantIds }) {
  let audit = false;
  for (const tenantId of tenantIds) {
    const record = readOfferScan(row.key, tenantId);
    const changedAt = pastSessionsFor(row, tenantId).changedAt;
    await stampHistoryOffer(row.key, tenantId, { state: OfferState.DECLINED, changedAt, nowIso: new Date().toISOString() });
    audit = audit || (record != null && record.audit === true);
  }
  console.log(declineLine(audit));
}

async function scan(argv, deps) {
  const { session, rest } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(rest);
  const { value: via, rest: afterVia } = takeFlag(afterAccount, '--via');
  if (VIAS.indexOf(via) === -1) throw new UserError(USAGE);
  const rows = account != null ? [await getAccount(account)] : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  const tenantFlag = afterVia.indexOf('--tenant') !== -1;
  if (tenantFlag && (via !== 'sync' || rows.length !== 1)) throw new UserError('Beezi: --tenant goes with --via sync and --account <key>.');
  const parsed = tenantFlag ? parseTenantFlags(afterVia, rows[0]) : { argv: afterVia, tenantIds: [] };
  if (parsed.argv.length > 0) throw new UserError(USAGE);
  await printOffers(rows, { via, tenantOverride: parsed.tenantIds, sessionId: session }, deps);
}

export async function runHistoryOffer(argv, deps = {}) {
  if (argv[0] === 'accept') {
    const { value: token, rest } = takeFlag(argv.slice(1), '--offer');
    return accept(await answerTarget(rest), token, deps);
  }
  if (argv[0] === 'decline') return decline(await answerTarget(argv.slice(1)));
  return scan(argv, deps);
}
