import fs from 'fs';
import path from 'path';
import { beeziHome, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isUsableSessionId } from './session-state.mjs';
import { unattendedStatus, isUnattended, UnattendedSignal } from './workspace-session.mjs';
import { resolveSessionId } from './sessions.mjs';

// The one "nobody may be answering" signal is Plan 03's (R-18); it is re-exported, never re-implemented.
export { isUnattended, unattendedStatus };

const OBSERVATION_VERSION = 1;
const MODE_KEYS = ['agent_mode', 'permission_mode'];

const observationFile = (sessionId) => path.join(stateDir(), `${sessionId}.mode`);

const modeFields = (source) => {
  const out = {};
  if (source == null || typeof source !== 'object') return out;
  for (const key of MODE_KEYS) {
    if (typeof source[key] === 'string' && source[key] !== '') out[key] = source[key];
  }
  return out;
};

// { fields, at } as last stored for the session, or null.
function readObservation(sessionId) {
  if (!isUsableSessionId(sessionId)) return null;
  const record = readJson(observationFile(sessionId), null);
  if (record == null || record.version !== OBSERVATION_VERSION || record.fields == null || typeof record.fields !== 'object') return null;
  const fields = modeFields(record.fields);
  return Object.keys(fields).length === 0 ? null : { fields, at: typeof record.at === 'string' ? record.at : null };
}

// Stores the raw mode fields of the latest hook payload that carried any, only when they changed. Best effort.
export function recordModeObservation(sessionId, observation) {
  try {
    if (!isUsableSessionId(sessionId) || observation == null) return;
    const fields = modeFields(observation.fields);
    if (Object.keys(fields).length === 0) return;
    const current = readObservation(sessionId);
    if (current != null && JSON.stringify(current.fields) === JSON.stringify(fields)) return;
    const at = typeof observation.at === 'string' && observation.at !== '' ? observation.at : new Date().toISOString();
    writeJsonSecure(observationFile(sessionId), { version: OBSERVATION_VERSION, fields, at });
  } catch { /* an observation is never worth a failure */ }
}

// An explicit session id wins; otherwise the resolved one, and an ambiguous or missing answer is unknown (null).
function sessionIdFor({ sessionId, env, cwd }) {
  if (isUsableSessionId(sessionId)) return sessionId;
  const found = resolveSessionId({ env, cwd });
  return found != null && found.ambiguous !== true && isUsableSessionId(found.sessionId) ? found.sessionId : null;
}

// In a hook `input` is the payload; a script has none, so the stored observation stands in for it.
export function detectMode({ sessionId = null, env = process.env, input = null, cwd = process.cwd() } = {}) {
  const id = sessionIdFor({ sessionId, env, cwd });
  let observation = null;
  let observedAt = null;
  let source = input;
  if (input != null) {
    const fields = modeFields(input);
    observation = Object.keys(fields).length === 0 ? null : fields;
  } else if (id != null) {
    const stored = readObservation(id);
    if (stored != null) {
      observation = stored.fields;
      observedAt = stored.at;
      source = { fields: stored.fields };
    }
  }
  const status = unattendedStatus({ env, input: source, sessionId: id });
  return { unattended: status.unattended, signal: status.signal, observation, observedAt };
}

// A real write: a sandbox or an unwritable home shows up here, and no mode can tell you about it.
function probeStateWritable() {
  const dir = beeziHome();
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, '', 'utf-8');
  } catch (error) {
    return { ok: false, dir, code: error == null || !error.code ? 'unknown' : error.code };
  }
  try { fs.unlinkSync(probe); } catch { /* a leftover probe file is harmless */ }
  return { ok: true, dir, code: null };
}

// → { ok, reason: 'unattended' | 'state_unwritable' | 'argument-only' | null, message }. Never throws.
// 'argument-only': no signal either way, so skills print the choices and take a typed argument instead of asking.
export function checkInteractive({ purpose = 'this', env = process.env, cwd = process.cwd(), input = null, sessionId = null, requireWrite = false } = {}) {
  try {
    const mode = detectMode({ sessionId, env, input, cwd });
    if (mode.unattended) {
      return {
        ok: false,
        reason: 'unattended',
        message: `Beezi: this session answers questions without you (autopilot or questions turned off), so ${purpose} cannot run in it. Switch back to interactive mode (Shift+Tab or /permissions default), then try again.`,
      };
    }
    if (requireWrite) {
      const probe = probeStateWritable();
      if (!probe.ok) {
        return {
          ok: false,
          reason: 'state_unwritable',
          message: `Beezi: cannot write to ${probe.dir} (${probe.code}) — ${purpose} cannot finish. If the Copilot sandbox is on (/sandbox), allow writes to that folder or run it outside the sandbox.`,
        };
      }
    }
    if (mode.signal === UnattendedSignal.NO_SIGNAL) return { ok: true, reason: 'argument-only', message: null };
    return { ok: true, reason: null, message: null };
  } catch {
    return { ok: true, reason: 'argument-only', message: null };
  }
}
