import fs from 'fs';
import path from 'path';
import { beeziHome } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isUsableSessionId } from './session-state.mjs';

// The last status-line reading per session. Imported by workspace-session.mjs, so it must never import mode-guard.mjs.
const SNAPSHOT_VERSION = 1;
const REWRITE_MS = 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function snapshotDir() {
  return path.join(beeziHome(), 'statusline');
}

function snapshotFile(sessionId) {
  return path.join(snapshotDir(), `${sessionId}.json`);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// V-18/V-51 are open: the allow-all key names below are guesses, and an absent field reads as unknown (null), never false.
function allowAllOf(payload) {
  const perms = payload.permissions != null && typeof payload.permissions === 'object' ? payload.permissions : {};
  for (const v of [payload.allow_all, payload.allowAll, perms.allow_all, perms.allowAll]) {
    if (typeof v === 'boolean') return v;
  }
  return null;
}

function readingOf(payload) {
  const model = payload.model != null && typeof payload.model === 'object' ? payload.model : {};
  const name = typeof model.display_name === 'string' && model.display_name !== '' ? model.display_name : model.id;
  const context = payload.context_window != null && typeof payload.context_window === 'object' ? payload.context_window : {};
  const used = payload.ai_used != null && typeof payload.ai_used === 'object' ? payload.ai_used : {};
  return {
    model: typeof name === 'string' && name !== '' ? name : null,
    contextPct: num(context.used_percentage),
    nanoAiu: num(used.total_nano_aiu),
    allowAll: allowAllOf(payload),
  };
}

const same = (a, b) => a.model === b.model && a.contextPct === b.contextPct && a.nanoAiu === b.nanoAiu && a.allowAll === b.allowAll;

// One small local write, and only when a value changed or 60 s passed; no network, no spawn, every failure swallowed.
export function recordStatuslineSnapshot(payload, deps = {}) {
  try {
    if (payload == null || typeof payload !== 'object' || !isUsableSessionId(payload.session_id)) return false;
    const now = deps.now == null ? Date.now() : deps.now;
    const reading = readingOf(payload);
    const last = readStatuslineSnapshot(payload.session_id);
    if (last != null && same(last, reading) && now - last.at < REWRITE_MS) return false;
    writeJsonSecure(snapshotFile(payload.session_id), { version: SNAPSHOT_VERSION, at: now, ...reading });
    return true;
  } catch {
    return false;
  }
}

// { at (epoch ms), model, contextPct, nanoAiu, allowAll } | null
export function readStatuslineSnapshot(sessionId) {
  try {
    if (!isUsableSessionId(sessionId)) return null;
    const raw = readJson(snapshotFile(sessionId), null);
    if (raw == null || typeof raw !== 'object' || raw.version !== SNAPSHOT_VERSION) return null;
    const at = num(raw.at);
    if (at == null) return null;
    return {
      at,
      model: typeof raw.model === 'string' ? raw.model : null,
      contextPct: num(raw.contextPct),
      nanoAiu: num(raw.nanoAiu),
      allowAll: typeof raw.allowAll === 'boolean' ? raw.allowAll : null,
    };
  } catch {
    return null;
  }
}

// Housekeeping: snapshots of sessions untouched for 14 days. Never throws.
export function pruneStatuslineSnapshots({ now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let removed = 0;
  try {
    const dir = snapshotDir();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          removed += 1;
        }
      } catch { /* vanished */ }
    }
  } catch { /* no snapshot dir yet */ }
  return removed;
}
