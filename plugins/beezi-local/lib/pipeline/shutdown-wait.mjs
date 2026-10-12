// The SessionEnd wait: one guarded worker per session follows the transcript for the late session.shutdown and bills it.
import fs from 'fs';
import { runCheckpoint as _runCheckpoint } from './cli-checkpoint.mjs';
import { copilotSessionFile } from '../config/copilot-paths.mjs';
import { EVENT_TYPES, parseEventLine } from '../sources/cli/event-types.mjs';
import { shutdownKey } from '../capture/attribute-shutdowns.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { sleep as _sleep } from '../core/async.mjs';
import { acquireShutdownGuard } from './shutdown-guard.mjs';

const POLL_MS = 2000;
// Copilot has been seen writing the shutdown about ten minutes after SessionEnd; each later SessionEnd restarts the wait.
const WAIT_MS = 12 * 60 * 1000;
// Long enough for an older worker to finish a poll and step aside.
const GUARD_WAIT_MS = 3 * POLL_MS;
const NEWLINE = 0x0a;
const SESSION_END_HOOK = 'sessionEnd';

function transcriptOf(sessionId, state) {
  for (const candidate of [state.transcriptPath, copilotSessionFile(sessionId)]) {
    try { if (candidate && fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

// The main-stream records the wait decides on: shutdowns, run starts and SessionEnd hook starts.
function isMarker(e) {
  if (e.agentId != null) return false;
  if (e.type === EVENT_TYPES.SESSION_SHUTDOWN || e.type === EVENT_TYPES.SESSION_START || e.type === EVENT_TYPES.SESSION_RESUME) return true;
  return e.type === 'hook.start' && e.data.hookType === SESSION_END_HOOK;
}

// Reads only the bytes appended since the last read. read() → the new marker events, or null when the file shrank
// (rewritten); lines() → the complete lines read so far.
export function createTailReader(file) {
  let offset = 0;
  let line = 0;
  let carry = Buffer.alloc(0);
  function read() {
    let size;
    try { size = fs.statSync(file).size; } catch { return []; }
    if (size < offset) return null;
    if (size === offset) return [];
    const chunk = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, chunk, 0, chunk.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const bytes = Buffer.concat([carry, chunk]);
    const markers = [];
    let start = 0;
    for (let i = bytes.indexOf(NEWLINE); i !== -1; i = bytes.indexOf(NEWLINE, start)) {
      line += 1;
      const event = parseEventLine(bytes.slice(start, i).toString('utf8'), line);
      if (event != null && isMarker(event)) markers.push(event);
      start = i + 1;
    }
    carry = bytes.slice(start);
    return markers;
  }
  return { read, lines: () => line };
}

// The wait's view of the file: markers so far, the line count at the first read (baseLine) and where this run started.
function createView(file) {
  const reader = createTailReader(file);
  const markers = reader.read() || [];
  let runStart = 0;
  // This run starts at the last main-stream start or resume, so a shutdown written before the first poll still counts as its own.
  for (const e of markers) if (e.type === EVENT_TYPES.SESSION_START || e.type === EVENT_TYPES.SESSION_RESUME) runStart = e.line;
  return { read: reader.read, markers, runStart, baseLine: reader.lines(), file };
}

// → { kind: 'bill', line } for an unbilled shutdown past the cursor hint clamped to the run start, { kind: 'done' } when this
// run's is billed, { kind: 'resumed' } when a later run starts; plus sessionEnd, the newest later SessionEnd hook line or null.
export function scanMarkers(markers, state, baseLine, runStart) {
  const cursor = state.cursorLine == null ? 0 : state.cursorLine;
  const from = Math.min(cursor, runStart);
  const billed = new Set(state.reportedShutdownLines.map(shutdownKey));
  let sessionEnd = null;
  for (const e of markers) {
    if (e.line <= from) continue;
    if (e.type === EVENT_TYPES.SESSION_SHUTDOWN) {
      if (!billed.has(shutdownKey(e))) return { kind: 'bill', line: e.line, sessionEnd };
      if (e.line > runStart) return { kind: 'done', sessionEnd };
    } else if (e.line > baseLine && e.type !== 'hook.start') {
      return { kind: 'resumed', sessionEnd };
    } else if (e.line > baseLine) {
      sessionEnd = e.line;
    }
  }
  return { kind: null, sessionEnd };
}

// Bills a found shutdown; → true when the wait goes on (a billed leftover of an earlier run, or a busy lock).
async function bill(sessionId, transcript, found, w, runCheckpoint) {
  const out = await runCheckpoint({ sessionId, transcriptPath: transcript, trigger: 'session-end-late', budgetMs: 15000, withTimeline: true });
  // A billed leftover from an earlier run keeps the wait for this run's shutdown; the same leftover twice means it will not bill.
  const billedLeftover = out.outcome === 'committed' && found.line <= w.view.runStart && found.line !== w.leftover;
  if (billedLeftover) w.leftover = found.line;
  // Otherwise only a held lock is retried; the holder may bill it first, which the next pass sees in the state.
  return billedLeftover || out.reason === 'session-busy';
}

// One poll: reads what was appended and acts on it; → false when the wait is over.
async function poll(sessionId, w, deps) {
  const state = loadSessionState(sessionId);
  const transcript = transcriptOf(sessionId, state);
  if (transcript == null) return true;
  if (w.view == null || w.view.file !== transcript) w.view = createView(transcript);
  const more = w.view.read();
  if (more == null) {
    w.view = null;
    return true;
  }
  for (const e of more) w.view.markers.push(e);
  const found = scanMarkers(w.view.markers, state, w.view.baseLine, w.view.runStart);
  // A later SessionEnd (the app fires one per turn) starts the wait over instead of spawning a second worker.
  if (found.sessionEnd != null && found.sessionEnd > w.view.baseLine) {
    w.view.baseLine = found.sessionEnd;
    w.deadline = deps.now() + WAIT_MS;
  }
  if (found.kind === 'resumed' || found.kind === 'done') return false;
  if (found.kind === 'bill') return bill(sessionId, transcript, found, w, deps.runCheckpoint);
  return true;
}

async function watch(sessionId, guard, deps) {
  const w = { deadline: deps.now() + WAIT_MS, view: null, leftover: null };
  while (deps.now() < w.deadline) {
    guard.touch();
    if (!(await poll(sessionId, w, deps))) return;
    await deps.sleep(POLL_MS);
  }
  // One last look after the deadline: a shutdown written during the final sleep is still billed.
  guard.touch();
  await poll(sessionId, w, deps);
}

// Waits under the session's guard; returns at once when another worker holds it. deps: { runCheckpoint, sleep, now } seams.
export async function runShutdownWait(sessionId, deps = {}) {
  const run = {
    runCheckpoint: deps.runCheckpoint == null ? _runCheckpoint : deps.runCheckpoint,
    sleep: deps.sleep == null ? _sleep : deps.sleep,
    now: deps.now == null ? Date.now : deps.now,
  };
  const guard = await acquireShutdownGuard(sessionId, { waitMs: GUARD_WAIT_MS, pollMs: POLL_MS });
  if (guard == null) return;
  try {
    await watch(sessionId, guard, run);
  } finally {
    guard.release();
  }
}
