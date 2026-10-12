// Owns the Linux libsecret backend: locating secret-tool, probing the session bus, and its read/store/clear calls.
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { secretServiceProbeFile } from '../../config/paths.mjs';
import { readJson, writeJsonSecure } from '../../platform/fs-store.mjs';
import { resolveExecutable } from '../../platform/executables.mjs';
import { BACKENDS, defaultRun, readResult, runRead, withGet } from './process.mjs';

// Short cap for the reachability probe, so a locked or absent keyring falls back to the file fast.
const SECRET_TOOL_PROBE_TIMEOUT_MS = 1500;
// How long every process trusts the last probe verdict: a locked keyring is pinged, and may prompt, once per window.
export const PROBE_VERDICT_TTL_MS = 10 * 60 * 1000;
// A ping killed by its timeout is no answer (a cold D-Bus, a loaded login): its no is trusted for a minute only.
export const TIMED_OUT_VERDICT_TTL_MS = 60 * 1000;
const PROBE_RECORD_VERSION = 1;

// A session bus is named by DBUS_SESSION_BUS_ADDRESS or exists as the $XDG_RUNTIME_DIR/bus socket.
function hasSessionBus(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  if (!env.XDG_RUNTIME_DIR) return false;
  try { return fs.statSync(path.join(env.XDG_RUNTIME_DIR, 'bus')).isSocket(); } catch { return false; }
}

// Looks up an attribute pair nothing stores: exit 0, or exit 1 with silent stderr, means the service answered.
// → { ok, timedOut }; a ping killed by its timeout is timedOut.
function defaultSecretToolPing(bin) {
  const r = spawnSync(bin, ['lookup', 'service', 'beezi-probe', 'account', 'none'], {
    encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    timeout: SECRET_TOOL_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (r.signal != null) return { ok: false, timedOut: true };
  if (r.error != null) return { ok: false, timedOut: r.error.code === 'ETIMEDOUT' };
  return { ok: r.status === 0 || (r.status === 1 && String(r.stderr || '').trim() === ''), timedOut: false };
}

function ping(run, bin) {
  if (run === defaultRun) return defaultSecretToolPing(bin);
  const timedOut = run(bin, ['lookup', 'service', 'beezi-probe', 'account', 'none'], undefined,
    { timeoutMs: SECRET_TOOL_PROBE_TIMEOUT_MS }).timedOut === true;
  return { ok: !timedOut, timedOut };
}

// A verdict is bound to the PATH and bus it was taken under, hashed so the record holds no environment text.
export function probeKey(env) {
  const parts = [env.PATH, env.DBUS_SESSION_BUS_ADDRESS, env.XDG_RUNTIME_DIR].map((v) => (v == null ? '' : String(v)));
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

// The recorded ok/no for `key` while younger than its TTL (a minute for a timed-out ping), else null.
export function freshVerdict(record, key, now) {
  if (record == null || record.version !== PROBE_RECORD_VERSION || record.key !== key) return null;
  if (typeof record.ok !== 'boolean' || typeof record.at !== 'number') return null;
  const age = now - record.at;
  const ttl = record.timedOut === true ? TIMED_OUT_VERDICT_TTL_MS : PROBE_VERDICT_TTL_MS;
  return age >= 0 && age < ttl ? record.ok : null;
}

// Binary on PATH, then a session bus, then the persisted verdict, then the ping; headless boxes stop before any spawn.
// `fresh` (writes and deletes) re-pings past a recorded no, so a keyring unlocked since never pushes a login to the file.
function secretToolAvailable(run, env, fresh) {
  const bin = resolveExecutable('secret-tool', env);
  if (bin == null || !hasSessionBus(env)) return false;
  const key = probeKey(env);
  const now = Date.now();
  const cached = freshVerdict(readJson(secretServiceProbeFile()), key, now);
  if (cached === true || (cached === false && !fresh)) return cached;
  const { ok, timedOut } = ping(run, bin);
  const record = { version: PROBE_RECORD_VERSION, key, ok, at: now, ...(timedOut ? { timedOut: true } : {}) };
  try { writeJsonSecure(secretServiceProbeFile(), record); } catch { /* next process probes again */ }
  return ok;
}

export function secretToolBackend(run, env, { fresh = false } = {}) {
  const attrs = (entry) => ['service', entry.service, 'account', entry.account];
  return withGet({
    name: BACKENDS.SECRET_SERVICE,
    kind: 'os',
    available: () => secretToolAvailable(run, env, fresh),
    read(entry, options) {
      const bin = resolveExecutable('secret-tool', env);
      if (bin == null) return { token: null, timedOut: false };
      return readResult(runRead(run, bin, ['lookup', ...attrs(entry)], undefined, options));
    },
    set(entry, secret) {
      const bin = resolveExecutable('secret-tool', env);
      // secret-tool reads the secret from stdin — keeps it out of the process list.
      return bin != null && run(bin, ['store', `--label=${entry.service}`, ...attrs(entry)], secret).ok
        ? 'the OS secret service (libsecret)' : false;
    },
    delete(entry) {
      const bin = resolveExecutable('secret-tool', env);
      if (bin != null) run(bin, ['clear', ...attrs(entry)]);
    },
  });
}
