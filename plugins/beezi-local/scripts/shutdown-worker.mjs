import fs from 'fs';
import path from 'path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { copilotSessionFile } from '../lib/copilot-paths.mjs';
import { isWinTransient } from '../lib/fs-store.mjs';
import { readEvents, EVENT_TYPES } from '../lib/copilot-events.mjs';
import { shutdownKey } from '../lib/delta-copilot.mjs';
import { stateDir } from '../lib/paths.mjs';
import { isUsableSessionId, loadSessionState, SESSION_LOCK_STALE_MS } from '../lib/session-state.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached from SessionEnd: waits for the session.shutdown Copilot writes after that hook and bills it; argv is the session id only, prints nothing.
const POLL_MS = 2000;
// Copilot has been seen writing the shutdown about ten minutes after SessionEnd.
const WAIT_MS = 12 * 60 * 1000;
// Long enough for an older worker to see the new run start and step aside.
const GUARD_WAIT_MS = 3 * POLL_MS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One worker per session, a mkdir guard apart from <sid>.lock, touched every poll so a dead holder goes stale.
async function acquireGuard(sessionId) {
  const dir = path.join(stateDir(), `${sessionId}.shutdown-worker.lock`);
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { return null; }
  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      // A win32 lock dir pending delete fails mkdir with EPERM/EACCES: contention, so wait like EEXIST.
      if (error == null || (error.code !== 'EEXIST' && !isWinTransient(error))) return null;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > SESSION_LOCK_STALE_MS) {
          fs.rmdirSync(dir);
          continue;
        }
      } catch { /* released meanwhile */ }
    }
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

function transcriptOf(sessionId, state) {
  for (const candidate of [state.transcriptPath, copilotSessionFile(sessionId)]) {
    try { if (candidate && fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

// Size and mtime, so the file is re-read only after Copilot appends to it.
function signatureOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// 'bill' for an unbilled main-stream shutdown past the cursor hint clamped to the run start, 'done' when this run's is already billed, 'resumed' when a later run starts or ends first.
function scan(transcript, state, baseLine, runStart) {
  const cursor = state.cursorLine == null ? 0 : state.cursorLine;
  const billed = new Set(state.reportedShutdownLines.map(shutdownKey));
  const { events } = readEvents(transcript, { fromLine: Math.min(cursor, runStart) });
  for (const e of events) {
    if (e.agentId != null) continue;
    if (e.type === EVENT_TYPES.SESSION_SHUTDOWN) {
      if (!billed.has(shutdownKey(e))) return { kind: 'bill', line: e.line };
      if (e.line > runStart) return { kind: 'done' };
    }
    if (e.line > baseLine && (e.type === EVENT_TYPES.SESSION_START || e.type === EVENT_TYPES.SESSION_RESUME)) return { kind: 'resumed' };
    // A later SessionEnd spawns a newer worker with a fresh deadline, which takes over once this one exits.
    if (e.line > baseLine && e.type === 'hook.start' && e.data.hookType === 'sessionEnd') return { kind: 'resumed' };
  }
  return null;
}

async function watch(sessionId, guard) {
  const deadline = Date.now() + WAIT_MS;
  let seen = null;
  let baseLine = null;
  let runStart = 0;
  let leftover = null;
  while (Date.now() < deadline) {
    try { const now = new Date(); fs.utimesSync(guard, now, now); } catch { /* best-effort */ }
    const state = loadSessionState(sessionId);
    const transcript = transcriptOf(sessionId, state);
    if (transcript != null && baseLine == null) {
      const head = readEvents(transcript);
      if (!head.unreadable) {
        baseLine = head.lastCompleteLine;
        // This run starts at the last main-stream start or resume, so a shutdown Copilot wrote before this first poll still counts as this run's.
        for (const e of head.events) {
          if (e.agentId == null && (e.type === EVENT_TYPES.SESSION_START || e.type === EVENT_TYPES.SESSION_RESUME)) runStart = e.line;
        }
      }
    }
    const signature = transcript == null || baseLine == null ? null : signatureOf(transcript);
    if (signature != null && signature !== seen) {
      seen = signature;
      const found = scan(transcript, state, baseLine, runStart);
      // The new run's own hooks bill from here.
      if (found != null && (found.kind === 'resumed' || found.kind === 'done')) return;
      if (found != null && found.kind === 'bill') {
        const out = await runCheckpoint({ sessionId, transcriptPath: transcript, trigger: 'session-end-late', budgetMs: 15000, withTimeline: true });
        // A billed leftover from an earlier run keeps the wait for this run's shutdown; the same leftover twice means it will not bill.
        const billedLeftover = out.outcome === 'committed' && found.line <= runStart && found.line !== leftover;
        // Otherwise only a held lock is retried; the holder may bill it first, which the next pass sees in the state.
        if (!billedLeftover && out.reason !== 'session-busy') return;
        if (billedLeftover) leftover = found.line;
        seen = null;
      }
    }
    await sleep(POLL_MS);
  }
}

async function main() {
  if (process.env.BEEZI_COPILOT_PROBE === '1') return;
  const sessionId = process.argv[2];
  if (!isUsableSessionId(sessionId)) return;
  const guard = await acquireGuard(sessionId);
  if (guard == null) return;
  try {
    await watch(sessionId, guard);
  } finally {
    try { fs.rmdirSync(guard); } catch { /* already gone */ }
  }
}

main().catch(() => {}).then(() => exitClean(0)).catch(() => exitClean(0));
