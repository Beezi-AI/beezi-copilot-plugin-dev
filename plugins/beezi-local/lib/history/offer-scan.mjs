// The past-sessions offer: which sessions an upload to a workspace would send, found by a dry run of that same upload.
import fs from 'fs';
import { runAudit as _runAudit, planHistoryRuns as _planHistoryRuns } from './history-run.mjs';
import { createRunCache as _createRunCache } from './run-cache.mjs';
import { cwdReader, usableEntries, withVscodeEntries } from './candidates.mjs';
import { BackfillHalt, SYNC_MODE } from '../contract/history.mjs';
import { normPath } from '../core/fs-paths.mjs';
import { listSessionFiles as _listSessionFiles, readSessionHead as _readSessionHead } from '../sources/cli/session-files.mjs';
import { readSessionWorkspace as _readSessionWorkspace } from '../workspace/session-routes.mjs';
import { isMultiTenant, reviewBaselineMs, tenantById, tenantsOf } from '../workspace/tenants.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { linkedAtMs, readTrackingState, TrackingMode } from '../state/tracking.mjs';
import { sessionFor as _sessionFor } from '../auth/recipients.mjs';
import { whoami as _whoami } from '../auth/whoami.mjs';

export const BACKFILL_MODE = 'backfill';
export const REFUSED_REASONS = Object.freeze(['audit-only', 'workspace-required']);
export const REFUSED_HALTS = Object.freeze([BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER]);

const pick = (value, fallback) => (value == null ? fallback : value);

const DEFAULT_IO = Object.freeze({ readSessionHead: _readSessionHead, stat: (file) => fs.statSync(file) });

// The CLI head's startedAt, else the file's birth time when > 0, else null.
export function sessionStartMs(entry, io = DEFAULT_IO) {
  try {
    const head = io.readSessionHead(entry.transcriptPath);
    const ms = head == null ? NaN : Date.parse(head.startedAt);
    if (Number.isFinite(ms)) return ms;
    const born = io.stat(entry.transcriptPath).birthtimeMs;
    return Number.isFinite(born) && born > 0 ? born : null;
  } catch {
    return null;
  }
}

const isoMs = (at) => {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// max(link time, the workspace's joinedAt), a null tenant being a one-workspace row's only one; null when no link time is known.
export function linkCutoffMs(row, tenantId, tracking) {
  const tracked = linkedAtMs(tracking);
  const linked = tracked == null ? reviewBaselineMs(row) : tracked;
  if (linked == null) return null;
  const tenants = tenantsOf(row);
  const tenant = tenantById(row, tenantId == null && tenants != null && tenants.length === 1 ? tenants[0].id : tenantId);
  const joined = tenant == null ? null : isoMs(tenant.joinedAt);
  return joined == null ? linked : Math.max(linked, joined);
}

export function isPreLink(startMs, cutoffMs) {
  return cutoffMs == null || startMs == null || startMs < cutoffMs;
}

function resolveIo(io) {
  return {
    planHistoryRuns: pick(io.planHistoryRuns, _planHistoryRuns),
    listSessionFiles: pick(io.listSessionFiles, _listSessionFiles),
    readTracking: pick(io.readTracking, readTrackingState),
    readSessionHead: pick(io.readSessionHead, _readSessionHead),
    readSessionWorkspace: pick(io.readSessionWorkspace, _readSessionWorkspace),
    stat: pick(io.stat, DEFAULT_IO.stat),
    runAudit: pick(io.runAudit, _runAudit),
    createRunCache: pick(io.createRunCache, _createRunCache),
    sessionFor: pick(io.sessionFor, _sessionFor),
    whoami: pick(io.whoami, _whoami),
  };
}

// Whether the workspace is Audit by its own whoami (its header on a multi-workspace row, none on a lone one); audit is null without an answer.
export async function isAuditWorkspace(row, tenantId, deps, live) {
  if (live == null) return { audit: null, who: null };
  const who = await deps.whoami({ ...live, tenantId: isMultiTenant(row) ? tenantId : null }).catch(() => null);
  if (who == null) return { audit: null, who: null };
  return { audit: who.valid === true && who.trackingMode === TrackingMode.BACKFILL_ONLY, who };
}

// What every workspace of one row shares: the plan, the session listing and the login.
export async function prepareRowScan(row, io = {}) {
  const deps = resolveIo(io);
  const listed = usableEntries(withVscodeEntries(deps.listSessionFiles()), null);
  return {
    plan: deps.planHistoryRuns(row, { listed }),
    listed,
    live: await deps.sessionFor(row.key).catch(() => null),
  };
}

// The plan run an upload to tenantId uses: single-workspace runs carry a null tenant; unrouted runs carry no routes.
function runFor(row, tenantId, unrouted, plan) {
  if (!isMultiTenant(row)) return plan.runs[0];
  if (unrouted) return { tenantId, sessionRoutes: null };
  const found = plan.runs.find((r) => r.tenantId === tenantId);
  return found == null ? null : found;
}

function routedHere(run, tenantId, id) {
  if (run.sessionRoutes == null) return run.excludedSessionIds == null || !run.excludedSessionIds.has(id);
  const route = run.sessionRoutes.get(id);
  return route != null && route.tenantIds.indexOf(tenantId) !== -1;
}

// A one-workspace run has no routes: its session matches a place when a rule for that place would match its folder.
function placeTester(row, run, cwdOf) {
  if (run.sessionRoutes != null) {
    return (entry, place) => {
      const route = run.sessionRoutes.get(entry.sessionId);
      if (route == null) return false;
      return place.kind === 'new-folders'
        ? route.source === 'new-folders'
        : route.key != null && route.key.kind === place.kind && route.key.match === place.match;
    };
  }
  const ctx = createRouteContext();
  return (entry, place) => {
    const cwd = cwdOf(entry);
    if (cwd == null || place.kind === 'new-folders') return false;
    const probe = { key: row.key, tenants: tenantsOf(row), workspaceRules: [{ kind: place.kind, match: place.match, tenantIds: [] }] };
    return routeForDir(probe, cwd, ctx) != null;
  };
}

const baseName = (dir) => {
  const parts = (normPath(dir) || '').split('/').filter((part) => part !== '');
  return parts.length === 0 ? null : parts[parts.length - 1];
};

// entry → its working directory: the hook-saved one, else the recorded one; null when neither is known.
function cwdLookup(entries, io) {
  const readCwd = cwdReader(entries);
  return (entry) => {
    const state = io.readSessionWorkspace(entry.sessionId);
    return state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry.transcriptPath);
  };
}

