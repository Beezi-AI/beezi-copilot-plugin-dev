import fs from 'fs';
import path from 'path';
import { copilotLogsDir, copilotSessionFile } from './copilot-paths.mjs';
import { identityKey, normalizeHost, signedInIdentityKeys } from './copilot-account.mjs';
import { readEvents } from './copilot-events.mjs';
import { readSessionHead } from './transcript-index-copilot.mjs';

// Copilot writes no identity into the transcript, so its process logs and /login notices name the account.

export const AccountSource = Object.freeze({ LOG: 'log', TRANSCRIPT: 'transcript' });

const DEFAULT_HOST = 'github.com';
const CHUNK_BYTES = 1024 * 1024;
// A log last written this long before the session's first event cannot mention it.
const MTIME_SLACK_MS = 60 * 1000;
const PROCESS_LOG = /^process-(\d+)-\d+\.log$/;
const APP_LOG = /^github-app\.\d+\.log$/;
const SID = '([A-Za-z0-9][A-Za-z0-9._-]{0,127})';
const INIT_LINE = new RegExp(`Workspace initialized: ${SID}(?:\\s|$)`);
const CREATED_LINE = new RegExp(`Created session: ${SID}(?:\\s|$)`);
const REGISTER_LINE = new RegExp(`(?:^|\\s)Registering foreground session: ${SID}(?:\\s|$)`);
const SIGNED_IN_LINE = /Signed in to (\S+) as ([A-Za-z0-9_-]+)\.\s*$/;
const SELF_FETCH_LINE = /self-fetch starting for account (https?:\/\/[^\s/]+)\/([A-Za-z0-9_-]+)\s*$/;
const TRANSCRIPT_SIGN_IN = /^Signed in successfully as ([A-Za-z0-9_-]+)!/;
// Cheap pre-filter: a line without one of these is dropped before any regex runs.
const NEEDLES = ['Workspace initialized: ', 'Created session: ', 'Registering foreground session: ', 'Signed in to ', 'self-fetch starting for account '];

// path → { size, mtimeMs, records }; in-memory only, so one backfill scans each log once.
const scanned = new Map();

function account(host, login, source) {
  const h = normalizeHost(host);
  const key = identityKey(h, login);
  return key == null ? null : { key, host: h, login, source };
}

// One log line to { kind: 'init'|'session', sid } or { kind: 'account', host, login, signedIn }, else null.
function recordOf(line) {
  let hit = false;
  for (const needle of NEEDLES) if (line.indexOf(needle) !== -1) { hit = true; break; }
  if (!hit) return null;
  let m = INIT_LINE.exec(line);
  if (m) return { kind: 'init', sid: m[1] };
  m = CREATED_LINE.exec(line) || REGISTER_LINE.exec(line);
  if (m) return { kind: 'session', sid: m[1] };
  m = SIGNED_IN_LINE.exec(line);
  if (m) return { kind: 'account', host: m[1], login: m[2], signedIn: true };
  m = SELF_FETCH_LINE.exec(line);
  if (m) return { kind: 'account', host: m[1], login: m[2], signedIn: false };
  return null;
}

// Reads the log in chunks and keeps only the parsed records; no raw line outlives this call.
function scanLog(file, stat) {
  const cached = scanned.get(file);
  if (cached != null && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.records;
  const records = [];
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
      for (const line of lines) {
        const rec = recordOf(line);
        if (rec != null) records.push(rec);
      }
    }
    if (carry !== '') {
      const rec = recordOf(carry);
      if (rec != null) records.push(rec);
    }
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  scanned.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, records });
  return records;
}

// First account record in [from, to) stepping by step, optionally only 'Signed in to' lines.
function firstAccount(records, from, to, step, signedInOnly) {
  for (let i = from; i !== to; i += step) {
    const r = records[i];
    if (r.kind !== 'account' || (signedInOnly && !r.signedIn)) continue;
    const found = account(r.host, r.login, AccountSource.LOG);
    if (found != null) return found;
  }
  return null;
}

