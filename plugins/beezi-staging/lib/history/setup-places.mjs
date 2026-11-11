// The offer's gated scan of one workspace, and the setup listing's places: the sessions the consented upload would send.
import fs from 'fs';
import { cwdLookup, prepareRowScan, scanOffer as _scanOffer, sessionStartMs } from './offer-scan.mjs';
import { createRunCache as _createRunCache } from './run-cache.mjs';
import { pastSessionsFor } from '../core/anon-target.mjs';
import { readTrackingState } from '../state/tracking.mjs';
import { readSessionHead as _readSessionHead } from '../sources/cli/session-files.mjs';
import { isMultiTenant, offerableTenantIds, tenantsOf } from '../workspace/tenants.mjs';
import { OfferAction, offerAction, offerTrackingDisabled } from '../workspace/pending-history.mjs';
import { declinedIds } from '../workspace/history-offer-record.mjs';
import { createRouteContext, routeKeyForDir } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { isLineSafePlace, shortLabel } from '../workspace/rule-model.mjs';
import { readSessionWorkspace as _readSessionWorkspace } from '../workspace/session-routes.mjs';

const pick = (value, fallback) => (value == null ? fallback : value);

// One workspace's scan, writing nothing → { scan, places }; the offer scope's gate may skip it (null) and its declines stay out, sync lists them (PK2).
export async function offerScan(row, tenantId, cx, deps = {}) {
  const pastSessions = pastSessionsFor(row, tenantId);
  let places = null;
  if (cx.scope !== 'sync') {
    const gate = offerAction(row, tenantId, { pastSessions, trackingDisabled: offerTrackingDisabled(row, tenantId, cx.tracking) });
    if (gate.action === OfferAction.SKIP) return null;
    places = gate.places;
  }
  const excludeIds = cx.scope === 'offer' ? declinedIds(row.key, tenantId, pastSessions.changedAt) : null;
  const options = { scope: cx.scope, places, unrouted: cx.unrouted, excludeIds, prepared: await cx.prepared() };
  const scan = await pick(deps.scanOffer, _scanOffer)(row, tenantId, options, { ...deps, createRunCache: () => cx.runCache });
  return { scan, places };
}

// A place name holding ` <word>=` could be read as a field of its listing line.
const FIELD_LIKE = / [\w-]+=/;
const fieldSafe = (key) => !FIELD_LIKE.test(key.match) && !FIELD_LIKE.test(key.label || '');

// The sessions among `ids` with a known, line-safe place (byId → { key, dir, entry }) and the count with no folder; all the consented upload sends.
export function eligibleSessions(ids, listed, deps = {}, ctx = createRouteContext()) {
  const cwdOf = cwdLookup(listed, { readSessionWorkspace: pick(deps.readSessionWorkspace, _readSessionWorkspace) });
  const byId = new Map();
  let noFolder = 0;
  for (const entry of listed) {
    if (!ids.has(entry.sessionId)) continue;
    const dir = cwdOf(entry);
    const key = dir == null ? null : routeKeyForDir(dir, ctx);
    if (key == null) noFolder += 1;
    else if (isLineSafePlace(key) && fieldSafe(key)) byId.set(entry.sessionId, { key, dir, entry });
  }
  return { byId, noFolder };
}

// Every workspace's run with no routes and no Don't-track exclusions: the listing counts before rules apply.
function unruledPlan(row) {
  return { runs: isMultiTenant(row) ? tenantsOf(row).map((t) => ({ tenantId: t.id, sessionRoutes: null })) : [{ tenantId: null, sessionRoutes: null }] };
}

// The ids every open workspace's offer scan counts, or { failed: tenantId } when one could not be scanned.
async function plannedIds(row, prepared, deps) {
  const cx = {
    scope: 'offer', unrouted: false, prepared: () => prepared,
    tracking: pick(deps.readTracking, readTrackingState)(row.key), runCache: pick(deps.createRunCache, _createRunCache)(),
  };
  const ids = new Set();
  for (const tenantId of offerableTenantIds(row)) {
    const found = await offerScan(row, tenantId, cx, deps);
    if (found == null || found.scan.status === 'refused') continue;
    if (found.scan.status !== 'ok') return { failed: tenantId };
    found.scan.sessionIds.forEach((id) => ids.add(id));
  }
  return { ids };
}

const idsKey = (ids) => (ids == null ? null : ids.slice().sort().join(','));

const outsideLast = (place) => (place.kind === 'outside' ? 1 : 0);
const byListOrder = (a, b) => outsideLast(a) - outsideLast(b) || b.sessions - a.sessions || (a.label < b.label ? -1 : Number(a.label > b.label));

// Places of sessions the consented upload would send before rules, by sessions, outside last; tracked = the rule's ids, null without one or when its sessions' rules differ.
export async function setupPlaces(row, deps = {}) {
  const prepared = await prepareRowScan(row, { ...deps, planHistoryRuns: unruledPlan });
  const { ids, failed } = await plannedIds(row, prepared, deps);
  if (failed != null) return { failed };
  const ctx = createRouteContext();
  const eligible = eligibleSessions(ids, prepared.listed, deps, ctx);
  const io = { readSessionHead: pick(deps.readSessionHead, _readSessionHead), stat: pick(deps.stat, (file) => fs.statSync(file)) };
  const byKey = new Map();
  const dates = [];
  for (const { key, dir, entry } of eligible.byId.values()) {
    const id = `${key.kind}\n${key.match}`;
    const rule = routeForDir(row, dir, ctx);
    const tracked = rule == null ? null : rule.tenantIds;
    if (!byKey.has(id)) byKey.set(id, { kind: key.kind, match: key.match, label: key.label, short: shortLabel(key), sessions: 0, tracked });
    const place = byKey.get(id);
    if (idsKey(place.tracked) !== idsKey(tracked)) place.tracked = null;
    place.sessions += 1;
    const start = sessionStartMs(entry, io);
    dates.push(start == null ? entry.mtimeMs : start);
  }
  return {
    places: Array.from(byKey.values()).sort(byListOrder),
    sessionIds: Array.from(eligible.byId.keys()),
    firstMs: dates.length === 0 ? null : Math.min(...dates),
    lastMs: dates.length === 0 ? null : Math.max(...dates),
    noFolder: eligible.noFolder,
  };
}
