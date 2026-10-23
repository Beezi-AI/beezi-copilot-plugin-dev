import fs from 'fs';
import { listSessionFiles } from '../sources/cli/session-files.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { readEvents } from '../sources/cli/events.mjs';
import { findShutdowns } from '../sources/cli/event-types.mjs';
import { listVscodeSessions } from '../sources/vscode/session-files.mjs';
import { acquireLease } from '../platform/lease.mjs';
import { linkedSessions } from '../auth/recipients.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { isWatcherEnabled } from '../config/flags.mjs';
import { ELECTION_NAME, ELECTION_LEASE_MS, loadWatermark, saveWatermark, storeObservation, keptField, trimWatermark } from '../state/watcher-record.mjs';
import { planPass, applyHookStamps } from './watch-planner.mjs';
import { recipientsFor, liveRecipients, recipientCutoffs } from './watch-recipients.mjs';
import { runDuePath, runFreshPath, runHistoryPath, failStep, messageOf } from './watch-paths.mjs';
import { nextIdleSkip, shouldLogPass, summaryLine } from './watch-pacing.mjs';
import { maybeStartPendingHistory } from '../history/pending-trigger.mjs';
import { yieldToLoop } from '../core/async.mjs';

// MCP-server session watcher: session-agnostic (the process has no session id), every report comes from the checkpoint engine, and it never touches stdout (JSON-RPC): all output goes through `log`.

const TICK_MS = 20000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The scan stamp is written at least this often even when nothing else changed.
const STATUS_SAVE_MS = 60000;
// How much of the file end is read to tell whether a session.shutdown could be past the cursor.
const SHUTDOWN_PROBE_BYTES = 64 * 1024;
const SHUTDOWN_MARK = '"session.shutdown"';

// ── What a pass reads of the disk ──────────────────────────────────────────────────────────────

// VS Code Local-agent sessions as scan entries: no transcriptPath (nothing here reads VS Code's transcript), the chat file and folder instead.
function vscodeEntries(cliIds) {
  const out = [];
  for (const s of listVscodeSessions()) {
    if (!isUsableSessionId(s.sessionId) || cliIds.has(s.sessionId)) continue;
    out.push({ sessionId: s.sessionId, transcriptPath: null, file: s.file, folder: s.folder, mtimeMs: s.mtimeMs, size: s.size, kind: 'vscode' });
  }
  return out;
}

// Stat only, every root: the CLI sessions, then the VS Code ones the CLI does not already list.
function scanEntries() {
  const entries = listSessionFiles().filter((entry) => entry != null && isUsableSessionId(entry.sessionId));
  return entries.concat(vscodeEntries(new Set(entries.map((entry) => entry.sessionId))));
}

// What planning reads of a session: a VS Code one's cursor is its own (requests reported), its cwd the folder it was opened in.
function readStateFor(entry) {
  if (entry.kind !== 'vscode') return loadSessionState(entry.sessionId);
  const state = loadSessionState(entry.sessionId);
  const v = state.vscode;
  return { cursorLine: v == null ? null : v.cursor, cwd: entry.folder || (v == null ? null : v.cwd), updatedAt: state.updatedAt };
}

