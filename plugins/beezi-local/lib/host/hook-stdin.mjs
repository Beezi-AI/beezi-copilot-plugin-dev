// Reads a hook's JSON payload from stdin with no heavy imports, tolerating a pipe that is non-blocking or ends abruptly.
import fs from 'fs';
import { decodeText } from '../platform/fs-store.mjs';

const CHUNK_BYTES = 64 * 1024;
const RETRY_MS = 10;
// How long an empty non-blocking pipe is polled before the payload counts as absent.
export const STDIN_WAIT_MS = 1000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The whole of fd as text (BOM and UTF-16 decoded), or null when nothing could be read. EAGAIN is retried every
// RETRY_MS for up to waitMs in total; EOF ends the read like a zero-byte read.
export function readStdinText({ fd = 0, readSync = fs.readSync, sleep = sleepSync, waitMs = STDIN_WAIT_MS } = {}) {
  const chunks = [];
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let waited = 0;
  for (;;) {
    let n;
    try {
      n = readSync(fd, buffer, 0, CHUNK_BYTES, null);
    } catch (error) {
      const code = error == null ? null : error.code;
      if (code === 'EAGAIN' && waited < waitMs) {
        sleep(RETRY_MS);
        waited += RETRY_MS;
        continue;
      }
      if (code === 'EOF' || chunks.length > 0) break;
      return null;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.slice(0, n)));
  }
  return chunks.length === 0 ? null : decodeText(Buffer.concat(chunks));
}

// The parsed payload, or null on any read or parse failure: a hook never throws on bad input.
export function readHookStdin(deps = {}) {
  try {
    const text = readStdinText(deps);
    return text == null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}
