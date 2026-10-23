// history-offer.mjs: the past-sessions offer. A scan prints the K7 block and records the decline; accept and decline answer it.
import { prepareRowScan, scanOffer as _scanOffer } from '../../history/offer-scan.mjs';
import { createRunCache as _createRunCache } from '../../history/run-cache.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import {
  declinedIds, forgetDeclined, offerToken, readOfferScan, rememberDeclined, writeOfferScan,
} from '../../workspace/history-offer-record.mjs';
import { readTrackingState } from '../../state/tracking.mjs';
import { anonymizationFor, kindsOf, pastSessionsFor, unionOf } from '../../core/anon-target.mjs';
import { UserError } from '../../core/errors.mjs';
import { pluginRoot } from '../../config/plugin-root.mjs';
import { AccountStatus, getAccount, listAccounts, parseAccountFlag } from '../../accounts/index-store.mjs';
import { isMultiTenant, offerableTenantIds, tenantById } from '../../workspace/tenants.mjs';
import { OfferAction, OfferState, offerAction, offerTrackingDisabled, pendingHistoryOf } from '../../workspace/pending-history.mjs';
import { clearHistoryOfferPlaces, consentPastSessions, stampHistoryOffer } from '../../workspace/settings-store.mjs';
import { SYNC_COMMAND, acceptLine, declineLine, offerLines } from '../../ux/history-offer-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { parseTenantFlags } from '../tenant-flags.mjs';
import { mayPersist, parseSessionFlag } from '../workspace/args.mjs';

const VIAS = ['session-start', 'login', 'setup', 'sync'];
const USAGE = 'Usage: history-offer.mjs --via <session-start|login|setup|sync> [--account <ref>] [--session <id>] [--tenant <ids>]'
  + ' | accept --account <key> --tenant <id> --offer <token> [--session <id>] | decline --account <key> --tenant <id>';
const UNKNOWN_WORKSPACE_LINE = "✗ Beezi: this account's workspace isn't known yet. Start a new Copilot session or run /beezi-local-login, then try again.";
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

function offerBlock(row, tenantId, scan, sessionId, kinds) {
  const { lines, question } = offerLines({
    count: scan.count, firstMs: scan.firstMs, lastMs: scan.lastMs, folders: scan.folders,
    kinds, workspace: workspaceName(row, tenantId),
  });
  const command = `node "${pluginRoot()}/scripts/history-offer.mjs"`;
  const target = `--account ${row.key} --tenant ${tenantId}`;
  return [
    `<offer account="${row.key}" tenant="${tenantId}">`,
    ...lines,
    machineLine([['question', question]]),
    machineLine([['accept-command', `${command} accept ${target} --offer ${offerToken(scan.sessionIds, kinds)}${sessionId == null ? '' : ` --session ${sessionId}`}`]]),
    machineLine([['decline-command', `${command} decline ${target}`]]),
    '</offer>',
  ];
}

// One workspace: the gate (not for sync), the scan, then its record and stamp; prints the block and returns true when it asks.
async function offerOne(row, tenantId, cx, deps) {
  // An accepted upload still owed keeps its scan record until it settles, so nothing rescans that workspace.
  if (pendingHistoryOf(row).some((e) => e.tenantId === tenantId)) {
    if (cx.via === 'sync') console.log(`✓ Beezi: past sessions for ${workspaceName(row, tenantId)} are already uploading in the background.`);
    return false;
  }
  const pastSessions = pastSessionsFor(row, tenantId);
  let places = null;
  if (cx.via !== 'sync') {
    const gate = offerAction(row, tenantId, { pastSessions, trackingDisabled: offerTrackingDisabled(row, tenantId, cx.tracking) });
    if (gate.action === OfferAction.SKIP) return false;
    places = gate.places;
  }
  const scanOffer = pick(deps.scanOffer, _scanOffer);
  const scope = cx.via === 'sync' ? 'sync' : 'offer';
  // Offer scope drops the sessions already declined under this changedAt; sync lists them again (PK2).
  const excludeIds = scope === 'offer' ? declinedIds(row.key, tenantId, pastSessions.changedAt) : null;
  const options = { scope, places, unrouted: cx.unrouted, excludeIds, prepared: await cx.prepared() };
  const scan = await scanOffer(row, tenantId, options, { ...deps, createRunCache: () => cx.runCache });
  const nowIso = new Date().toISOString();
  const stamp = (state) => stampHistoryOffer(row.key, tenantId, { state, changedAt: pastSessions.changedAt, nowIso });
  if (scan.status === 'unavailable' || scan.status === 'busy') {
    console.log(`✗ Beezi: couldn't check past sessions for ${workspaceName(row, tenantId)} right now. Run ${SYNC_COMMAND} later.`);
    return false;
  }
  if (scan.status === 'refused' || (scan.count === 0 && places == null)) {
    await stamp(OfferState.SETTLED);
    return false;
  }
  if (scan.count === 0) {
    await clearHistoryOfferPlaces(row.key, tenantId);
    return false;
  }
  const { sessionIds, mode, count, firstMs, lastMs, audit } = scan;
  const shownKinds = kindsOf(anonymizationFor(row, tenantId));
  await writeOfferScan(row.key, tenantId, { sessionIds, mode, unrouted: cx.unrouted, count, firstMs, lastMs, audit, scannedAt: nowIso, shownKinds });
  for (const line of offerBlock(row, tenantId, scan, cx.sessionId, shownKinds)) console.log(line);
  try {
    await pick(deps.rememberDeclined, rememberDeclined)(row.key, tenantId, { ids: sessionIds, changedAt: pastSessions.changedAt });
  } catch { /* best-effort: without the remembered decline the next offer asks about these again */ }
  await stamp(OfferState.DECLINED);
  return true;
}

