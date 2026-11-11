// history-offer.mjs count phase and consent, shared by the offer and the setup's consented upload (`--consented`).
import { prepareRowScan } from '../../history/offer-scan.mjs';
import { offerScan } from '../../history/setup-places.mjs';
import { createRunCache as _createRunCache } from '../../history/run-cache.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';
import { declinedIds, forgetDeclined, takeAnsweredSetup, writeOfferScan } from '../../workspace/history-offer-record.mjs';
import { readTrackingState } from '../../state/tracking.mjs';
import { anonymizationFor, kindsOf, pastSessionsFor, unionOf } from '../../core/anon-target.mjs';
import { UserError } from '../../core/errors.mjs';
import { INDEX_LOCK_BUSY } from '../../accounts/index-store.mjs';
import { isMultiTenant, offerableTenantIds, tenantById } from '../../workspace/tenants.mjs';
import { OfferState, pendingHistoryOf } from '../../workspace/pending-history.mjs';
import { clearHistoryOfferPlaces, consentPastSessions, stampHistoryOffer } from '../../workspace/settings-store.mjs';
import { SYNC_COMMAND } from '../../ux/history-offer-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { mayPersist } from '../workspace/args.mjs';

const pick = (value, fallback) => (value == null ? fallback : value);

export function workspaceName(row, tenantId) {
  const tenant = tenantById(row, tenantId);
  if (tenant != null && tenant.name) return tenant.name;
  return row.tenantName || tenantId;
}

export const uncheckedLine = (row, tenantId) => `✗ Beezi: couldn't check past sessions for ${workspaceName(row, tenantId)} right now. Run ${SYNC_COMMAND} later.`;

// Runs write; resolves true, or false on an index-lock timeout; any other error is rethrown.
export async function lockedWrite(write) {
  try {
    await write();
    return true;
  } catch (error) {
    if (error instanceof UserError && error.message === INDEX_LOCK_BUSY) return false;
    throw error;
  }
}

export function stampAs(row, tenantId, state, changedAt, deps) {
  const stamp = { state, changedAt, nowIso: new Date().toISOString() };
  return lockedWrite(() => pick(deps.stampHistoryOffer, stampHistoryOffer)(row.key, tenantId, stamp));
}

// One git cache, plan, listing and login per account, shared by its workspaces' scans; prepared on the first scan only.
export function rowContext(row, { via, tenantOverride = [], sessionId = null }, deps) {
  let prepared = null;
  return {
    via,
    scope: via === 'sync' ? 'sync' : 'offer',
    unrouted: tenantOverride.length > 0 && isMultiTenant(row),
    override: tenantOverride.length > 0,
    sessionId,
    tracking: pick(deps.readTracking, readTrackingState)(row.key),
    runCache: pick(deps.createRunCache, _createRunCache)(),
    failed: false,
    prepared: () => prepared || (prepared = prepareRowScan(row, deps)),
  };
}

// Count phase, one workspace: the gate (not for sync), the scan and its record → { tenantId, record, folders, changedAt, upload },
// or null when it shows nothing; a workspace it could not check sets cx.failed.
async function countOne(row, tenantId, cx, deps) {
  // An accepted upload still owed keeps its scan record until it settles, so nothing rescans that workspace.
  if (pendingHistoryOf(row).some((e) => e.tenantId === tenantId)) {
    if (cx.via === 'sync') console.log(`✓ Beezi: past sessions for ${workspaceName(row, tenantId)} are already uploading in the background.`);
    return null;
  }
  const { changedAt } = pastSessionsFor(row, tenantId);
  const found = await offerScan(row, tenantId, cx, deps);
  if (found == null) return null;
  const { scan, places } = found;
  const unchecked = () => {
    console.log(uncheckedLine(row, tenantId));
    cx.failed = true;
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
  const freshDeclined = cx.scope === 'sync' && scan.upload === true ? declinedIds(row.key, tenantId, scan.changedAt) : new Set();
  // No-ask only on the scan's fresh `upload` (R17); a --tenant override (R6) and an audit workspace (R15) ask first.
  const upload = scan.upload === true && !cx.override && audit !== true && !sessionIds.some((id) => freshDeclined.has(id));
  return { tenantId, record, folders: scan.folders, changedAt, upload };
}

// Every workspace of the row in `tenantIds`, counted in order.
export async function countRow(row, cx, tenantIds, deps) {
  const counted = [];
  for (const tenantId of tenantIds) {
    const item = await countOne(row, tenantId, cx, deps);
    if (item != null) counted.push(item);
  }
  return counted;
}

// Consents to exactly the record's sessions and forgets their declines; the entry carries the record's ids and shown kinds.
export async function consentOffer(row, tenantId, record, deps) {
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

// Owes each counted workspace the listed sessions routed to it now, under the kinds the listing showed it; → { owed: their id lists, failed: a consent timed out }.
async function oweListed(row, counted, setup, deps) {
  const listed = new Set(setup.sessionIds);
  const owed = [];
  let failed = false;
  for (const item of counted) {
    const shownKinds = setup.kinds[item.tenantId];
    const sessionIds = item.record.sessionIds.filter((id) => listed.has(id));
    if (shownKinds == null || sessionIds.length === 0) continue;
    if (await lockedWrite(() => consentOffer(row, item.tenantId, { ...item.record, sessionIds, shownKinds }, deps))) owed.push(sessionIds);
    else {
      console.log(uncheckedLine(row, item.tenantId));
      failed = true;
    }
  }
  return { owed, failed };
}

// `uploading=<N> workspaces=<n>` with N the distinct sessions owed; a failure sets the exit status.
function printUploading(owed, failed) {
  const ids = new Set();
  owed.forEach((sessionIds) => sessionIds.forEach((id) => ids.add(id)));
  console.log(machineLine([['uploading', ids.size], ['workspaces', owed.length]]));
  if (failed) process.exitCode = 1;
}

// --consented: takes the answered setup record (none owes nothing), then owes each counted workspace its listed sessions with no question recorded, then one worker.
export async function consentedUpload(row, sessionId, deps) {
  if (!(await mayPersist('uploading past sessions', sessionId))) return printUploading([], true);
  const setup = await pick(deps.takeAnsweredSetup, takeAnsweredSetup)(row.key);
  if (setup == null) return printUploading([], false);
  const cx = rowContext(row, { via: 'setup', sessionId }, deps);
  const counted = await countRow(row, cx, offerableTenantIds(row), deps);
  if (cx.failed || counted.length === 0) return printUploading([], cx.failed);
  const { owed, failed } = await oweListed(row, counted, setup, deps);
  if (owed.length > 0 && !(await startHistoryWorker(row.key, deps))) return printUploading([], true);
  return printUploading(owed, failed);
}
