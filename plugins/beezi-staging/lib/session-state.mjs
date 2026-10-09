import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonSecure, isWinTransient } from './fs-store.mjs';
import { MAIN_CALL_KEY } from './cold-prefix.mjs';

export const SESSION_STATE_VERSION = 1;
// A killed hook holds the session lock for at most this long (R-01).
export const SESSION_LOCK_STALE_MS = 2 * 60 * 1000;
// How many earlier cursor events are kept to relocate by after the host rewrites the file.
export const CURSOR_TRAIL_MAX = 20;

const STATE_LOCK_STALE_MS = 10 * 1000;
const STATE_LOCK_RETRY_MS = 20;
const STATE_LOCK_WAIT_MS = 300;
const SESSION_LOCK_POLL_MS = 100;
const USAGE_MODES = ['per_call', 'session_totals'];
const RESERVED = ['null', 'undefined', 'NaN', 'true', 'false'];
const ACCOUNT_SOURCES = ['log', 'transcript', 'vscode-log', 'vscode-state'];
const ACCOUNT_KEY_MAX = 64;
const VSCODE_REQUEST_KEY_MAX = 200;
const VSCODE_REPORTED_MAX = 10000;
// Agents whose previous call is remembered for the cold-prefix counters.
const MAX_LAST_CALLS = 50;

// R-17: the only session-id validator. The character class already excludes '/', '\' and NUL; '..' is refused explicitly.
export function isUsableSessionId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    && id.indexOf('..') === -1
    && RESERVED.indexOf(id) === -1;
}

function isPlain(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function nonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function strOrNull(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function stateFile(sessionId) {
  return path.join(stateDir(), `${sessionId}.json`);
}

function defaults(sessionId) {
  return {
    version: SESSION_STATE_VERSION,
    sessionId,
    transcriptPath: null,
    cwd: null,
    cursorLine: null,
    cursorEvent: null,
    cursorTrail: [],
    usageMode: null,
    lastUsageRowId: 0,
    usageRowFloorMs: null,
    reportedShutdownLines: [],
    coveredIntervals: [],
    lastReport: null,
    sessionName: null,
    pendingErrors: [],
    timelineHash: null,
    subagents: {},
    lastCalls: {},
    accountKey: null,
    accountSource: null,
    // VS Code Local-agent progress, never read by the Copilot CLI path: see coerceVscode.
    vscode: null,
    updatedAt: null,
  };
}

// { cursor, reported, file, cwd, lastReport, sessionName } or null: cursor counts the requests reported (the last to_line),
// reported holds their request keys so a rewritten requests array never bills one twice.
function coerceVscode(v) {
  if (!isPlain(v) || !nonNegInt(v.cursor)) return null;
  const reported = Array.isArray(v.reported)
    ? v.reported.filter((k) => typeof k === 'string' && k !== '' && k.length <= VSCODE_REQUEST_KEY_MAX).slice(-VSCODE_REPORTED_MAX)
    : [];
  return {
    cursor: v.cursor,
    reported,
    file: strOrNull(v.file),
    cwd: strOrNull(v.cwd),
    lastReport: isPlain(v.lastReport) ? v.lastReport : null,
    sessionName: strOrNull(v.sessionName),
  };
}

// { [agentKey]: { at, model } }, keeping the most recent agents; anything malformed is dropped.
function coerceLastCalls(v) {
  if (!isPlain(v)) return {};
  const keys = Object.keys(v).filter((k) => isPlain(v[k]) && typeof v[k].model === 'string' && v[k].model !== ''
    && (v[k].at == null || (typeof v[k].at === 'number' && isFinite(v[k].at))));
  keys.sort((a, b) => (v[b].at == null ? 0 : v[b].at) - (v[a].at == null ? 0 : v[a].at));
  const out = {};
  // The main stream's entry is never evicted by the cap.
  const kept = keys.filter((k) => k === MAIN_CALL_KEY).concat(keys.filter((k) => k !== MAIN_CALL_KEY)).slice(0, MAX_LAST_CALLS);
  for (const k of kept) out[k] = { at: v[k].at == null ? null : v[k].at, model: v[k].model };
  return out;
}

function isInterval(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && isFinite(v[0]) && typeof v[1] === 'number' && isFinite(v[1]);
}

function coerce(sessionId, parsed) {
  const base = defaults(sessionId);
  if (!isPlain(parsed)) return base;
  const state = { ...base, ...parsed };
  // R-05: the workspace answer lives in Plan 03's <sid>.workspace, never here.
  delete state.workspace;
  state.version = SESSION_STATE_VERSION;
  state.sessionId = sessionId;
  state.transcriptPath = strOrNull(parsed.transcriptPath);
  state.cwd = strOrNull(parsed.cwd);
  // Any integer, including 0, means established; anything else is unestablished.
  state.cursorLine = nonNegInt(parsed.cursorLine) ? parsed.cursorLine : null;
  const ce = parsed.cursorEvent;
  state.cursorEvent = isPlain(ce) && nonNegInt(ce.line) && (ce.id == null || typeof ce.id === 'string')
    ? { id: ce.id == null ? null : ce.id, line: ce.line }
    : null;
  state.cursorTrail = Array.isArray(parsed.cursorTrail)
    ? parsed.cursorTrail.filter((a) => isPlain(a) && nonNegInt(a.line) && typeof a.id === 'string' && a.id !== '').slice(-CURSOR_TRAIL_MAX)
    : [];
  state.usageMode = USAGE_MODES.indexOf(parsed.usageMode) !== -1 ? parsed.usageMode : null;
  state.lastUsageRowId = nonNegInt(parsed.lastUsageRowId) ? parsed.lastUsageRowId : 0;
  state.usageRowFloorMs = typeof parsed.usageRowFloorMs === 'number' && isFinite(parsed.usageRowFloorMs) ? parsed.usageRowFloorMs : null;
  state.reportedShutdownLines = Array.isArray(parsed.reportedShutdownLines)
    ? parsed.reportedShutdownLines.filter((e) => isPlain(e) && nonNegInt(e.line) && (e.id == null || typeof e.id === 'string'))
    : [];
  state.coveredIntervals = Array.isArray(parsed.coveredIntervals) ? parsed.coveredIntervals.filter(isInterval) : [];
  state.lastReport = isPlain(parsed.lastReport) ? parsed.lastReport : null;
  state.sessionName = strOrNull(parsed.sessionName);
  state.pendingErrors = Array.isArray(parsed.pendingErrors)
    ? parsed.pendingErrors.filter((e) => isPlain(e) && typeof e.error === 'string')
    : [];
  state.timelineHash = strOrNull(parsed.timelineHash);
  state.subagents = isPlain(parsed.subagents) ? parsed.subagents : {};
  state.lastCalls = coerceLastCalls(parsed.lastCalls);
  // The session's bound GitHub account '<host>/<login>'; both fields or neither.
  const key = strOrNull(parsed.accountKey);
  const bound = key != null && key.length <= ACCOUNT_KEY_MAX && key.indexOf('/') > 0 && ACCOUNT_SOURCES.indexOf(parsed.accountSource) !== -1;
  state.accountKey = bound ? key : null;
  state.accountSource = bound ? parsed.accountSource : null;
  state.vscode = coerceVscode(parsed.vscode);
  state.updatedAt = strOrNull(parsed.updatedAt);
  return state;
}

// The full state with defaults filled in; an unusable id yields the defaults and touches no path. Never throws.
export function loadSessionState(sessionId) {
  if (!isUsableSessionId(sessionId)) return defaults(null);
  try {
    return coerce(sessionId, readJson(stateFile(sessionId), null));
  } catch {
    return defaults(sessionId);
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no shared memory: retry at once */ }
}

// Short mkdir lock around one read-modify-write; false when it could not be taken in time.
function takeStateLock(lockDir) {
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { return false; }
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      return true;
    } catch (error) {
      // A win32 lock dir pending delete fails mkdir with EPERM/EACCES: contention, so wait like EEXIST.
      if (error == null || (error.code !== 'EEXIST' && !isWinTransient(error))) return false;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* released meanwhile */ }
      if (Date.now() >= deadline) return false;
      sleepSync(STATE_LOCK_RETRY_MS);
    }
  }
}

