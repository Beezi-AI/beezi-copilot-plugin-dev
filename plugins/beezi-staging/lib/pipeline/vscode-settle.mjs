// Waiting for VS Code to land a request's closing save, and telling a quiet chat file from one still being written.
import fs from 'fs';
import { readVscodeSession } from '../sources/vscode/chat-session.mjs';
import { newestUnsettled } from '../capture/vscode-requests.mjs';
import { sleep } from '../core/async.mjs';

// A completed request whose closing save (elapsedMs) never landed is settled once the file has been quiet this long.
const SETTLE_IDLE_MS = 5 * 60 * 1000;
const SETTLE_POLL_MS = 500;

// VS Code runs the Stop hook before it finalises the request that hook ends, so a wait there can never see it settle.
const NO_SETTLE_TRIGGER = 'stop';

// The settle wait a turn-end run may spend: the caller's, at most half the budget; 0 when none was asked for or on Stop.
export function settleWaitOf({ settleWaitMs, budgetMs, trigger }) {
  if (trigger === NO_SETTLE_TRIGGER || !(typeof settleWaitMs === 'number' && settleWaitMs > 0)) return 0;
  return Math.min(settleWaitMs, budgetMs == null ? settleWaitMs : budgetMs / 2);
}

// The chat file's size and mtime as one comparable key, or null when it cannot be read.
function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

// A turn-end hook can run before VS Code saves the request it ends; a short re-read bills it now instead of next time.
// The first poll always re-reads, since the caller's read has no stamp; later polls only once size or mtime changed.
export async function awaitSettled(session, file, waitMs) {
  const settleUntil = Date.now() + waitMs;
  let current = session;
  let readStamp = null;
  while (newestUnsettled(current) && Date.now() + SETTLE_POLL_MS <= settleUntil) {
    await sleep(SETTLE_POLL_MS);
    const stamp = stampOf(file);
    if (stamp == null || stamp === readStamp) continue;
    readStamp = stamp;
    const again = readVscodeSession(file);
    if (again != null && again.sessionId === session.sessionId) current = again;
  }
  return current;
}

// How long the chat file has gone unchanged, in ms; 0 when it cannot be read.
export function quietForMs(file) {
  try { return Math.max(0, Date.now() - fs.statSync(file).mtimeMs); } catch { return 0; }
}

// True once the chat file has not changed for SETTLE_IDLE_MS; false when it cannot be read.
export function isQuiet(file) {
  return quietForMs(file) > SETTLE_IDLE_MS;
}