// One block per workspace with sessions to offer, then `offers=<n>`; --via sync skips the gate and scans every session.
export async function printOffers(rows, { via, tenantOverride = [], sessionId = null }, deps = {}) {
  const readTracking = pick(deps.readTracking, readTrackingState);
  const createRunCache = pick(deps.createRunCache, _createRunCache);
  let offers = 0;
  for (const row of rows) {
    const unrouted = tenantOverride.length > 0 && isMultiTenant(row);
    let prepared = null;
    // One git cache, plan, listing and login per account, shared by its workspaces' scans; prepared on the first scan only.
    const cx = {
      via, unrouted, sessionId, tracking: readTracking(row.key), runCache: createRunCache(),
      prepared: () => prepared || (prepared = prepareRowScan(row, deps)),
    };
    const tenantIds = unrouted ? tenantOverride : offerableTenantIds(row);
    if (via === 'sync' && tenantIds.length === 0) console.log(UNKNOWN_WORKSPACE_LINE);
    for (const tenantId of tenantIds) {
      if (await offerOne(row, tenantId, cx, deps)) offers += 1;
    }
  }
  console.log(machineLine([['offers', offers]]));
  return offers;
}

// accept / decline: the account row and a workspace the offer could have asked about.
async function answerTarget(argv) {
  const { session, rest } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(rest);
  const { value: tenantId, rest: left } = takeFlag(afterAccount, '--tenant');
  const row = account == null ? null : await getAccount(account);
  if (row == null || tenantId == null || left.length > 0) throw new UserError(USAGE);
  if (offerableTenantIds(row).indexOf(tenantId) === -1) throw new UserError(`Beezi: ${tenantId} is not a workspace of this account.`);
  return { row, tenantId, sessionId: session };
}

// A yes answers only the question it was shown with: the token must match the record's ids and shown kinds, which the entry then carries.
async function accept({ row, tenantId, sessionId }, token, deps) {
  if (!(await mayPersist('uploading past sessions', sessionId))) return;
  const record = readOfferScan(row.key, tenantId);
  if (record == null) {
    console.log(`✗ Beezi: there is nothing to upload for ${workspaceName(row, tenantId)}. Run ${SYNC_COMMAND} to check again.`);
    return;
  }
  if (token !== offerToken(record.sessionIds, record.shownKinds)) {
    console.log(CHANGED_LINE);
    return;
  }
  const accepted = {
    sessionIds: record.sessionIds,
    mode: record.mode,
    unrouted: record.unrouted,
    // Kinds shown hidden stay hidden at the yes (PK1), plus any turned on since.
    hiddenKinds: unionOf(record.shownKinds, kindsOf(anonymizationFor(row, tenantId))),
    scannedAt: record.scannedAt,
  };
  await consentPastSessions(row.key, tenantId, { changedAt: pastSessionsFor(row, tenantId).changedAt, accepted });
  try {
    await pick(deps.forgetDeclined, forgetDeclined)(row.key, tenantId, record.sessionIds);
  } catch { /* best-effort: a stale decline only hides these ids from a session-start offer */ }
  await startHistoryWorker(row.key, deps);
  console.log(acceptLine(record.count, workspaceName(row, tenantId)));
}

async function decline({ row, tenantId }) {
  const record = readOfferScan(row.key, tenantId);
  const changedAt = pastSessionsFor(row, tenantId).changedAt;
  await stampHistoryOffer(row.key, tenantId, { state: OfferState.DECLINED, changedAt, nowIso: new Date().toISOString() });
  console.log(declineLine(record != null && record.audit === true));
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
