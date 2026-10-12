// One chunked, memoized line scanner for the account logs of the Copilot CLI and VS Code; no raw line outlives a scan.
import fs from 'fs';

const CHUNK_BYTES = 1024 * 1024;

// Feeds every line of the file to onLine, reading it in chunks; false when it could not be read (or onLine threw).
export function forEachLine(file, onLine) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK_BYTES);
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
      const lines = (carry + buf.toString('utf8', 0, n)).split('\n');
      carry = lines.pop();
      for (const line of lines) onLine(line);
    }
    if (carry !== '') onLine(carry);
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// scanLog(file, stat): the value a fresh collector() ({ take(line), value }) built from the file, memoized per path while
// size and mtime hold; in-memory only, so one process scans each log once. An unreadable file yields an unfed value, uncached.
export function createLogScanner(collector) {
  const scanned = new Map();
  return function scanLog(file, stat) {
    const cached = scanned.get(file);
    if (cached != null && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const run = collector();
    if (!forEachLine(file, run.take)) return collector().value;
    scanned.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value: run.value });
    return run.value;
  };
}
