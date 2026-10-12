import fs from 'fs';
import path from 'path';
import { copilotLogsDir, copilotSessionFile } from '../../config/copilot-paths.mjs';
import { identityKey, normalizeHost } from '../../core/github-identity.mjs';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { signedInIdentityKeys } from './copilot-identity.mjs';
import { readEvents } from './events.mjs';
import { readSessionHead } from './session-files.mjs';
import { createLogScanner } from '../../platform/log-scan.mjs';

// Copilot writes no identity into the transcript, so its process logs and /login notices name the account.

export const AccountSource = Object.freeze({ LOG: 'log', TRANSCRIPT: 'transcript' });

const DEFAULT_HOST = 'github.com';
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
// The CLI writes 'Signed in successfully as <login>!', with the host after the login for a non-github.com account.
const TRANSCRIPT_SIGN_IN = /^Signed in successfully as ([A-Za-z0-9_-]+)(?:(?:\s+(?:on|at)\s+|\s*\(|@)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\)?)?!/;
// Cheap pre-filter: a line without one of these is dropped before any regex runs.
const NEEDLES = ['Workspace initialized: ', 'Created session: ', 'Registering foreground session: ', 'Signed in to ', 'self-fetch starting for account '];

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

// Only the parsed records of a log are kept.
function recordCollector() {
  const records = [];
  const take = (line) => {
    const rec = recordOf(line);
    if (rec != null) records.push(rec);
  };
  return { take, value: records };
}

const scanLog = createLogScanner(recordCollector);

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

// The session's registration record and the end of its window (the next other session's init): { anchor, until }, or null.
function sessionWindow(records, sessionId) {
  let anchor = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind !== 'account' && records[i].sid === sessionId) { anchor = i; break; }
  }
  if (anchor === -1) return null;
  let until = records.length;
  for (let i = anchor + 1; i < records.length; i++) {
    if (records[i].kind === 'init' && records[i].sid !== sessionId) { until = i; break; }
  }
  return { anchor, until };
}

// The distinct account keys a log names.
function accountKeysOf(records) {
  const keys = [];
  for (const r of records) {
    const found = r.kind === 'account' ? account(r.host, r.login, AccountSource.LOG) : null;
    if (found != null && keys.indexOf(found.key) === -1) keys.push(found.key);
  }
  return keys;
}

// The account in effect when the session was registered in this log. The CLI writes 'Signed in to' right after
// registering; the app and SDK write a session's self-fetch before its init. So: a 'Signed in to' line before the
// next other session's init, else the nearest account line before the session, else the first one after it.
// `strict` (the session's owner serves several accounts): past the 'Signed in to' line only the log's single
// account counts; a log naming two accounts names none rather than the nearest line's guess.
function accountInLog(records, sessionId, strict) {
  const win = sessionWindow(records, sessionId);
  if (win == null) return { mentioned: false, found: null };
  const signedIn = firstAccount(records, win.anchor + 1, win.until, 1, true);
  if (signedIn != null) return { mentioned: true, found: signedIn };
  if (strict && accountKeysOf(records).length !== 1) return { mentioned: true, found: null };
  const found = firstAccount(records, win.anchor - 1, -1, -1, false) || firstAccount(records, win.anchor + 1, win.until, 1, false);
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

// Logs that may hold the session, earliest run first; `strict` drops the app's shared github-app log.
function candidateLogs(firstMs, lastMs, strict) {
  let names = [];
  try { names = fs.readdirSync(copilotLogsDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    const proc = PROCESS_LOG.exec(name);
    if (proc == null && (strict || !APP_LOG.test(name))) continue;
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

// The first log that names the session's account; in strict mode the first log that mentions the session decides.
function fromLogs(sessionId, firstMs, lastMs, strict) {
  for (const log of candidateLogs(firstMs, lastMs, strict)) {
    const r = accountInLog(scanLog(log.file, log.stat), sessionId, strict);
    if (r.found != null || (strict && r.mentioned)) return r.found;
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
      const found = account(m[2] != null ? m[2] : hostFor(m[1]), m[1], AccountSource.TRANSCRIPT);
      if (found != null) return found;
    }
  }
  return null;
}

const UNKNOWN_SPAN = Object.freeze({ firstMs: NaN, lastMs: NaN });

function spanOf(events) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    const t = e.timestamp == null ? NaN : Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return lo === Infinity ? UNKNOWN_SPAN : { firstMs: lo, lastMs: hi };
}

function eventsOf(opts) {
  return opts != null && Array.isArray(opts.events) ? opts.events : null;
}

function transcriptOf(sessionId, opts) {
  return opts != null && typeof opts.transcriptPath === 'string' && opts.transcriptPath !== '' ? opts.transcriptPath : copilotSessionFile(sessionId);
}

// { firstMs, lastMs } of a session (NaN when unknown): its events' timestamps, else its transcript head and mtime, which
// bound it without parsing the whole file. opts as for resolveSessionAccount. Never throws.
export function sessionSpan(sessionId, opts = {}) {
  try {
    const events = eventsOf(opts);
    if (events != null) return spanOf(events);
    if (!isUsableSessionId(sessionId)) return UNKNOWN_SPAN;
    const transcript = transcriptOf(sessionId, opts);
    const head = readSessionHead(transcript);
    let lastMs = NaN;
    try { lastMs = fs.statSync(transcript).mtimeMs; } catch { lastMs = NaN; }
    return { firstMs: head == null || head.startedAt == null ? NaN : Date.parse(head.startedAt), lastMs };
  } catch {
    return UNKNOWN_SPAN;
  }
}

// { key, host, login, source } for the account that ran the session, or null. Never throws.
// opts.events: parsed transcript events if the caller already has them; opts.transcriptPath: where to read them;
// opts.strict: the session's owner serves several accounts, so only unambiguous log evidence counts.
export function resolveSessionAccount(sessionId, opts = {}) {
  try {
    if (!isUsableSessionId(sessionId)) return null;
    const span = sessionSpan(sessionId, opts);
    const logged = fromLogs(sessionId, span.firstMs, span.lastMs, opts != null && opts.strict === true);
    if (logged != null) return logged;
    let events = eventsOf(opts);
    if (events == null) {
      const read = readEvents(transcriptOf(sessionId, opts));
      events = read.unreadable ? [] : read.events;
    }
    return fromTranscript(events);
  } catch {
    return null;
  }
}