function releaseStateLock(lockDir) {
  try { fs.rmdirSync(lockDir); } catch { /* already gone */ }
}

// Object-valued fields merge one level deep; every other value replaces.
function mergePatch(current, patch) {
  const next = { ...current };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    next[key] = isPlain(current[key]) && isPlain(value) ? { ...current[key], ...value } : value;
  }
  return next;
}

// The function form runs inside the lock and its keys replace top-level values; use it for read-modify-write.
export function saveSessionState(sessionId, patchOrFn) {
  if (!isUsableSessionId(sessionId)) return false;
  const lockDir = path.join(stateDir(), `${sessionId}.state.lock`);
  let held = false;
  try {
    held = takeStateLock(lockDir);
    const current = loadSessionState(sessionId);
    let next;
    if (typeof patchOrFn === 'function') {
      const patch = patchOrFn(current);
      if (!isPlain(patch)) return false;
      next = { ...current };
      for (const key of Object.keys(patch)) if (patch[key] !== undefined) next[key] = patch[key];
    } else {
      if (!isPlain(patchOrFn)) return false;
      next = mergePatch(current, patchOrFn);
    }
    next.version = SESSION_STATE_VERSION;
    next.sessionId = sessionId;
    next.updatedAt = new Date().toISOString();
    // Written even when the lock was not won: the atomic rename keeps the file valid.
    writeJsonSecure(stateFile(sessionId), next);
    return true;
  } catch {
    return false;
  } finally {
    if (held) releaseStateLock(lockDir);
  }
}

function lockHandle(dir) {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { fs.rmdirSync(dir); } catch { /* already gone */ }
    },
    touch() {
      if (released) return;
      try {
        const now = new Date();
        fs.utimesSync(dir, now, now);
      } catch { /* best-effort */ }
    },
  };
}

// Per-session lock, one holder from read to cursor save; null when it is still held after waitMs (R-01).
export async function acquireSessionLock(sessionId, { waitMs = 0 } = {}) {
  if (!isUsableSessionId(sessionId)) return null;
  const dir = path.join(stateDir(), `${sessionId}.lock`);
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { return null; }
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    let acquired = false;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (error == null || (error.code !== 'EEXIST' && !isWinTransient(error))) return null;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > SESSION_LOCK_STALE_MS) {
          fs.rmdirSync(dir);
          try {
            fs.mkdirSync(dir, { mode: 0o700 });
            acquired = true;
          } catch { /* lost the race: someone else holds it */ }
        }
      } catch { /* released meanwhile */ }
    }
    if (acquired) return lockHandle(dir);
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(SESSION_LOCK_POLL_MS, left)));
  }
}
