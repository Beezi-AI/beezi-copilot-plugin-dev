// The Copilot CLI checkpoint: the named steps from hook input to a committed cursor, and the driver that runs them.
import fs from 'fs';
import { git } from '../repo/git.mjs';
import { createRepoContext } from '../repo/repo-context.mjs';
import { isDirectory } from '../repo/repo-root.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { copilotSessionFile } from '../config/copilot-paths.mjs';
import { recordIssue, rememberHostVersion } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { MAX_TRANSCRIPT_BYTES } from '../contract/report-limits.mjs';
import { validError } from '../delivery/session-errors.mjs';
import { EVENT_TYPES, sessionStartOf } from '../sources/cli/event-types.mjs';
import { readEvents } from '../sources/cli/events.mjs';
import { findSessionFile, readSessionHead } from '../sources/cli/session-files.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { buildSegments } from '../capture/segments.mjs';
import { attributeRows } from '../capture/attribute-rows.mjs';
import { hasActivity } from '../capture/attribute-shutdowns.mjs';
import { buildAutoTimeline } from '../capture/auto-selection.mjs';
import { locateCursor } from '../capture/cursor.mjs';
import { PER_CALL_ENABLED, rowHorizonMs } from '../capture/usage-mode.mjs';
import { planDelivery } from './delivery-plan.mjs';
import { emitSegments } from './collect-inputs.mjs';
import { billSessionTotals, chooseUsage, rowsReader } from './cli-usage.mjs';
import { readSessionOrigin } from './session-origin.mjs';
import { commitCursor } from './cursor-commit.mjs';
import { bindAccount, establishFromServer, loadRunState, parkHookErrors, replayName, runTail, snapshotBilling } from './checkpoint-steps.mjs';
import { acquireRunLock, budgetClock, budgetOf, CONTINUE, createLockHolder, finish, guardRun, newRunResult, runSteps, stopRun } from './run-skeleton.mjs';
import { isPlain, str } from '../core/guards.mjs';

const SESSION_ERROR = 'session.error';
const FINALIZE_IDLE_MS = 5 * 60 * 1000;
// The hooks a session fires itself: only these run in its own Copilot process, whose env names its account.
const OWN_HOOK_TRIGGERS = ['stop', 'git', 'pulse', 'precompact', 'session-end', 'error'];

// A live run fired by one of the session's own hooks: the only process whose env describes the session.
function ownProcess(ctx) {
  return ctx.live && OWN_HOOK_TRIGGERS.indexOf(ctx.trigger) !== -1;
}

function isFile(p) {
  try { return typeof p === 'string' && p !== '' && fs.statSync(p).isFile(); } catch { return false; }
}

function isOversize(p) {
  try { return fs.statSync(p).size > MAX_TRANSCRIPT_BYTES; } catch { return false; }
}

// The Copilot version on the newest session.start: the closest record of the host that is running now.
function hostVersionOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === EVENT_TYPES.SESSION_START) return str(events[i].data.copilotVersion);
  }
  return null;
}

// A file holding an earlier run of its own past `fromLine` (a fork's copied lines are its parent's): a resume, or two starts.
function hasPriorRun(events, fromLine) {
  let starts = 0;
  for (const e of events) {
    if (e.line <= fromLine) continue;
    if (e.type === EVENT_TYPES.SESSION_RESUME) return true;
    if (e.type === EVENT_TYPES.SESSION_START) starts += 1;
  }
  return starts > 1;
}

// True when a shutdown follows the last start or resume.
function lastRunFinished(events) {
  let last = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === EVENT_TYPES.SESSION_START || events[i].type === EVENT_TYPES.SESSION_RESUME) last = i;
  }
  for (let i = last + 1; i < events.length; i++) if (events[i].type === EVENT_TYPES.SESSION_SHUTDOWN) return true;
  return false;
}

// The file's own activity first, then any per-call row from the start of the store; an unavailable store counts as none.
async function sessionHasActivity(ctx, events) {
  if (hasActivity(events)) return true;
  if (!PER_CALL_ENABLED) return false;
  const store = await rowsReader(ctx)(ctx.sessionId, { afterRowId: 0, limit: 1 });
  return store.available && store.rows.length > 0;
}

// Main-stream session.error events past `fromLine`: what an activity-free session still has to deliver.
function errorsPast(events, fromLine) {
  return events.filter((e) => e.type === SESSION_ERROR && e.agentId == null && e.line > fromLine);
}

