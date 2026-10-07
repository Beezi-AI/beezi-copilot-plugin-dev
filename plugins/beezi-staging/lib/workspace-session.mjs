import fs from 'fs';
import { copilotSettingsFile } from './copilot-paths.mjs';
import { readJson } from './fs-store.mjs';
import { findSessionFile } from './transcript-index-copilot.mjs';
import { isUsableSessionId } from './session-state.mjs';
import { readStatuslineSnapshot } from './statusline-snapshot.mjs';

// Why a session is or is not treated as unattended. 'no_signal' means "not unattended", but nothing was
// readable, so callers that could act on a guess must not take it as a green light.
export const UnattendedSignal = Object.freeze({
  AUTOPILOT: 'autopilot',
  NON_INTERACTIVE: 'non_interactive',
  ASK_USER_OFF: 'ask_user_off',
  ALLOW_ALL: 'allow_all',
  ATTENDED: 'attended',
  NO_SIGNAL: 'no_signal',
});

const BLOCK_BYTES = 256 * 1024;
// A long autopilot turn is mostly tool traffic, so the newest mode signal can lie far back; past this the answer is "unknown".
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_FRESH_MS = 10 * 60 * 1000;
// V-39 is open: allow-all is not known to auto-answer ask_user, so it does not count as unattended (Q-9).
const ALLOW_ALL_COUNTS = false;
// V-14 is open: no non-interactive (-p) signal is known, so NON_INTERACTIVE is never reported.

function verdict(signal) {
  return { unattended: signal !== UnattendedSignal.ATTENDED && signal !== UnattendedSignal.NO_SIGNAL, signal };
}

// The mode a main-thread line carries, or null. A user.message counts only when it names a mode (an injected skill or
// agent prompt may not), and session.mode_changed moves the mode between prompts.
function modeSignalOf(line) {
  if (line.indexOf('"user.message"') === -1 && line.indexOf('"session.mode_changed"') === -1) return null;
  let event = null;
  try { event = JSON.parse(line); } catch { return null; }
  if (event == null || typeof event !== 'object' || event.agentId != null) return null;
  const data = event.data != null && typeof event.data === 'object' ? event.data : {};
  if (event.type === 'user.message') {
    if (data.isAutopilotContinuation === true) return { agentMode: 'autopilot', isAutopilotContinuation: true };
    return typeof data.agentMode === 'string' ? { agentMode: data.agentMode, isAutopilotContinuation: false } : null;
  }
  if (event.type === 'session.mode_changed' && typeof data.newMode === 'string') {
    return { agentMode: data.newMode, isAutopilotContinuation: false };
  }
  return null;
}

// The newest main-thread mode signal in the session file, found by reading backwards in blocks: { readable, data },
// with data null when the whole file holds none. Gives up past MAX_SCAN_BYTES as unreadable, never as "no signal found".
function newestModeSignal(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    let pos = fs.fstatSync(fd).size;
    let scanned = 0;
    // The bytes of a line whose start lies in a block not read yet.
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      if (scanned >= MAX_SCAN_BYTES) return { readable: false, data: null };
      const length = Math.min(pos, BLOCK_BYTES);
      pos -= length;
      scanned += length;
      const block = Buffer.alloc(length);
      if (fs.readSync(fd, block, 0, length, pos) !== length) return { readable: false, data: null };
      const chunk = Buffer.concat([block, rest]);
      let body = chunk;
      rest = Buffer.alloc(0);
      if (pos > 0) {
        const newline = chunk.indexOf(0x0a);
        if (newline === -1) { rest = chunk; continue; }
        rest = chunk.subarray(0, newline);
        body = chunk.subarray(newline + 1);
      }
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (line === '') continue;
        const signal = modeSignalOf(line);
        if (signal != null) return { readable: true, data: signal };
      }
    }
    return { readable: true, data: null };
  } catch {
    return { readable: false, data: null };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// The mode fields of a hook payload, or of the stored { fields } observation a script passes instead.
function modeFieldsOf(input) {
  if (input == null || typeof input !== 'object') return {};
  const fields = input.fields != null && typeof input.fields === 'object' ? input.fields : input;
  const mode = fields.agent_mode != null ? fields.agent_mode : fields.agentMode;
  return { agentMode: typeof mode === 'string' ? mode : null };
}

function settingsAskUserOff() {
  const settings = readJson(copilotSettingsFile(), null);
  return settings != null && typeof settings === 'object' && settings.askUser === false;
}

function truthyEnv(value) {
  return /^(true|1|yes|on|y)$/i.test(String(value == null ? '' : value).trim());
}

// The one "nobody may be answering" verdict (R-18): the first matching reading wins. Never throws.
export function unattendedStatus({ env = process.env, input = null, sessionId = null } = {}) {
  try {
    const id = isUsableSessionId(sessionId) ? sessionId : null;
    let consulted = false;

    // Autopilot always counts, from the hook payload or from the newest main-thread mode signal in the file (V-48).
    const hook = modeFieldsOf(input);
    if (hook.agentMode != null) {
      if (hook.agentMode === 'autopilot') return verdict(UnattendedSignal.AUTOPILOT);
      consulted = true;
    }
    let file = input != null && typeof input.transcript_path === 'string' && input.transcript_path !== '' ? input.transcript_path : null;
    if (file == null && id != null) {
      const found = findSessionFile(id);
      file = found == null ? null : found.transcriptPath;
    }
    if (file != null) {
      const newest = newestModeSignal(file);
      if (newest.readable) {
        // A readable file is a source even before the first prompt: a command that answers a question sees the prompt by then.
        consulted = true;
        if (newest.data != null && (newest.data.agentMode === 'autopilot' || newest.data.isAutopilotContinuation === true)) {
          return verdict(UnattendedSignal.AUTOPILOT);
        }
      }
    }

    if (settingsAskUserOff()) return verdict(UnattendedSignal.ASK_USER_OFF);

    if (ALLOW_ALL_COUNTS) {
      if (truthyEnv(env.COPILOT_ALLOW_ALL)) return verdict(UnattendedSignal.ALLOW_ALL);
      const snapshot = id == null ? null : readStatuslineSnapshot(id);
      const at = snapshot == null ? NaN : (typeof snapshot.at === 'number' ? snapshot.at : Date.parse(snapshot.at));
      if (Number.isFinite(at) && Date.now() - at <= SNAPSHOT_FRESH_MS) {
        consulted = true;
        if (snapshot.allowAll === true) return verdict(UnattendedSignal.ALLOW_ALL);
      }
    }

    return verdict(consulted ? UnattendedSignal.ATTENDED : UnattendedSignal.NO_SIGNAL);
  } catch {
    return verdict(UnattendedSignal.NO_SIGNAL);
  }
}

export function isUnattended({ env = process.env, input = null, sessionId = null } = {}) {
  return unattendedStatus({ env, input, sessionId }).unattended;
}
