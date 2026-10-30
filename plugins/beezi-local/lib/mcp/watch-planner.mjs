// Pure planning of one watcher pass over the scan and the watermark: which sessions are due, fresh, quiet or deferred.
import { observationFor, keptField, settlementKey } from '../state/watcher-record.mjs';
import { ACTIVE_SESSION_WINDOW_MS } from '../history/scan-limits.mjs';
import { finiteNumber, isPlain } from '../core/guards.mjs';

export const HOOK_QUIET_MS = 5 * 60 * 1000;
const SESSION_COOLDOWN_MS = 60000;
const MAX_SESSIONS_PER_PASS = 5;

function changedSince(prior, entry) {
  if (prior == null) return true;
  // An old watcher's oversizeAt marker makes the session due once; the next stored observation drops it.
  if (keptField(prior, 'oversizeAt') !== null) return true;
  if (entry.mtimeMs > prior.mtimeMs) return true;
  // `!==` rather than `>`: a shrink is also a change, so the engine gets to report a cursor mismatch.
  return finiteNumber(prior.size) !== null && entry.size !== prior.size;
}

// The later of the watcher's last observation and its last attempt that settled nothing (this process only); null when neither.
function lastTouched(prior, attemptedAt) {
  const at = prior == null ? null : finiteNumber(prior.at);
  const tried = finiteNumber(attemptedAt);
  if (at === null) return tried;
  return tried === null ? at : Math.max(at, tried);
}

// The hooks stopped keeping up: the file was written more than HOOK_QUIET_MS after the hooks last saved the state.
function hooksFellBehind(entry, state) {
  const savedAt = typeof state.updatedAt === 'string' ? Date.parse(state.updatedAt) : NaN;
  return isFinite(savedAt) && entry.mtimeMs - savedAt > HOOK_QUIET_MS;
}

// due = established and changed past cooldown; fresh = unestablished and active; quiet = unestablished, changed and idle.
// Hook deference only reduces load: it ends HOOK_QUIET_MS after the last hook advance, when the hooks fell behind the
// file, or at once for a session.shutdown past the cursor. hookStamps are [id, at, cursorLine] for applyHookStamps.
// `attempts` (id → ms) are the runs that settled nothing: they cool down and queue behind the rest, so a session held on
// the same reason pass after pass never takes every slot.
export function planPass({ entries, record, nowMs, readState, isExcluded, hasShutdownPast, attempts = new Map() }) {
  const candidates = [];
  const fresh = [];
  const quiet = [];
  const hookStamps = [];
  let cooling = 0;
  let hookActive = 0;

  for (const entry of entries) {
    const id = entry.sessionId;
    const prior = observationFor(record, id);
    if (!changedSince(prior, entry)) continue;
    const active = nowMs - entry.mtimeMs <= ACTIVE_SESSION_WINDOW_MS;
    // A machine with thousands of old sessions stays at one stat each: no state read for an idle, never-seen session.
    if (!active && prior == null) { quiet.push({ entry, prior, state: null }); continue; }
    const state = readState(entry);
    const lastAt = lastTouched(prior, attempts.get(id));
    if (!Number.isInteger(state.cursorLine)) {
      (active ? fresh : quiet).push({ entry, prior, state, lastAt });
      continue;
    }
    let hookSeenAt = prior == null ? null : keptField(prior, 'hookSeenAt');
    // A hook advanced the cursor past the last one seen; the stamp also records that cursor, so it refreshes only on a real advance.
    if (prior != null && Number.isInteger(prior.cursorAfter) && state.cursorLine > prior.cursorAfter) {
      hookSeenAt = nowMs;
      hookStamps.push([id, nowMs, state.cursorLine]);
    }
    const deferred = hookSeenAt !== null && nowMs - hookSeenAt < HOOK_QUIET_MS
      && !hooksFellBehind(entry, state) && !hasShutdownPast(entry, state.cursorLine);
    if (deferred) { hookActive += 1; continue; }
    if (lastAt !== null && nowMs - lastAt < SESSION_COOLDOWN_MS) { cooling += 1; continue; }
    candidates.push({ entry, prior, state, lastAt });
  }

  // An excluded session is dropped before the per-pass slice, so it never takes a slot from a tracked one; it is re-judged every pass, so removing the rule resumes capture.
  const kept = (items) => items.filter((item) => !isExcluded(item));
  const due = kept(candidates);
  const freshKept = kept(fresh);

  const lastAt = (item) => (item.lastAt === null ? 0 : item.lastAt);
  // Least recently touched first, for fairness.
  due.sort((a, b) => lastAt(a) - lastAt(b));
  freshKept.sort((a, b) => lastAt(a) - lastAt(b) || a.entry.mtimeMs - b.entry.mtimeMs);
  return { due: due.slice(0, MAX_SESSIONS_PER_PASS), fresh: freshKept, quiet, cooling, hookActive, hookStamps };
}