// Activity, or an error to deliver: the one test before binding a session and before reading its window.
async function worthReading(ctx, events) {
  return errorsPast(events, 0).length > 0 || sessionHasActivity(ctx, events);
}

// Step 1: input. Session-id invariant: nothing below builds a path from an id that failed this check.
function readInput(ctx) {
  const inp = ctx.input != null && typeof ctx.input === 'object' ? ctx.input : {};
  ctx.sessionId = inp.sessionId != null ? inp.sessionId : inp.session_id;
  ctx.transcriptHint = inp.transcriptPath != null ? inp.transcriptPath : inp.transcript_path;
  ctx.hookCwd = str(inp.cwd);
  ctx.budgetMs = budgetOf(inp.budgetMs);
  ctx.hookErrors = Array.isArray(inp.hookErrors) ? inp.hookErrors.filter(validError) : [];
  ctx.withTimeline = inp.withTimeline === true || ctx.options.emitTimeline === true;
  ctx.withQuota = inp.withQuota === true;
  ctx.trigger = str(inp.trigger);
  ctx.live = ctx.options.persistState !== false;
  ctx.clock = budgetClock(ctx.budgetMs);
  ctx.cwd = ctx.hookCwd;
  return isUsableSessionId(ctx.sessionId) ? CONTINUE : stopRun('failed', 'unnamed-session', false);
}

// Step 2: the transcript, first that is a file, and its head's cwd read at most once.
function locateTranscript(ctx) {
  let transcript = null;
  for (const candidate of [ctx.transcriptHint, copilotSessionFile(ctx.sessionId)]) {
    if (isFile(candidate)) { transcript = candidate; break; }
  }
  if (transcript == null) {
    const found = findSessionFile(ctx.sessionId);
    if (found != null && isFile(found.transcriptPath)) transcript = found.transcriptPath;
  }
  ctx.transcript = transcript;
  // One read serves the binding gate and the window when the gate runs; otherwise the window reads under the lock.
  // A transcript over the cap is never parsed on a hook (null): the watcher and history skip it the same way.
  let read;
  ctx.readOnce = () => {
    if (read === undefined) read = transcript == null || isOversize(transcript) ? null : readEvents(transcript);
    return read;
  };
  let head;
  ctx.headCwd = () => {
    if (head === undefined) head = transcript == null ? null : readSessionHead(transcript);
    return head == null ? null : str(head.cwd);
  };
  return CONTINUE;
}

// Step 3: recipients, workspace fan-out and gating.
async function planRecipients(ctx) {
  const { sessionId, transcript } = ctx;
  const delivery = await planDelivery(sessionId, {
    deps: ctx.deps,
    options: ctx.options,
    bindCwd: () => (ctx.hookCwd == null ? ctx.headCwd() : ctx.hookCwd),
    // The binding is written per session, so a session with no activity yet stops here like the gate below.
    beforeBind: async () => {
      const early = ctx.readOnce();
      return !(early != null && !early.unreadable && !(await worthReading(ctx, early.events)));
    },
  });
  if (delivery.stop != null) {
    if (delivery.stop === 'tracking-gated') ctx.out.gated = true;
    return stopRun('deferred', delivery.stop, false);
  }
  ctx.delivery = delivery;
  return CONTINUE;
}

// Thousands of git calls in a long audit must not outlast the lock's stale limit.
function openRepos(ctx) {
  ctx.repo = createRepoContext(ctx.gitImpl, () => ctx.keepLock());
  return CONTINUE;
}

function requireTranscript(ctx) {
  return ctx.transcript == null ? stopRun('failed', 'no-transcript', true) : CONTINUE;
}

// Step 4: park hook errors, then take the session lock.
async function parkAndLock(ctx) {
  parkHookErrors(ctx);
  const keepLock = await acquireRunLock(ctx.lock, ctx.sessionId, ctx.budgetMs);
  if (keepLock == null) return stopRun('deferred', 'session-busy', false);
  ctx.keepLock = keepLock;
  return CONTINUE;
}

// An activity-free session's undelivered errors become the tail's window; → whether there are any.
function takeErrorWindow(ctx) {
  ctx.state = loadRunState(ctx.sessionId, ctx.live);
  const { cursorLine, errorCursorLine } = ctx.state;
  ctx.windowEvents = errorsPast(ctx.events, Math.max(errorCursorLine, cursorLine == null ? 0 : cursorLine));
  ctx.errorOnly = ctx.windowEvents.length > 0;
  return ctx.errorOnly;
}

