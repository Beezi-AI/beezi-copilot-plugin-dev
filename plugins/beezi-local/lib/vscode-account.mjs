import fs from 'fs';
import path from 'path';
import { vscodeInstalls, vscodeStateDb, vscodeCopilotChatLog } from './copilot-paths.mjs';
import { identityKey, normalizeHost } from './copilot-account.mjs';
import { loadSqlite } from './copilot-store.mjs';

// The GitHub account a VS Code Local-agent session ran under: the Copilot Chat log of the launch that covers the
// session's first request, else the single account VS Code's state.vscdb knows when the session's label confirms it.

export const VscodeAccountSource = Object.freeze({ LOG: 'vscode-log', STATE: 'vscode-state' });

const HOST = 'github.com';
const LAUNCH_DIR = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const WINDOW_DIR = /^window\d+$/;
// Local-time stamp, level, then the login; only the login survives the scan.
const LOGIN_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] (?:Logged in as|Got Copilot token for) ([A-Za-z0-9_-]{1,39})\s*$/;
// The Copilot token's access_type_sku, logged right after the login it was fetched for.
const SKU_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[\w+\] copilot token sku: ([a-z0-9_]{1,50})\s*$/;
const USAGES_KEY = /^github-([A-Za-z0-9_-]{1,39})-usages$/;
const CHUNK_BYTES = 1024 * 1024;

// path → { size, mtimeMs, logins: [{ ms, login }], skus: [{ ms, login, sku }] }; in-memory only, so a backfill scans each log once.
const scanned = new Map();

function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Component numbers as local wall-clock time; both the launch folder names and the log stamps are local.
function localMs(y, mo, d, h, mi, s, ms) {
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)).getTime();
  return isFinite(t) ? t : null;
}

function account(login, source) {
  const host = normalizeHost(HOST);
  const key = identityKey(host, login);
  return key == null ? null : { key, host, login, source };
}

// Login and sku lines of one log, read in chunks; no other line outlives this call. Each sku carries the login logged before it.
function scanLog(file, stat) {
  const cached = scanned.get(file);
  if (cached != null && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
  const logins = [];
  const skus = [];
  const take = (line) => {
    if (line.indexOf(' as ') === -1 && line.indexOf('token for ') === -1 && line.indexOf('token sku: ') === -1) return;
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
      for (const line of lines) take(line);
    }
    if (carry !== '') take(carry);
  } catch {
    return { logins: [], skus: [] };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  const entry = { size: stat.size, mtimeMs: stat.mtimeMs, logins, skus };
  scanned.set(file, entry);
  return entry;
}

// Start time of a <logsDir>/<launch> folder name, or null when it is not one.
function launchStartMs(name) {
  const m = LAUNCH_DIR.exec(name);
  return m == null ? null : localMs(m[1], m[2], m[3], m[4], m[5], m[6], 0);
}

// The Copilot Chat logs of one launch, one per window that has one.
function launchLogs(launchDir) {
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

// Latest login line at or before atMs across the covering launches' logs.
function fromLogs(logsDir, atMs) {
  let best = null;
  for (const logs of coveringLaunches(logsDir, atMs)) {
    for (const log of logs) {
      for (const hit of scanLog(log.file, log.stat).logins) {
        if (hit.ms <= atMs && (best == null || hit.ms >= best.ms)) best = hit;
      }
    }
  }
  return best == null ? null : account(best.login, VscodeAccountSource.LOG);
}

// VS Code's current Copilot Chat account for a session neither its logs nor state.vscdb resolved, unless the session's
// own account label names someone else. Sync. Never throws.
export function currentVscodeAccount(session) {
  const now = readVscodeSignedIn();
  if (now == null) return null;
  const label = session != null && typeof session.accountLabel === 'string' ? session.accountLabel.trim().toLowerCase() : '';
  return label !== '' && label !== now.login.toLowerCase() ? null : now;
}

// The account Copilot Chat last signed in as, from the newest VS Code launch that wrote a Copilot Chat log, with the
// token sku logged for that login: { key, host, login, rawSku } (rawSku null when none was logged). Sync. Never throws.
export function readVscodeSignedIn() {
  try {
    const launches = [];
    for (const install of vscodeInstalls()) {
      for (const name of readDir(install.logsDir)) {
        const startMs = launchStartMs(name);
        if (startMs != null) launches.push({ dir: path.join(install.logsDir, name), startMs });
      }
    }
    launches.sort((a, b) => b.startMs - a.startMs);
    for (const launch of launches) {
      const logs = launchLogs(launch.dir);
      if (logs.length === 0) continue;
      // The newest launch with Copilot Chat decides; an older one never stands in for a sign-out.
      let who = null;
      let sku = null;
      for (const log of logs) {
        const scan = scanLog(log.file, log.stat);
        for (const hit of scan.logins) if (who == null || hit.ms >= who.ms) who = hit;
        for (const hit of scan.skus) if (sku == null || hit.ms >= sku.ms) sku = hit;
      }
      const found = who == null ? null : account(who.login, VscodeAccountSource.LOG);
      if (found == null) return null;
      const own = sku != null && sku.login != null && sku.login.toLowerCase() === who.login.toLowerCase();
      return { key: found.key, host: found.host, login: found.login, rawSku: own ? sku.sku : null };
    }
    return null;
  } catch {
    return null;
  }
}

// The logins with a 'github-<login>-usages' key in state.vscdb, read-only; [] when unreadable.
async function stateLogins(userDir) {
  const file = vscodeStateDb(userDir);
  if (!fs.existsSync(file)) return [];
  const mod = await loadSqlite();
  if (mod == null) return [];
  let db = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT key FROM ItemTable WHERE key LIKE 'github-%-usages'").all();
    const logins = [];
    for (const row of rows) {
      const m = USAGES_KEY.exec(String(row.key));
      if (m != null && logins.indexOf(m[1]) === -1) logins.push(m[1]);
    }
    return logins;
  } catch {
    return [];
  } finally {
    if (db != null) { try { db.close(); } catch { /* already closed */ } }
  }
}

// The time the session's account must hold: its first request, else its creation.
function anchorMs(session) {
  let first = null;
  for (const r of session.requests || []) {
    if (r != null && typeof r.startedAtMs === 'number' && (first == null || r.startedAtMs < first)) first = r.startedAtMs;
  }
  return first != null ? first : (typeof session.createdAtMs === 'number' ? session.createdAtMs : null);
}

// { key, host, login, source } for a readVscodeSession() result, or null. Async (state.vscdb is SQLite). Never throws.
export async function resolveVscodeAccount(session) {
  try {
    if (session == null || typeof session !== 'object') return null;
    const atMs = anchorMs(session);
    const installs = vscodeInstalls().filter((x) => session.product == null || x.product === session.product);
    // The session's own account label vetoes any answer naming someone else.
    const label = typeof session.accountLabel === 'string' ? session.accountLabel.trim().toLowerCase() : '';
    if (atMs != null) {
      for (const install of installs) {
        const found = fromLogs(install.logsDir, atMs);
        if (found == null) continue;
        return label !== '' && label !== found.login.toLowerCase() ? null : found;
      }
    }
    // state.vscdb answers only when the label confirms its single login.
    if (label === '') return null;
    for (const install of installs) {
      const logins = await stateLogins(install.userDir);
      if (logins.length !== 1) continue;
      return label === logins[0].toLowerCase() ? account(logins[0], VscodeAccountSource.STATE) : null;
    }
    return null;
  } catch {
    return null;
  }
}