// Stores each hook stamp in its observation, in place; mtimeMs and size stay as the watcher last saw them, so lines past the
// hook's cursor keep the session changed. cursorAfter is a field every writer version keeps. → whether anything changed.
export function applyHookStamps(record, hookStamps) {
  let changed = false;
  for (const [id, at, cursorLine] of hookStamps) {
    const stored = record.sessions[id];
    if (!isPlain(stored)) continue;
    stored.hookSeenAt = at;
    stored.cursorAfter = cursorLine;
    changed = true;
  }
  return changed;
}

// Sessions that never showed hook activity (Agent Host) get their timeline and quota snapshot from the watcher, since not every hook fires there.
export function noHook(prior) {
  return prior == null || keptField(prior, 'hookSeenAt') === null;
}

// The session is routed to some of the account's workspaces, none of them `tenantId`; unknown and pending routes are not.
function routedElsewhere(runs, id, tenantId) {
  const routed = runs.find((run) => run.sessionRoutes != null);
  const route = routed == null ? null : routed.sessionRoutes.get(id);
  return route != null && route.tenantIds.length > 0 && route.tenantIds.indexOf(tenantId) === -1;
}

// [settlement key, session id] pairs one account's history pass settled: what each executed run settled, and the
// sessions a live workspace of the account has nothing to do for. executed: [{ run, result }]; tenantIds: the live ones.
export function historySettlements(accountKey, tenantIds, runs, executed, ids) {
  const pairs = [];
  for (const { run, result } of executed) {
    for (const id of result.settledIds) pairs.push([settlementKey(accountKey, run.tenantId), id]);
  }
  for (const tenantId of tenantIds) {
    for (const id of ids) {
      if (routedElsewhere(runs, id, tenantId)) pairs.push([settlementKey(accountKey, tenantId), id]);
    }
  }
  return pairs;
}

// The quiet sessions settled by every required recipient key; none when no key is required.
export function settledByAll(entries, requiredKeys, isSettledFor) {
  if (requiredKeys.length === 0) return [];
  return entries.filter((entry) => requiredKeys.every((key) => isSettledFor(key, entry)));
}

// For an established start, one audit run per lagging recipient, replaying the lines between its own prefix and
// the start into its own queue only (no state, no flush). start: establishStart's answer. → [{ recipient, options }]
export function laggingReplays(start, recipients) {
  if (start == null || !Array.isArray(start.lagging)) return [];
  const tenantOf = (s) => (s.tenantId == null ? null : s.tenantId);
  const out = [];
  for (const lag of start.lagging) {
    const recipient = recipients.find((r) => r.key === lag.key && tenantOf(r) === lag.tenantId);
    if (recipient == null) continue;
    out.push({ recipient, options: { persistState: false, startCursor: lag.startLine, endCursor: start.startLine, sessions: [recipient], skipFlush: true } });
  }
  return out;
}