// A file that could not be read looks empty, and an empty file must not be taken for a rewound cursor.
async function readTranscript(ctx) {
  const read = ctx.readOnce();
  if (read == null) return stopRun('deferred', 'transcript-oversize', true);
  if (read.unreadable) return stopRun('failed', 'no-transcript', true);
  ctx.events = read.events;
  // A lagging recipient's replay ends at the line the other recipients start from.
  const end = ctx.options.endCursor;
  ctx.capped = Number.isInteger(end) && end >= 0 && end < read.lastCompleteLine;
  ctx.toLine = ctx.capped ? end : read.lastCompleteLine;
  ctx.runFinished = lastRunFinished(ctx.events.filter((e) => e.line <= ctx.toLine));
  if (await sessionHasActivity(ctx, ctx.events)) return CONTINUE;
  // No cursor, usage state, timeline or segments until the file shows activity; only errors run the tail.
  return stopRun('deferred', 'no-activity', takeErrorWindow(ctx));
}

// The session's origin once per run: app facts, fork boundary, detached parent, creating surface, start and BYOK.
async function readOrigin(ctx) {
  ctx.origin = await readSessionOrigin(ctx.sessionId, ctx.events, ctx.transcript, { ownProcess: ownProcess(ctx), env: process.env });
  ctx.forkLine = ctx.origin.forkLine;
  ctx.billing.at = ctx.origin.startedAtMs;
  ctx.billing.byok = ctx.origin.byok;
  return CONTINUE;
}

// The session's state, its account and billing binding, the running host version and the cwd.
async function loadSession(ctx) {
  const { sessionId, events, live } = ctx;
  ctx.state = loadRunState(sessionId, live);
  // A live run resolves an unbound session's account; an audit keeps the saved binding, else the machine's.
  await bindAccount(ctx, live ? {
    surface: ctx.origin.surface.source, events, transcriptPath: ctx.transcript,
    ownProcess: ownProcess(ctx), env: process.env,
  } : null);
  const start = sessionStartOf(events);
  // Only a live run knows the host that is running now; an audit replays sessions from any past version.
  const version = live ? hostVersionOf(events) : null;
  if (version != null) { try { rememberHostVersion(version); } catch { /* best-effort */ } }
  ctx.cwd = ctx.hookCwd
    || (start != null && isPlain(start.data.context) ? str(start.data.context.cwd) : null)
    || ctx.headCwd();
  return CONTINUE;
}

// Step 5: cursor check and establishment.
async function placeCursor(ctx) {
  const { options, state, events, toLine, live, forkLine } = ctx;
  const requested = Number.isInteger(options.startCursor) && options.startCursor >= 0 ? options.startCursor : null;
  // Without a stored cursor a run never starts inside the lines a fork copied from its parent.
  let cursor = Math.max(requested == null ? 0 : requested, forkLine);
  if (live && state.cursorLine == null && requested == null && hasPriorRun(events, forkLine)) {
    const startLine = await establishFromServer(ctx);
    if (startLine == null) return stopRun('deferred', 'unestablished', true);
    cursor = Math.max(startLine, forkLine);
  } else if (live && state.cursorLine != null) {
    // The persisted cursor, relocated by its event ids when the line no longer holds that event.
    const located = locateCursor(events, state, toLine);
    if (located.note != null) ctx.errors.push(located.note);
    // No surviving anchor at all: the file was replaced, not just trimmed. Counted once, since the next save re-anchors.
    if (located.note === 'cursor-reset') recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
    cursor = requested == null ? located.cursor : Math.max(requested, located.cursor);
  }
  // The hold keeps the cursor and emits nothing; only a live session reports it (an audit reads a fixed range).
  if (cursor > toLine) {
    ctx.out.skipped.cursorMismatch = true;
    if (live) recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
    return stopRun('deferred', 'cursor-mismatch', true);
  }
  ctx.cursor = cursor;
  return CONTINUE;
}

