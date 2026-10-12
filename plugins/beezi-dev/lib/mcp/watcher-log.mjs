// The watcher's log file: one timestamped line per append, rotated to watcher.log.1 once it passes 1 MB.
import fs from 'fs';
import path from 'path';
import { beeziHome } from '../config/paths.mjs';

const MAX_LOG_BYTES = 1024 * 1024;

export function watcherLogFile() {
  return path.join(beeziHome(), 'logs', 'watcher.log');
}

function rotateIfFull(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
}

// Never throws and never writes to stdout or stderr: stdout is the JSON-RPC channel.
export function appendWatcherLog(msg, { now = () => new Date() } = {}) {
  try {
    const file = watcherLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    rotateIfFull(file);
    fs.appendFileSync(file, `${now().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
}
