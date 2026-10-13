// Which past sessions a history run replays, and from which line: discovery, the candidate filter and sync coverage.
// A namespace import: a named import of a missing resolveSessionId export would fail this module's link.
import { resolveSessionId } from '../host/session-resolver.mjs';
import { readSessionHead } from '../sources/cli/session-files.mjs';
import { listVscodeSessions } from '../sources/vscode/session-files.mjs';
import { vscodeCursorOf } from '../state/session-state.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { isImported, ledgerDelivered } from '../state/ledger.mjs';
import { checkpointLineFor } from '../state/coverage-record.mjs';
import { decideReplay, heldLineOf, ReplayDecision, DeferReason } from '../delivery/coverage.mjs';
import { linkedAtMs, TrackingMode } from '../state/tracking.mjs';
import { ACTIVE_SESSION_WINDOW_MS } from './scan-limits.mjs';
import { MAX_TRANSCRIPT_BYTES } from '../contract/report-limits.mjs';
import { AUDIT_TIMEOUT_MS } from '../contract/history.mjs';

// The session this command runs inside; a null answer is fine because the active-window skip covers it.
async function currentSessionId(env, deps) {
  try {
    const resolve = deps.resolveSessionIdImpl == null ? resolveSessionId : deps.resolveSessionIdImpl;
    if (typeof resolve !== 'function') return null;
    const found = await resolve({ env, cwd: process.cwd() });
    const id = found == null ? null : found.sessionId;
    return isUsableSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

// Entries with an unusable session id never reach a path, and are dropped without counting.
export function usableEntries(list, only) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry == null || !isUsableSessionId(entry.sessionId)) continue;
    if (only != null && !only.has(entry.sessionId)) continue;
    out.push(entry);
  }
  return out;
}

function readCwdOf(transcriptPath) {
  try {
    const head = readSessionHead(transcriptPath);
    return head == null || head.cwd == null ? null : head.cwd;
  } catch {
    return null;
  }
}

// The CLI session head, or {} when it cannot be read.
export function attemptHead(transcriptPath) {
  try {
    return readSessionHead(transcriptPath) || {};
  } catch {
    return {};
  }
}

// Copilot CLI session files plus VS Code Local-agent chat sessions (kind 'vscode', transcriptPath = the chat file, folder = its cwd).
export function withVscodeEntries(cliEntries) {
  const list = Array.isArray(cliEntries) ? cliEntries : [];
  const ids = new Set(list.map((entry) => (entry == null ? null : entry.sessionId)));
  const out = list.slice();
  for (const s of listVscodeSessions()) {
    if (ids.has(s.sessionId)) continue;
    out.push({ sessionId: s.sessionId, transcriptPath: s.file, mtimeMs: s.mtimeMs, size: s.size, kind: 'vscode', folder: s.folder });
  }
  return out;
}

// readCwd(transcriptPath) for route planning: a VS Code chat file answers with its folder, never through the CLI head reader.
export function cwdReader(entries) {
  const folders = new Map();
  for (const entry of entries) if (entry.kind === 'vscode') folders.set(entry.transcriptPath, entry.folder == null ? null : entry.folder);
  return (transcriptPath) => (folders.has(transcriptPath) ? folders.get(transcriptPath) : readCwdOf(transcriptPath));
}

function localCursorOf(entry) {
  if (entry.kind === 'vscode') {
    const cursor = vscodeCursorOf(entry.sessionId);
    return cursor == null ? 0 : cursor;
  }
  const state = loadSessionState(entry.sessionId);
  return Number.isInteger(state.cursorLine) ? state.cursorLine : 0;
}

// A VS Code session is live-covered only when a hook or watcher saved its cursor after the cutoff: audits never persist state, so updatedAt with a vscode block is live evidence.
function vscodeLiveSince(sessionId, cutoffMs) {
  const state = loadSessionState(sessionId);
  if (state.vscode == null || state.updatedAt == null) return false;
  const at = Date.parse(state.updatedAt);
  return isFinite(at) && at > cutoffMs;
}

const emptyCounts = () => ({ live: 0, routedElsewhere: 0, routeDeferred: 0, active: 0, liveTracked: 0, excluded: 0, alreadyImported: 0, oversize: 0 });

// Sessions skipped for being open or just touched: the history worker waits for the ones older than its request.
function noteRecent(recent, entry) {
  if (typeof entry.transcriptPath === 'string') recent.push({ sessionId: entry.sessionId, path: entry.transcriptPath });
}

