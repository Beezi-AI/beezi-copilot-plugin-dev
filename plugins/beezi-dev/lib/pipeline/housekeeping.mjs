// Machine upkeep shared by SessionStart and the watcher: prune, repo-map pre-warm and self-heal, check-in, queue flush.
import fs from 'fs';
import path from 'path';
import { flushQueue } from '../delivery/queue-flush.mjs';
import { git as _git, resolveOriginRemote } from '../repo/git.mjs';
import { resolveRepoRoot } from '../repo/repo-root.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from '../repo/repo-map.mjs';
import { stateDir } from '../config/paths.mjs';
import { pruneStale } from '../state/prune.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { listAccounts } from '../accounts/index-store.mjs';
import { linkedSessions } from '../auth/recipients.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { reconcileBillingConfig, ReconcileOutcome } from '../billing/plan-reconcile.mjs';
import { readVscodeEntitlements } from '../sources/vscode/entitlement.mjs';
import { syncAccountIfNeeded } from '../billing/account-sync.mjs';
import { pruneStatuslineSnapshots } from '../state/statusline-snapshot.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { listSessionFiles } from '../sources/cli/session-files.mjs';

const HOUSEKEEPING_BUDGET_MS = 10000;
// Catch-up: a few sessions per run, written in the last two days but not in the last two minutes (a live hook's).
const CATCH_UP_MAX = 3;
const CATCH_UP_QUIET_MS = 2 * 60 * 1000;
const CATCH_UP_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const CATCH_UP_RUN_BUDGET_MS = 4000;

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs == null ? fs : deps.fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin == null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      const childRoot = resolveRepoRoot(gitImpl, child, cache, map);
      recordRoot(childRoot == null ? child : childRoot);
    }
  }
  return { map, dirty };
}

// Resolves after `ms` (unref'd, so it never holds a process open); `cancel` drops it.
export function deadlineTimer(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function countEntries(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

// Every linked account's key, whatever its status: a queue left by a dead login is swept too.
async function allAccountKeys() {
  try { return (await listAccounts()).map((row) => row.key); } catch { return []; }
}

// Prune, then the repo-map pre-warm and self-heal (`cwd` names the session's repo discovery; the watcher has none).
// Returns the number of entries removed. Never throws.
export function localMaintenance({ cwd = null, gitImpl = _git, accountKeys = [] } = {}) {
  const before = countEntries(stateDir());
  try { pruneStale({ accountKeys }); } catch { /* best-effort */ }
  let removed = Math.max(0, before - countEntries(stateDir()));
  try { removed += pruneStatuslineSnapshots(); } catch { /* best-effort */ }
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(cwd, gitImpl, map);
    const dropped = pruneRepoMap(map);
    if (dirty || dropped > 0) saveRepoMap(map);
  } catch { /* best-effort */ }
  return removed;
}

// A reconcile that switched identity or captured a plan forces the check-in: the only moment the portal can learn about it.
const forcedOutcome = (outcome) => outcome === ReconcileOutcome.IDENTITY_CHANGED || outcome === ReconcileOutcome.CAPTURED;

// Fire-and-forget check-ins: each returns a promise that cannot reject.
export function checkIn(sessions, { config, outcome, via, fetchImpl }) {
  const deps = { fetchImpl, readBillingConfig: () => config };
  return sessions.map((session) => Promise.resolve()
    .then(() => syncAccountIfNeeded(session, { force: forcedOutcome(outcome), via }, deps))
    .catch(() => null));
}

// What the watcher (and SessionStart) run to keep the machine tidy: prune, repo-map self-heal, billing reconcile,
// account check-in and a queue flush for every linked account. Never throws and never prints (its caller may
// be the MCP server, whose stdout is JSON-RPC). Returns { flushed, pruned }.
export async function runHousekeeping({ budgetMs = HOUSEKEEPING_BUDGET_MS, reason = 'watcher', cwd = null, fetchImpl, gitImpl } = {}) {
  const out = { flushed: 0, pruned: 0 };
  let timer = null;
  try {
    const fetchFn = fetchImpl == null ? resolveFetch() : fetchImpl;
    const deadline = Date.now() + budgetMs;
    const work = (async () => {
      out.pruned = localMaintenance({ cwd, gitImpl, accountKeys: await allAccountKeys() });
      // VS Code's own entitlement names its plan where the CLI probe cannot.
      const reconciled = reconcileBillingConfig({ config: readBillingConfig(), entitlements: await readVscodeEntitlements() });
      const sessions = await linkedSessions().catch(() => []);
      const results = await Promise.all([
        ...sessions.map((s) => flushQueue(s, { fetchImpl: fetchFn, deadline }).catch(() => null)),
        ...checkIn(sessions, { config: reconciled.config, outcome: reconciled.outcome, via: reason, fetchImpl: fetchFn }),
      ]);
      for (const r of results) if (r != null && typeof r.flushed === 'number') out.flushed += r.flushed;
    })();
    timer = deadlineTimer(budgetMs);
    await Promise.race([work.catch(() => {}), timer.promise]);
  } catch { /* housekeeping is best-effort */ } finally {
    if (timer != null) timer.cancel();
  }
  return out;
}

function inCatchUpWindow(entry, nowMs) {
  const age = nowMs - entry.mtimeMs;
  return age >= CATCH_UP_QUIET_MS && age <= CATCH_UP_WINDOW_MS;
}

// A reported CLI session (local cursor set) whose file moved on after its last save; sessions never established are left
// to the watcher's history path and sync. An owed shutdown alone is not behind: it appends to the file when it comes.
export function isBehind(state, entry) {
  if (state.cursorLine == null) return false;
  const savedMs = state.updatedAt == null ? NaN : Date.parse(state.updatedAt);
  return Number.isFinite(savedMs) && entry.mtimeMs > savedMs;
}

// Up to CATCH_UP_MAX behind sessions, those owing a shutdown first, then the most recently written. entries: listSessionFiles rows.
export function catchUpCandidates(entries, { loadState = loadSessionState, nowMs = Date.now(), excludeSessionId = null } = {}) {
  const behind = [];
  for (const entry of entries) {
    if (entry.sessionId === excludeSessionId || !inCatchUpWindow(entry, nowMs)) continue;
    const state = loadState(entry.sessionId);
    if (isBehind(state, entry)) behind.push({ entry, pending: state.pendingShutdown });
  }
  behind.sort((a, b) => (a.pending === b.pending ? b.entry.mtimeMs - a.entry.mtimeMs : (a.pending ? -1 : 1)));
  return behind.slice(0, CATCH_UP_MAX).map((b) => b.entry);
}

// One checkpoint per candidate, one at a time inside budgetMs; runCheckpoint is the CLI engine, passed in so this module
// stays off the hook's import graph. Never throws; → the sessions it ran.
export async function catchUpSessions({ runCheckpoint, budgetMs = HOUSEKEEPING_BUDGET_MS, excludeSessionId = null, entries = null } = {}) {
  const deadline = Date.now() + budgetMs;
  const ran = [];
  try {
    const list = entries == null ? listSessionFiles() : entries;
    for (const entry of catchUpCandidates(list, { excludeSessionId })) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await runCheckpoint({
        sessionId: entry.sessionId, transcriptPath: entry.transcriptPath, trigger: 'catch-up',
        budgetMs: Math.min(left, CATCH_UP_RUN_BUDGET_MS), withTimeline: true,
      });
      ran.push(entry.sessionId);
    }
  } catch { /* best-effort */ }
  return ran;
}
