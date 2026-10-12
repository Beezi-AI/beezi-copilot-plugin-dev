// mkdir locks whose holder touches and removes only the directory it created. The owner token is the directory's
// inode and birth time, so the on-disk shape stays an empty directory that older plugin versions still take, touch and remove.
import fs from 'fs';
import crypto from 'crypto';
import { isWinTransient } from '../platform/fs-store.mjs';
import { sleep as defaultSleep } from '../core/async.mjs';

const POLL_MS = 100;

// Inode plus birth time: a freed inode number reused at once (ext4) still differs in when the directory was made.
function tokenOf(dir) {
  try {
    const st = fs.statSync(dir);
    return `${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

const UNKNOWN_TOKEN = '0:0';

// Still the directory this holder created; a filesystem that reports neither can only be checked for existence.
function stillOwned(dir, token) {
  const now = tokenOf(dir);
  return now != null && (token === UNKNOWN_TOKEN || now === token);
}

function handleFor(dir) {
  let token = tokenOf(dir);
  let released = false;
  return {
    // → whether the holder still owns the lock; a broken holder learns it here and stops its work.
    touch() {
      if (released || !stillOwned(dir, token)) return false;
      try {
        const now = new Date();
        fs.utimesSync(dir, now, now);
        // Where birth time falls back to ctime, the touch itself changes it.
        token = tokenOf(dir);
      } catch { /* best-effort */ }
      return true;
    },
    release() {
      if (released) return;
      released = true;
      if (!stillOwned(dir, token)) return;
      try { fs.rmdirSync(dir); } catch { /* already gone */ }
    },
  };
}

// The stale holder's identity: inode plus mtime. A same-parent rename changes neither, while birth time falls back to
// ctime on Linux without statx and rename moves ctime; a touch since the stale check moves mtime, so it is spared.
const staleTokenOf = (st) => `${st.ino}:${st.mtimeMs}`;

function staleTokenAt(dir) {
  try { return staleTokenOf(fs.statSync(dir)); } catch { return null; }
}

// Renames the stale directory to a unique sibling, so of two breakers only one wins, then removes it. A rename that caught a
// holder's fresh or freshly touched directory (after the stale check) is put back and counts as lost.
function breakStale(dir, staleToken) {
  const tombstone = `${dir}.${crypto.randomBytes(6).toString('hex')}.stale`;
  try { fs.renameSync(dir, tombstone); } catch { return false; }
  if (staleTokenAt(tombstone) !== staleToken) {
    try { fs.renameSync(tombstone, dir); } catch { /* the holder's handle now misses and its lock ends as stale */ }
    return false;
  }
  try { fs.rmdirSync(tombstone); } catch { /* removed by prune later */ }
  return true;
}

// One try → the handle, or null while another holder has it; throws for an error that waiting cannot fix.
function attempt(dir, staleMs) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return handleFor(dir);
  } catch (error) {
    // A win32 lock dir pending delete fails mkdir with EPERM/EACCES: contention, so wait like EEXIST.
    if (error == null || (error.code !== 'EEXIST' && !isWinTransient(error))) throw error;
  }
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  if (Date.now() - st.mtimeMs <= staleMs || !breakStale(dir, staleTokenOf(st))) return null;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return handleFor(dir);
  } catch {
    return null;
  }
}

// The lock at `dir` (its parent must exist), polled until waitMs; a holder idle past staleMs is broken. → { touch, release } or null.
export async function acquireDirLock(dir, { staleMs, waitMs = 0, pollMs = POLL_MS, sleep = defaultSleep }) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    let handle;
    try { handle = attempt(dir, staleMs); } catch { return null; }
    if (handle != null) return handle;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(pollMs, left));
  }
}