function tailContains(file, size, mark) {
  const length = Math.min(size, SHUTDOWN_PROBE_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8').indexOf(mark) !== -1;
}

// A CLI session's events.jsonl holds a session.shutdown past `cursorLine`: a cheap tail read first, the full read only on a hit.
export function shutdownPastCursor(entry, cursorLine) {
  if (entry.kind === 'vscode' || typeof entry.transcriptPath !== 'string') return false;
  try {
    if (!tailContains(entry.transcriptPath, entry.size, SHUTDOWN_MARK)) return false;
    return findShutdowns(readEvents(entry.transcriptPath, { fromLine: cursorLine }).events).length > 0;
  } catch {
    return false;
  }
}

// Lazy import keeps the housekeeping graph off the watcher's start-up path.
async function housekeeping() {
  const mod = await import('../pipeline/housekeeping.mjs');
  if (typeof mod.runHousekeeping !== 'function') return;
  await mod.runHousekeeping({ budgetMs: 10000, reason: 'watcher' });
}

// ── One pass ───────────────────────────────────────────────────────────────────────────────────

function startPass(ctx) {
  const nowMs = Date.now();
  const summary = { reason: null, checkpointed: 0, committed: 0, established: 0, deferred: 0, cooling: 0, hookActive: 0, errors: 0, history: 0 };
  return { ctx, nowMs, summary, record: loadWatermark(), dirty: false, sessions: [], entries: [], recipients: [], routeCtx: null };
}

function finishPass(pass, reason) {
  const { ctx, summary } = pass;
  summary.reason = reason;
  if (pass.dirty || Date.now() - ctx.savedAt >= STATUS_SAVE_MS) {
    saveWatermark(pass.record);
    ctx.savedAt = Date.now();
  }
  const line = summaryLine(summary);
  if (shouldLogPass(summary, line, ctx.lastLine)) ctx.say(line);
  ctx.lastLine = line;
  return summary;
}

// Plans the pass and records what planning learned: hook stamps and newly oversize sessions.
function planAndStamp(pass, live) {
  const { record, nowMs, recipients, routeCtx } = pass;
  const plan = planPass({
    entries: pass.entries, record, nowMs, readState: readStateFor, hasShutdownPast: shutdownPastCursor, attempts: pass.ctx.attempts,
    isExcluded: (item) => live && recipientsFor(item, recipients, routeCtx).length === 0,
  });
  pass.summary.cooling = plan.cooling;
  pass.summary.hookActive = plan.hookActive;
  if (applyHookStamps(record, plan.hookStamps)) pass.dirty = true;
  for (const entry of plan.oversizeNew) {
    pass.ctx.say(`watcher: ${entry.sessionId} events.jsonl over 64 MB — not captured by the watcher`);
    storeObservation(record, entry, { at: nowMs, cursorAfter: keptField(record.sessions[entry.sessionId], 'cursorAfter'), oversizeAt: nowMs });
    pass.dirty = true;
  }
  return plan;
}

// ctx: { say, alive(), renew(), reasons: Map, attempts: Map, savedAt, lastLine }. Never throws: each step has its own try/catch that counts an error.
async function runWatchPass(ctx) {
  const { alive, renew } = ctx;
  const pass = startPass(ctx);
  const { record } = pass;

  // 1. Housekeeping runs before the link check: an unlinked machine still accumulates state, and where SessionStart never fires this is the only housekeeping.
  if (record.housekeepingAt === null || pass.nowMs - record.housekeepingAt >= HOUSEKEEPING_INTERVAL_MS) {
    try { await housekeeping(); } catch (error) { failStep(pass, 'housekeeping', error); }
    record.housekeepingAt = Date.now();
    pass.dirty = true;
    if (!alive()) return finishPass(pass, 'stopped');
  }

  // 2. Link check. Silent when nothing is linked: the MCP server must not be disturbed by a machine that is not signed in.
  let sessions = [];
  try { sessions = await linkedSessions(); } catch { sessions = []; }
  if (!Array.isArray(sessions) || sessions.length === 0) return finishPass(pass, 'unlinked');
  if (!alive()) return finishPass(pass, 'stopped');
  pass.sessions = sessions;

  // 3. Scan.
  try { pass.entries = scanEntries(); } catch (error) {
    failStep(pass, 'scan', error);
    return finishPass(pass, 'scan-failed');
  }
  record.lastScanAt = Date.now();
  await yieldToLoop();
  if (!renew()) return finishPass(pass, 'lost');

  // 4. Plan. Live capture (paths A and B) only when some linked account still allows it.
  pass.recipients = liveRecipients(sessions);
  pass.cutoffs = recipientCutoffs(pass.recipients);
  const live = pass.recipients.length > 0;
  pass.routeCtx = createRouteContext();
  const plan = planAndStamp(pass, live);

  // 5. The three paths, each ending the pass early when the watcher stopped or lost the election.
  let stop = live ? await runDuePath(pass, plan.due) : null;
  if (stop == null && live && plan.fresh.length > 0) stop = await runFreshPath(pass, plan.fresh);
  if (stop == null && live && plan.quiet.length > 0 && alive()) stop = await runHistoryPath(pass, plan.quiet);
  if (stop != null) return finishPass(pass, stop);

  // An accepted past-sessions upload still owed: due accounts get the detached history worker, so the tick stays short.
  if (alive()) await maybeStartPendingHistory();

  if (trimWatermark(record, new Set(pass.entries.map((entry) => entry.sessionId)))) pass.dirty = true;
  return finishPass(pass, null);
}

// ── The loop ───────────────────────────────────────────────────────────────────────────────────

// The watcher-election lease. Two windows elect one watcher; a transient double holder is safe because the engine serializes per session.
function createElection(isStopped) {
  let lease = null;
  // Renewed at the top of each tick and between phases of a long pass. A lost lease drops the handle so the rest of the pass stops.
  function renew() {
    if (isStopped() || lease == null) return false;
    const renewed = lease.renew();
    if (renewed.ok) return true;
    if (renewed.reason === 'lost') lease = null;
    return renewed.reason !== 'lost';
  }
  function take() {
    if (lease == null) {
      lease = acquireLease(ELECTION_NAME, { leaseMs: ELECTION_LEASE_MS });
      return lease != null;
    }
    return renew();
  }
  function release() {
    const held = lease;
    lease = null;
    if (held != null) held.release();
  }
  return { held: () => lease != null, renew, take, release };
}

// → stop(): idempotent and synchronous; a disabled watcher touches no file, lock or timer.
export function startWatcher({ log } = {}) {
  if (!isWatcherEnabled(process.env)) return function stop() {};
  const say = (line) => {
    try { if (typeof log === 'function') log(String(line)); } catch { /* the log is best-effort */ }
  };
  let stopped = false;
  let running = false;
  let timer = null;
  const election = createElection(() => stopped);
  const ctx = {
    say, reasons: new Map(), attempts: new Map(), savedAt: 0, lastLine: null,
    alive: () => !stopped && election.held(), renew: () => election.renew(),
  };
  // Ticks left to skip before the next pass; every tick still renews the lease, so its 90 s protocol is unchanged.
  let idleSkip = 0;
  let skipLeft = 0;

  function schedule() {
    if (stopped) return;
    // Cleared by stop() and never unref'd, so the caller must stop() on stdin close or the timer keeps an orphaned MCP process alive.
    timer = setTimeout(() => {
      timer = null;
      tick().catch(() => {});
    }, TICK_MS);
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      // Another elected MCP process owns the work; skip quietly.
      if (!election.take()) return;
      if (skipLeft > 0) { skipLeft -= 1; return; }
      idleSkip = nextIdleSkip(idleSkip, await runWatchPass(ctx));
      skipLeft = idleSkip;
    } catch (error) {
      say(`watcher pass failed: ${messageOf(error)}`);
      try {
        recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.WATCHER, error });
      } catch { /* consent-gated and best-effort */ }
    } finally {
      running = false;
      schedule();
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    // An in-flight pass is not awaited: every await point re-checks alive().
    election.release();
  }

  schedule();
  return stop;
}
