// Owns the Copilot Chat log reading: launch folders, their per-window logs and the login and token-sku lines in them.
import fs from 'fs';
import path from 'path';
import { vscodeCopilotChatLog } from '../../config/copilot-paths.mjs';
import { createLogScanner } from '../../platform/log-scan.mjs';

const LAUNCH_DIR = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const WINDOW_DIR = /^window\d+$/;
// Local-time stamp, level, then the login; only the login survives the scan. 'Got Copilot token for' is not read: in
// anonymous mode it names devDeviceId, never an account.
const LOGIN_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] Logged in as ([A-Za-z0-9_-]{1,39})\s*$/;
// The Copilot token's access_type_sku, logged right after the login it was fetched for.
const SKU_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] copilot token sku: ([a-z0-9_]{1,50})\s*$/;

export function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Component numbers as local wall-clock time; both the launch folder names and the log stamps are local.
function localMs(y, mo, d, h, mi, s, ms) {
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)).getTime();
  return isFinite(t) ? t : null;
}

// Login and sku lines of one log: { logins: [{ ms, login }], skus: [{ ms, login, sku }] }. Each sku carries the login logged before it.
function loginCollector() {
  const logins = [];
  const skus = [];
  const take = (line) => {
    if (line.indexOf('Logged in as ') === -1 && line.indexOf('token sku: ') === -1) return;
    const clean = line.replace(/\r$/, '');
    const m = LOGIN_LINE.exec(clean);
    if (m != null) {
      const ms = localMs(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
      if (ms != null) logins.push({ ms, login: m[8] });
      return;
    }
    const s = SKU_LINE.exec(clean);
    if (s == null) return;
    const ms = localMs(s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
    if (ms != null) skus.push({ ms, login: logins.length > 0 ? logins[logins.length - 1].login : null, sku: s[8] });
  };
  return { take, value: { logins, skus } };
}

export const scanChatLog = createLogScanner(loginCollector);

// Start time of a <logsDir>/<launch> folder name, or null when it is not one.
export function launchStartMs(name) {
  const m = LAUNCH_DIR.exec(name);
  return m == null ? null : localMs(m[1], m[2], m[3], m[4], m[5], m[6], 0);
}

// The Copilot Chat logs of one launch, one per window that has one.
export function launchLogs(launchDir) {
  const logs = [];
  for (const win of readDir(launchDir)) {
    if (!WINDOW_DIR.test(win)) continue;
    const file = vscodeCopilotChatLog(launchDir, win);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.isFile()) logs.push({ file, stat });
  }
  return logs;
}

// Launches whose span (folder start .. last Copilot Chat log write) contains atMs, with their chat logs.
function coveringLaunches(logsDir, atMs) {
  const out = [];
  for (const name of readDir(logsDir)) {
    const startMs = launchStartMs(name);
    if (startMs == null || startMs > atMs) continue;
    const logs = launchLogs(path.join(logsDir, name));
    let endMs = -Infinity;
    for (const log of logs) if (log.stat.mtimeMs > endMs) endMs = log.stat.mtimeMs;
    if (logs.length > 0 && endMs >= atMs) out.push(logs);
  }
  return out;
}

// The latest login line ({ ms, login }) at or before atMs across one install's covering launches, or null.
export function loginAt(logsDir, atMs) {
  let best = null;
  for (const logs of coveringLaunches(logsDir, atMs)) {
    for (const log of logs) {
      for (const hit of scanChatLog(log.file, log.stat).logins) {
        if (hit.ms <= atMs && (best == null || hit.ms >= best.ms)) best = hit;
      }
    }
  }
  return best;
}
