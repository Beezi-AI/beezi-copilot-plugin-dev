import fs from 'fs';
import path from 'path';
import { stateDir } from '../config/paths.mjs';
import { readJson, writeJsonSecure, isWinTransient } from '../platform/fs-store.mjs';
import { MAIN_CALL_KEY } from '../core/call-keys.mjs';
import { isPlain } from '../core/guards.mjs';
import { sleepSync } from '../core/async.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { acquireDirLock } from './dir-lock.mjs';

export const SESSION_STATE_VERSION = 1;
// A killed hook holds the session lock for at most this long.
export const SESSION_LOCK_STALE_MS = 2 * 60 * 1000;
// How many earlier cursor events are kept to relocate by after the host rewrites the file.
export const CURSOR_TRAIL_MAX = 20;

const STATE_LOCK_STALE_MS = 10 * 1000;
const STATE_LOCK_RETRY_MS = 20;
const STATE_LOCK_WAIT_MS = 300;
const USAGE_MODES = ['per_call', 'session_totals'];
// Every source billing/session-identity binds from (the CLI and VS Code readers, the process env and the app's data.db).
const ACCOUNT_SOURCES = ['log', 'transcript', 'vscode-log', 'vscode-state', 'vscode-label', 'process-env', 'app-db'];
// 0.7.x keeps a binding only under its own four sources and erases any other on its next save, so a newer source is stored
// as its nearest old one in accountSource and in full in accountOrigin.
const LEGACY_SOURCE_OF = Object.freeze({ 'vscode-label': 'vscode-state', 'process-env': 'log', 'app-db': 'log' });
const ACCOUNT_KEY_MAX = 64;
const VSCODE_REQUEST_KEY_MAX = 200;
const VSCODE_REPORTED_MAX = 10000;
// Agents whose previous call is remembered for the cold-prefix counters.
const MAX_LAST_CALLS = 50;
// VS Code requests billed provisionally and not settled yet; only the newest request can be one, so a few suffice.
const VSCODE_EMITTED_MAX = 20;

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
    accountOrigin: null,
    // VS Code Local-agent progress, never read by the Copilot CLI path: see coerceVscode.
    vscode: null,
    // The cumulative usage_checkpoint totals already billed in session_totals mode (capture/checkpoint-credits owns the shape).
    reportedCheckpoint: null,
    // SessionEnd ran and the late session.shutdown is not billed yet: catch-up and the watcher look for it.
    pendingShutdown: false,
    // { requestKey: { credits, input, line } } of VS Code requests billed before they settled, re-emitted when the numbers grow.
    vscodeEmitted: {},
    // The last line whose session.error events an activity-free session already delivered.
    errorCursorLine: 0,
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

function isEmitted(e) {
  return isPlain(e) && typeof e.credits === 'number' && isFinite(e.credits) && e.credits >= 0 && nonNegInt(e.input) && nonNegInt(e.line);
}

// { requestKey: { credits, input, line } }, a few entries at most; anything malformed is dropped.
function coerceEmitted(v) {
  if (!isPlain(v)) return {};
  const out = {};
  const keys = Object.keys(v).filter((k) => k !== '' && k.length <= VSCODE_REQUEST_KEY_MAX && isEmitted(v[k]));
  for (const k of keys.slice(-VSCODE_EMITTED_MAX)) out[k] = { credits: v[k].credits, input: v[k].input, line: v[k].line };
  return out;
}

function legacySource(source) {
  return Object.prototype.hasOwnProperty.call(LEGACY_SOURCE_OF, source) ? LEGACY_SOURCE_OF[source] : source;
}

// The state patch binding a session to `key` found by `source`, readable by 0.7.x as well.
export function accountBinding(key, source) {
  return { accountKey: key, accountSource: legacySource(source), accountOrigin: source };
}

// The binding's source: accountOrigin when it still matches accountSource (0.7.x rewrites only accountSource), else accountSource.
function boundSource(parsed) {
  const origin = parsed.accountOrigin;
  return ACCOUNT_SOURCES.indexOf(origin) !== -1 && legacySource(origin) === parsed.accountSource ? origin : parsed.accountSource;
}

function isInterval(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && isFinite(v[0]) && typeof v[1] === 'number' && isFinite(v[1]);
}

function coerce(sessionId, parsed) {
  const base = defaults(sessionId);
  if (!isPlain(parsed)) return base;
  const state = { ...base, ...parsed };
  // The workspace answer lives in <sid>.workspace, never here.
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
  // The session's bound GitHub account '<host>/<login>'; all three fields or none.
  const key = strOrNull(parsed.accountKey);
  const source = boundSource(parsed);
  const bound = key != null && key.length <= ACCOUNT_KEY_MAX && key.indexOf('/') > 0 && ACCOUNT_SOURCES.indexOf(source) !== -1;
  state.accountKey = bound ? key : null;
  state.accountSource = bound ? legacySource(source) : null;
  state.accountOrigin = bound ? source : null;
  state.vscode = coerceVscode(parsed.vscode);
  state.reportedCheckpoint = isPlain(parsed.reportedCheckpoint) ? parsed.reportedCheckpoint : null;
  state.pendingShutdown = parsed.pendingShutdown === true;
  state.vscodeEmitted = coerceEmitted(parsed.vscodeEmitted);
  state.errorCursorLine = nonNegInt(parsed.errorCursorLine) ? parsed.errorCursorLine : 0;
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

// The local cursor of a VS Code session (requests reported), or null when none is stored.
export function vscodeCursorOf(sessionId) {
  const v = loadSessionState(sessionId).vscode;
  return v == null ? null : v.cursor;
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

// The function form runs inside the lock and its keys replace top-level values; use it for read-modify-write. It writes
// nothing when the lock is not won; an object patch is still written then, the atomic rename keeping the file valid.
export function saveSessionState(sessionId, patchOrFn) {
  if (!isUsableSessionId(sessionId)) return false;
  const lockDir = path.join(stateDir(), `${sessionId}.state.lock`);
  let held = false;
  try {
    held = takeStateLock(lockDir);
    const current = loadSessionState(sessionId);
    let next;
    if (typeof patchOrFn === 'function') {
      if (!held) return false;
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
    writeJsonSecure(stateFile(sessionId), next);
    return true;
  } catch {
    return false;
  } finally {
    if (held) releaseStateLock(lockDir);
  }
}

// Per-session lock, one holder from read to cursor save; null when it is still held after waitMs. The holder touches
// and releases only the lock it created, so one broken while its holder slept is never removed under the next holder.
export async function acquireSessionLock(sessionId, { waitMs = 0 } = {}) {
  if (!isUsableSessionId(sessionId)) return null;
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { return null; }
  return acquireDirLock(path.join(stateDir(), `${sessionId}.lock`), { staleMs: SESSION_LOCK_STALE_MS, waitMs });
}
