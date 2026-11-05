// Chunked line scanners for the Copilot CLI and VS Code account logs (memoized) and transcripts; no raw line outlives a scan.
import fs from 'fs';

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024 * 1024;
const NEWLINE = 0x0a;

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

// scanLines: a chunked line scanner that never holds a whole file: lines split on the `\n` byte, decoded one at a time.
// Calls onLine(buf, start, end, terminated, over) per line; the unterminated tail only when non-empty.
function forEachRawLine(filePath, chunkBytes, maxLineBytes, onLine) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let buf = Buffer.alloc(chunkBytes);
    let start = 0;
    let end = 0;
    let pos = 0;
    let over = false;
    for (;;) {
      const nl = buf.subarray(0, end).indexOf(NEWLINE, start);
      if (nl !== -1) {
        if (onLine(buf, start, nl, true, over || nl - start > maxLineBytes)) return;
        over = false;
        start = nl + 1;
        continue;
      }
      if (end - start > maxLineBytes) over = true;
      if (over) {
        start = 0;
        end = 0;
      } else {
        buf.copy(buf, 0, start, end);
        end -= start;
        start = 0;
        if (end === buf.length) {
          const grown = Buffer.alloc(buf.length * 2);
          buf.copy(grown, 0, 0, end);
          buf = grown;
        }
      }
      if (pos >= size) break;
      const read = fs.readSync(fd, buf, end, Math.min(buf.length - end, size - pos), pos);
      if (read === 0) break;
      pos += read;
      end += read;
    }
    if (over || end > start) onLine(buf, start, end, false, over || end - start > maxLineBytes);
  } finally {
    fs.closeSync(fd);
  }
}

// A line is visited once a later non-empty line or the end shows whether it is last; an unterminated last line is always decoded.
export function scanLines(filePath, visit, { fromLine = 0, chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}) {
  let lineCount = 0;
  let pendingEmpty = 0;
  let endsWithNewline = false;
  let held = null;
  let stopped = false;
  const emit = (text, lineNo, last, terminated) => {
    stopped = visit(text, lineNo, { last, endsWithNewline: terminated }) === true;
    return stopped;
  };
  forEachRawLine(filePath, chunkBytes, maxLineBytes, (buf, start, end, terminated, over) => {
    endsWithNewline = terminated;
    if (!over && start === end) {
      pendingEmpty += 1;
      return false;
    }
    if (held != null && emit(held.text, held.lineNo, false, held.terminated)) return true;
    for (; pendingEmpty > 0; pendingEmpty--) {
      lineCount += 1;
      if (emit(lineCount > fromLine ? '' : null, lineCount, false, true)) return true;
    }
    lineCount += 1;
    const decode = !over && (lineCount > fromLine || !terminated);
    held = { text: decode ? buf.toString('utf8', start, end) : null, lineNo: lineCount, terminated };
    return false;
  });
  if (!stopped && held != null) emit(held.text, held.lineNo, true, held.terminated);
  return { lineCount, endsWithNewline };
}
