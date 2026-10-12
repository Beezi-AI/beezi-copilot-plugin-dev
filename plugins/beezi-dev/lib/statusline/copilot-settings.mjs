// Reads and writes the user's Copilot settings.json, and reads a statusLine entry's command.
import fs from 'fs';
import path from 'path';
import { copilotSettingsFile } from '../config/copilot-paths.mjs';
import { readTextFile, renameSyncRetry } from '../platform/fs-store.mjs';

// The command object's statusline command string, or null when it is not a command statusLine.
export function commandOf(statusLine) {
  if (statusLine == null || statusLine.type !== 'command') return null;
  return typeof statusLine.command === 'string' ? statusLine.command : null;
}

// { settings } for a missing file ({}) or a plain-JSON object; { error: 'not-json' } for JSONC or any other parse
// failure, { error: 'unreadable' } when the file cannot be read.
export function readSettings() {
  const file = copilotSettingsFile();
  let text;
  try {
    text = readTextFile(file);
  } catch (e) {
    return e != null && e.code === 'ENOENT' ? { settings: {} } : { error: 'unreadable' };
  }
  if (text.trim() === '') return { settings: {} };
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { settings: parsed } : { error: 'not-json' };
  } catch {
    return { error: 'not-json' };
  }
}

// settings.json is the user's own file: pretty-printed, written atomically so a crash can never leave Copilot
// with half a config. A symlink is written THROUGH (temp file beside the target, renamed onto it, permission
// bits kept), so the link stays. A Windows lock on the target is retried; a rename that still fails leaves no temp file.
// `deps` reaches renameSyncRetry.
export function writeSettings(settings, deps = {}) {
  const file = copilotSettingsFile();
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* no file yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: default permissions */ }
  const tmp = `${target}.beezi-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  try {
    if (mode != null) fs.chmodSync(tmp, mode);
    renameSyncRetry(tmp, target, deps);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

export function settingsProblem(error, file) {
  return error === 'not-json'
    ? `Beezi: ${file} contains comments or is not plain JSON, so Beezi will not rewrite it.`
    : `Beezi: could not read ${file} — status line left untouched.`;
}