// The account in effect when the session was registered in this log. The CLI writes 'Signed in to' right after
// registering; the app and SDK write a session's self-fetch before its init. So: a 'Signed in to' line before the
// next other session's init, else the nearest account line before the session, else the first one after it.
function accountInLog(records, sessionId) {
  let anchor = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind !== 'account' && records[i].sid === sessionId) { anchor = i; break; }
  }
  if (anchor === -1) return { mentioned: false, found: null };
  let until = records.length;
  for (let i = anchor + 1; i < records.length; i++) {
    if (records[i].kind === 'init' && records[i].sid !== sessionId) { until = i; break; }
  }
  const found = firstAccount(records, anchor + 1, until, 1, true)
    || firstAccount(records, anchor - 1, -1, -1, false)
    || firstAccount(records, anchor + 1, until, 1, false);
  return { mentioned: true, found };
}

function firstLineMs(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    const ms = Date.parse(buf.toString('utf8', 0, n).split(/\s/)[0]);
    return Number.isFinite(ms) ? ms : Infinity;
  } catch {
    return Infinity;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// Logs that may hold the session, earliest run first.
function candidateLogs(firstMs, lastMs) {
  let names = [];
  try { names = fs.readdirSync(copilotLogsDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    const proc = PROCESS_LOG.exec(name);
    if (proc == null && !APP_LOG.test(name)) continue;
    const file = path.join(copilotLogsDir(), name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size === 0) continue;
    const startMs = proc != null ? Number(proc[1]) : firstLineMs(file);
    if (Number.isFinite(lastMs) && Number.isFinite(startMs) && startMs > lastMs) continue;
    if (Number.isFinite(firstMs) && stat.mtimeMs < firstMs - MTIME_SLACK_MS) continue;
    out.push({ file, stat, startMs });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function fromLogs(sessionId, firstMs, lastMs) {
  for (const log of candidateLogs(firstMs, lastMs)) {
    const r = accountInLog(scanLog(log.file, log.stat), sessionId);
    if (r.found != null) return r.found;
  }
  return null;
}

// Host of the signed-in user with that login (config.json), else github.com.
function hostFor(login) {
  const suffix = `/${login.toLowerCase()}`;
  for (const key of signedInIdentityKeys()) {
    if (key.length > suffix.length && key.slice(-suffix.length) === suffix) return key.slice(0, -suffix.length);
  }
  return DEFAULT_HOST;
}

// Earliest in-session /login notice ('Signed in successfully as <login>!').
function fromTranscript(events) {
  for (const e of events) {
    if (e.type !== 'session.info' || e.data.infoType !== 'authentication' || typeof e.data.message !== 'string') continue;
    const m = TRANSCRIPT_SIGN_IN.exec(e.data.message);
    if (m) {
      const found = account(hostFor(m[1]), m[1], AccountSource.TRANSCRIPT);
      if (found != null) return found;
    }
  }
  return null;
}

function spanOf(events) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    const t = e.timestamp == null ? NaN : Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { lo, hi };
}

// { key, host, login, source } for the account that ran the session, or null. Never throws.
// opts.events: parsed transcript events if the caller already has them; opts.transcriptPath: where to read them.
export function resolveSessionAccount(sessionId, opts = {}) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const given = opts != null && Array.isArray(opts.events) ? opts.events : null;
    const transcript = opts != null && typeof opts.transcriptPath === 'string' && opts.transcriptPath !== ''
      ? opts.transcriptPath
      : copilotSessionFile(sessionId);
    let events = given;
    let firstMs = NaN;
    let lastMs = NaN;
    if (events != null) {
      const span = spanOf(events);
      firstMs = span.lo;
      lastMs = span.hi;
    } else {
      // Head and mtime bound the logs without parsing the whole transcript.
      const head = readSessionHead(transcript);
      firstMs = head == null || head.startedAt == null ? NaN : Date.parse(head.startedAt);
      try { lastMs = fs.statSync(transcript).mtimeMs; } catch { lastMs = NaN; }
    }
    const logged = fromLogs(sessionId, firstMs, lastMs);
    if (logged != null) return logged;
    if (events == null) {
      const read = readEvents(transcript);
      events = read.unreadable ? [] : read.events;
    }
    return fromTranscript(events);
  } catch {
    return null;
  }
}