// Folder base names by session count, then name.
function folderNames(entries, cwdOf) {
  const counts = new Map();
  for (const entry of entries) {
    const cwd = cwdOf(entry);
    const name = cwd == null ? null : baseName(cwd);
    if (name != null) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : a > b ? 1 : 0));
}

// A session's date is its start, else its last write.
function summaryOf(entries, startOf, cwdOf) {
  const dates = entries.map((entry) => {
    const start = startOf(entry);
    return start == null ? entry.mtimeMs : start;
  });
  return {
    sessionIds: entries.map((entry) => entry.sessionId),
    count: entries.length,
    firstMs: entries.length === 0 ? null : Math.min(...dates),
    lastMs: entries.length === 0 ? null : Math.max(...dates),
    folders: folderNames(entries, cwdOf),
  };
}

const empty = () => ({ sessionIds: [], count: 0, firstMs: null, lastMs: null, folders: [] });

function statusOf(result, syncMode) {
  if (result == null) return 'unavailable';
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return 'refused';
  if (result.halt === BackfillHalt.ALREADY_COMPLETED) return 'ok';
  if (result.reason === 'busy') return 'busy';
  if (result.reason === 'anonymization-key-missing' || (syncMode && result.coverageKnown === false)) return 'unavailable';
  if (result.deferredUnavailable > 0 || result.ok !== true) return 'unavailable';
  return 'ok';
}

// → { status, sessionIds, count, firstMs, lastMs, folders, mode, audit, reason }; counts only what the dry run planned.
export async function scanOffer(row, tenantId, { scope, places = null, unrouted = false, excludeIds = null, prepared = null }, io = {}) {
  const deps = resolveIo(io);
  const { plan, listed, live } = prepared == null ? await prepareRowScan(row, io) : prepared;
  const nothing = { status: 'ok', ...empty(), mode: SYNC_MODE, audit: false, reason: null };
  const run = runFor(row, tenantId, unrouted, plan);
  if (run == null) return nothing;
  const cwdOf = cwdLookup(listed, deps);
  const inPlace = places == null ? null : placeTester(row, run, cwdOf);
  const routed = listed.filter((entry) => (
    (excludeIds == null || !excludeIds.has(entry.sessionId))
    && (unrouted || routedHere(run, tenantId, entry.sessionId))
    && (inPlace == null || places.some((place) => inPlace(entry, place)))
  ));
  if (routed.length === 0) return nothing;

  const { audit, who } = await isAuditWorkspace(row, tenantId, deps, live);
  const mode = audit === true ? BACKFILL_MODE : SYNC_MODE;
  const done = (status, summary, reason) => ({ status, ...summary, mode, audit: audit === true, reason });
  if (audit == null) return done('unavailable', empty(), null);
  const cutoffMs = scope === 'offer' && !audit ? linkCutoffMs(row, tenantId, deps.readTracking(row.key)) : undefined;
  const starts = new Map();
  const startOf = (entry) => {
    if (!starts.has(entry.sessionId)) starts.set(entry.sessionId, sessionStartMs(entry, deps));
    return starts.get(entry.sessionId);
  };
  const kept = cutoffMs === undefined ? routed : routed.filter((entry) => isPreLink(startOf(entry), cutoffMs));
  if (kept.length === 0) return done('ok', empty(), null);

  const planned = new Set();
  const result = await deps.runAudit(
    { runCache: deps.createRunCache(), onPlanned: (id) => { planned.add(id); }, whoamiImpl: () => Promise.resolve(who) },
    {
      account: row.key,
      tenantId: run.tenantId,
      sessionRoutes: run.sessionRoutes,
      excludedSessionIds: run.excludedSessionIds,
      onlySessionIds: kept.map((entry) => entry.sessionId),
      mode,
      dryRun: true,
    },
  ).catch(() => null);
  const status = statusOf(result, !audit);
  const reason = result == null ? null : result.reason;
  if (status !== 'ok' || result.halt === BackfillHalt.ALREADY_COMPLETED) return done(status, empty(), reason);
  return done(status, summaryOf(kept.filter((entry) => planned.has(entry.sessionId)), startOf, cwdOf), reason);
}
