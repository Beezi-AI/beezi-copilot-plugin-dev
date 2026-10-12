// The one-worker-per-session guard of the SessionEnd wait: a mkdir lock beside <sid>.lock, touched every poll by its holder.
import fs from 'fs';
import path from 'path';
import { stateDir } from '../config/paths.mjs';
import { acquireDirLock } from '../state/dir-lock.mjs';
import { SESSION_LOCK_STALE_MS } from '../state/session-state.mjs';

// A worker touches its guard every poll; a checkpoint it runs may hold it untouched for up to its 15 s budget.
const LIVE_GUARD_MS = 30 * 1000;

const guardDir = (sessionId) => path.join(stateDir(), `${sessionId}.shutdown-worker.lock`);

// True while a worker holds the session's guard and touched it recently: a new SessionEnd leaves the wait to it.
export function shutdownWorkerLive(sessionId, nowMs = Date.now()) {
  try { return nowMs - fs.statSync(guardDir(sessionId)).mtimeMs <= LIVE_GUARD_MS; } catch { return false; }
}

// The guard, waited for up to waitMs; null when another worker keeps it.
export async function acquireShutdownGuard(sessionId, { waitMs, pollMs }) {
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { return null; }
  return acquireDirLock(guardDir(sessionId), { staleMs: SESSION_LOCK_STALE_MS, waitMs, pollMs });
}
