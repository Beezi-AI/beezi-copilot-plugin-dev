import fs from 'fs';
import path from 'path';
import { sleepSync } from '../core/async.mjs';

// Guards the telemetry report a write failure schedules below: without it, a write failure
// inside the telemetry directory itself would report, which writes, which fails, which
// reports again — forever, starving the hook's event loop instead of ever reaching exitClean.
let reportingWriteFailure = false;

// Removes a file or tree. fs.rmSync exists from Node 14.14 and gets `options` untouched; below that a file is
// unlinked and a tree removed with the recursive rmdir (Node 12.10+), with the same `force` and `recursive` meaning.
export function removePath(target, options, fsImpl = fs) {
  if (typeof fsImpl.rmSync === 'function') {
    fsImpl.rmSync(target, options);
    return;
  }
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
  } catch (error) {
    if (error != null && error.code === 'ENOENT' && options != null && options.force === true) return;
    throw error;
  }
  if (!stat.isDirectory()) fsImpl.unlinkSync(target);
  else if (options != null && options.recursive === true) fsImpl.rmdirSync(target, { recursive: true });
  else fsImpl.rmdirSync(target);
}

const WIN_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Exponential backoff totalling ~1 s: AV, backup and indexer locks routinely outlast a few hundred ms.
export const RENAME_RETRY_MS = Object.freeze([10, 20, 40, 80, 160, 320, 400]);

// True on win32 for the codes a scanner, indexer or pending delete holds a path with.
export function isWinTransient(error) {
  return process.platform === 'win32' && error != null && WIN_TRANSIENT.has(error.code);
}

// renameSync, retried with blocking sleeps from RENAME_RETRY_MS while win32 reports a transient lock.
export function renameSyncRetry(from, to, deps = {}) {
  const rename = deps.renameSync == null ? fs.renameSync : deps.renameSync;
  const transient = deps.isTransient == null ? isWinTransient : deps.isTransient;
  const sleep = deps.sleepSync == null ? sleepSync : deps.sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_RETRY_MS.length || !transient(error)) throw error;
      sleep(RENAME_RETRY_MS[attempt]);
    }
  }
}

// Text of a buffer by its BOM: UTF-16LE, UTF-16BE or UTF-8 (BOM dropped); UTF-8 without one.
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2, 2 + ((buffer.length - 2) & ~1)));
    return swapped.swap16().toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString('utf-8', 3);
  return buffer.toString('utf-8');
}

// A text file decoded by decodeText; throws like readFileSync.
export function readTextFile(filePath) {
  return decodeText(fs.readFileSync(filePath));
}

// Read + parse a JSON file, or return `fallback` on any read/parse failure.
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readTextFile(filePath));
  } catch {
    return fallback;
  }
}

// Returns the text of the first complete JSON object in `raw`, or null. Scans for the brace that
// closes the opening one, honoring strings and escapes. Deliberately not driven by the position
// in a JSON.parse error message: that wording is a V8 detail that has changed between Node
// versions, and this runs as far back as Node 13.2.
function firstJsonObject(raw) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(0, i + 1);
    }
  }
  return null;
}

// Read + parse, falling back to the first complete JSON object when the file has trailing
// wreckage. Files written before writeJsonSecure became atomic can hold a whole payload followed
// by the tail of a longer previous one; that prefix is intact data, and dropping it throws away a
// session's analytics. Returns { value, salvaged } — `value` is null when nothing is recoverable.
export function readJsonSalvaged(filePath) {
  let raw;
  try {
    raw = readTextFile(filePath);
  } catch {
    return { value: null, salvaged: false };
  }
  try {
    return { value: JSON.parse(raw), salvaged: false };
  } catch {
    /* trailing wreckage, or genuinely unreadable — try the prefix */
  }
  const prefix = firstJsonObject(raw);
  if (prefix == null) return { value: null, salvaged: false };
  try {
    return { value: JSON.parse(prefix), salvaged: true };
  } catch {
    return { value: null, salvaged: false };
  }
}

// Write JSON to a 0600 file, creating parent dirs. With `createDir: false` the parent must already
// exist: a missing one means its owner removed it (a logout), so nothing is written and false
// is returned; true otherwise.
//
// The write goes to a private temp file in the SAME directory and is then renamed into place.
// Rename is atomic within a filesystem, so every reader and every competing writer sees either
// the old file or the new one — never a blend of the two. Writing the target directly could not
// promise that: `writeFileSync` opens with O_TRUNC and then writes, so when two processes both
// truncate before either writes, the shorter payload lands over the longer one and the longer
// one's tail survives past the closing brace. Seven hook events call runCheckpoint in separate
// processes with no lock between them, and parallel SubagentStop hooks fire together, so two
// writers landing on one queue/<segmentId>.json is routine rather than exotic. The wreckage
// never parsed, flushQueue skipped it on every pass, and those analytics were lost in silence.
export function writeJsonSecure(filePath, obj, { dirMode = 0o700, createDir = true } = {}) {
  if (createDir) fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: dirMode });
  // pid + random: two processes must never pick the same temp name, or they would corrupt the
  // temp instead of the target and rename the wreckage into place.
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    // The temp is always newly created, so `mode` applies and the payload — prompt text, and in
    // credentials.json an OAuth refresh token — is never briefly world-readable.
    fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* no-op on Windows */
    }
    renameSyncRetry(tmp, filePath);
    return true;
  } catch (error) {
    // Never leave a half-written temp behind for prune to trip over.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    // Without createDir, ENOENT is the parent vanishing under us: a skip, not a write failure to report.
    if (!createDir && error != null && error.code === 'ENOENT') return false;
    if (!reportingWriteFailure) {
      reportingWriteFailure = true;
      try {
        // Lazy require-style import: fs-store is imported by telemetry, so a static import here
        // would be a cycle. `source` is omitted: hook-runner publishes the true source, and
        // recordIssue falls back to it.
        import('../telemetry/recorder.mjs')
          .then(({ recordIssue }) => recordIssue({ code: 'state_write_failed', error }))
          .catch(() => {})
          .finally(() => { reportingWriteFailure = false; });
      } catch { /* never */ }
    }
    throw error;
  }
}

// Creates (0600) or re-stamps an empty marker file and sets its mtime to `at`; throws like openSync.
export function touchPrivate(filePath, at) {
  fs.closeSync(fs.openSync(filePath, 'a', 0o600));
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* no-op on Windows */
  }
  fs.utimesSync(filePath, at, at);
}