// → { candidates, counts, settledIds, recent }; `facts.isLiveVscode(id)` and `facts.localCursor(entry)` are asked lazily, in filter order.
export function filterCandidates(entries, facts) {
  const counts = emptyCounts();
  const settledIds = [];
  const candidates = [];
  const recent = [];
  const { liveId, sessionRoutes, tenantId, linkCutoffMs, activeCutoffMs, syncMode, liveMode, excludedSessionIds } = facts;
  // The live skip runs before the route filter, so it notes only a session whose route reaches this workspace.
  const routedHere = (id) => sessionRoutes == null || (sessionRoutes.get(id) != null && sessionRoutes.get(id).tenantIds.indexOf(tenantId) !== -1);
  for (const entry of entries) {
    const id = entry.sessionId;
    if (liveId != null && id === liveId) {
      counts.live += 1;
      if (routedHere(id)) noteRecent(recent, entry);
      continue;
    }
    // Filtered before the ledger, so a later rule can still send it here.
    if (sessionRoutes != null) {
      const route = sessionRoutes.get(id);
      if (route == null || route.tenantIds.indexOf(tenantId) === -1) {
        counts.routedElsewhere += 1;
        // Holds the seal only for a waiting session this run would take if a rule sent it here (post-link ones are tracked live).
        if (route != null && route.waiting === true && !(linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs)) counts.routeDeferred += 1;
        continue;
      }
    }
    // An open VS Code session with no recent live checkpoint is processed here: its settled requests upload, the running one waits.
    if (entry.mtimeMs > activeCutoffMs && (entry.kind !== 'vscode' || facts.isLiveVscode(id))) { counts.active += 1; noteRecent(recent, entry); continue; }
    if (linkCutoffMs != null && entry.mtimeMs >= linkCutoffMs) { counts.liveTracked += 1; continue; }
    // Without a link stamp, a live cursor is the remaining evidence that live tracking already owns the session.
    if (!syncMode && liveMode && linkCutoffMs == null && facts.localCursor(entry) > 0) { counts.liveTracked += 1; continue; }
    // One-workspace accounts only: a matched Don't-track rule. Never reaches the ledger or the machine-wide watermark, so another account and a removed rule still see it.
    if (excludedSessionIds != null && excludedSessionIds.has(id)) { counts.excluded += 1; continue; }
    if (!syncMode && !facts.force && isImported(facts.ledger, id)) { counts.alreadyImported += 1; continue; }
    if (facts.sinceMs != null && entry.mtimeMs < facts.sinceMs) continue;
    if (entry.size > MAX_TRANSCRIPT_BYTES) { counts.oversize += 1; settledIds.push(id); continue; }
    candidates.push(entry);
  }
  return { candidates, counts, settledIds, recent };
}

// The candidates stage: list, skip the live, active, routed-away, excluded, imported and oversize sessions, count each.
export async function selectCandidates(run) {
  const { result, options, syncMode, multi, who, tracking, trackingValid } = run;
  const only = options.onlySessionIds == null ? null : new Set(options.onlySessionIds);
  const all = usableEntries(withVscodeEntries(run.io.listSessionFiles()), only);
  result.scanned = all.length;
  const liveId = await currentSessionId(run.io.env, run.deps);

  // Live-tracking workspaces: everything since the machine link was tracked live, and re-sending it would double-count once its cursor was pruned.
  const liveMode = multi
    ? who != null && who.valid && who.trackingMode === TrackingMode.LIVE
    : trackingValid && tracking != null && tracking.trackingMode === TrackingMode.LIVE;
  const activeCutoffMs = run.io.now() - ACTIVE_SESSION_WINDOW_MS;
  const picked = filterCandidates(all, {
    liveId,
    sessionRoutes: options.sessionRoutes == null ? null : options.sessionRoutes,
    tenantId: run.tenantId,
    // Sync keeps post-link sessions in scope on purpose: a session whose hooks died mid-file is what it repairs, and coverage stops it re-sending what landed.
    linkCutoffMs: liveMode && !syncMode ? linkedAtMs(tracking) : null,
    activeCutoffMs,
    syncMode,
    liveMode,
    excludedSessionIds: options.excludedSessionIds == null ? null : options.excludedSessionIds,
    force: options.force,
    ledger: run.ledger,
    sinceMs: options.sinceMs,
    isLiveVscode: (id) => vscodeLiveSince(id, activeCutoffMs),
    localCursor: localCursorOf,
  });
  for (const name of Object.keys(picked.counts)) result[name] += picked.counts[name];
  result.settledIds.push(...picked.settledIds);
  result.recent.push(...picked.recent);
  return picked.candidates;
}

// The coverage stage (sync only): ask the server how far each candidate reaches and keep only sessions whose start line
// can be proven → { candidates, startCursors }.
export async function proveStartLines(run, candidates) {
  const { result } = run;
  const startCursors = new Map();
  if (!run.syncMode) return { candidates, startCursors };
  if (candidates.length === 0) {
    result.coverageKnown = true;
    return { candidates, startCursors };
  }
  const coverage = await run.io.fetchCoverage(
    candidates.map((entry) => entry.sessionId),
    run.session,
    { fetchImpl: run.io.fetchImpl },
    { timeoutMs: AUDIT_TIMEOUT_MS },
  ).catch(() => null);
  result.coverageKnown = coverage !== null;
  const eligible = [];
  for (const entry of candidates) {
    const verdict = decideReplay(entry.sessionId, {
      coverage,
      checkpointLine: checkpointLineFor(run.coverageRecord, entry.sessionId),
      localCursor: localCursorOf(entry),
      ledgerDelivered: ledgerDelivered(run.ledger, entry.sessionId),
      held: run.syncMode ? heldLineOf(coverage, entry.sessionId) : null,
    });
    if (verdict.decision === ReplayDecision.DEFER) {
      result.deferred += 1;
      if (verdict.reason === DeferReason.UNAVAILABLE) result.deferredUnavailable += 1;
      else result.deferredGap += 1;
      continue;
    }
    startCursors.set(entry.sessionId, verdict.startCursor);
    eligible.push(entry);
  }
  return { candidates: eligible, startCursors };
}