// Per-call store rows onto the window's works; sets lastRowId and the next per-stream call memory.
function attributeWindowRows(ctx) {
  const { events, cursor, live, state, works } = ctx;
  const horizonMs = rowHorizonMs(events, ctx.toLine, ctx.capped);
  let idle = false;
  try { idle = Date.now() - fs.statSync(ctx.transcript).mtimeMs > FINALIZE_IDLE_MS; } catch { /* keep live */ }
  // A capped run never finalizes: rows past its horizon or without a stamp belong to the run that starts at its cap.
  const finalize = !ctx.capped && (ctx.runFinished || idle);
  // A cursor first taken from the server (no local one) may sit past lines already billed elsewhere, so their rows are skipped.
  const allowLate = live && !(state.cursorLine == null && cursor > 0);
  // Without the timeline the Auto slice is simply unmeasured.
  let autoPoints = null;
  try { autoPoints = buildAutoTimeline(events); } catch { ctx.errors.push('collector:auto-selection'); }
  const attributed = attributeRows(works, ctx.store.rows, events, {
    horizonMs, finalize, allowLate, windowFromLine: cursor, windowToLine: ctx.toLine,
    floorMs: ctx.rowFloorMs == null ? -Infinity : ctx.rowFloorMs,
    autoPoints,
    // An audit replays from empty state and never saves it, so it under-counts instead of double-counting.
    lastCalls: live ? state.lastCalls : {},
  });
  if (attributed.coldFailed) {
    ctx.errors.push('collector:cold-prefix');
    // Partial counters would ship as measured values.
    for (const w of works) w.cold = null;
  }
  ctx.lastRowId = attributed.lastRowId;
  ctx.nextCalls = live ? attributed.lastCalls : null;
}

// Step 8: segments and tokens.
function buildWorks(ctx) {
  const { events, repo } = ctx;
  try {
    ctx.works = buildSegments(events, {
      sessionId: ctx.sessionId, fromLine: ctx.cursor, toLine: ctx.toLine, cwd: ctx.cwd,
      repoRootOf: repo.repoRootOf, branchAt: repo.branchAt, headBranchOf: repo.headBranchOf, isDirectory,
    });
    if (ctx.usage.useRows) {
      attributeWindowRows(ctx);
    } else if (ctx.usage.useTotals) {
      billSessionTotals(ctx);
    }
  } catch (error) {
    ctx.out.skipped.deltaFailed = true;
    // An audit replays old files on demand; only the live stream's failures say anything about the plugin's health.
    if (ctx.live) recordIssue({ code: DIAGNOSTIC_CODES.TRANSCRIPT_PARSE_FAILED, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
    return stopRun('failed', 'delta-failed', true);
  }
  return CONTINUE;
}

function checkBudget(ctx) {
  const left = ctx.clock.timeLeft();
  if (left == null || left > 0) return CONTINUE;
  ctx.errors.push('budget');
  return stopRun('deferred', 'budget', true);
}

// Steps 1-11 in order; Step 11 replays the last report when only the session name changed.
const STEPS = [
  readInput, locateTranscript, planRecipients, snapshotBilling, openRepos, requireTranscript, parkAndLock, readTranscript,
  readOrigin, loadSession, placeCursor, chooseUsage, buildWorks, checkBudget, emitSegments, commitCursor, replayName,
];

// Everything a step reads or sets; the tail reads what the steps got to before they stopped.
function newContext(input, deps, options, out) {
  return {
    input, deps, options, out, errors: out.errors,
    gitImpl: deps.gitImpl == null ? git : deps.gitImpl,
    fetchImpl: deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl,
    lock: createLockHolder(), keepLock: () => {},
    billing: { fields: {}, identity: {}, config: null, at: null, byok: null },
    // The engine a lagging recipient's replay runs on, and the lines a fork copied (0: none).
    engine: runCheckpoint, origin: null, forkLine: 0, lagging: [], sessionIdentity: null,
    state: null, events: [], windowEvents: [], consumed: false, sessionName: null, namePatch: null,
    billed: [], lastRowId: null, nextCalls: null, covered: null, lastPayload: null, subagentInfo: {},
    nextCheckpoint: null, runFinished: false, capped: false, errorOnly: false,
  };
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Never rejects. One per-session lock covers read → enqueue → cursor save; the queue file is on disk
// before the cursor is saved, so a kill in between re-emits identical segmentIds.
// `options.sessions` overrides the linked-account lookup; `sink`, `skipFlush`, `collectSessionErrors` and
// persistState:false redirect the audit's side effects; `startCursor` replaces the local read position and `endCursor`
// caps the last line read.
// A stop with tail:false returns at once; every other end runs the tail (errors, timeline, quota, second patch, flush).
export async function runCheckpoint(input, deps = {}, options = {}) {
  const out = newRunResult();
  const ctx = newContext(input, deps, options, out);
  return guardRun(out, ctx.lock, async () => {
    const stop = await runSteps(STEPS, ctx);
    if (stop == null) finish(out, 'committed', null);
    else finish(out, stop.outcome, stop.reason);
    if (stop == null || stop.tail) await runTail(ctx);
  });
}
