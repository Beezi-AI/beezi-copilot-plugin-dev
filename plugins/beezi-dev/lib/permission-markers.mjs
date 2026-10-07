import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';
import { isUsableSessionId } from './session-state.mjs';

// Read-time ceiling so a pathological session cannot hand the timeline an unbounded array.
const MAX_MARKERS = 2000;

// Session ids come off hook stdin; only an id passing the shared validator (R-17) becomes a file name.
export function stateMarkerFile(sessionId, suffix) {
  if (!isUsableSessionId(sessionId)) return null;
  return path.join(stateDir(), sessionId + suffix);
}

// Epoch values below 1e11 are seconds, above are milliseconds.
export function hookTimeIso(value) {
  let ms = NaN;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string') ms = Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

// One O_APPEND write per record, so concurrent hooks can only interleave whole lines.
export function appendMarkerLine(file, record) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function readMarkerLines(file) {
  if (!file) return [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec != null && typeof rec === 'object') out.push(rec);
    } catch { /* torn line */ }
  }
  return out;
}

function textOr(a, b) {
  if (typeof a === 'string' && a !== '') return a;
  return typeof b === 'string' && b !== '' ? b : null;
}

const permissionFile = (sessionId) => stateMarkerFile(sessionId, '.perm.jsonl');

// Input is Plan 06's NormalizedInput (snake_case); camelCase is tolerated for raw payloads.
export function permissionMarkerFromPayload(input) {
  const p = input == null ? {} : input;
  return {
    at: hookTimeIso(p.timestamp),
    tool_name: textOr(p.tool_name, p.toolName),
    permission_mode: textOr(p.permission_mode, p.permissionMode),
    source: textOr(p.notification_type, p.notificationType) == null ? 'permission_request' : 'notification',
  };
}

export function appendPermissionMarker(sessionId, marker) {
  return appendMarkerLine(permissionFile(sessionId), marker);
}

export function readPermissionMarkers(sessionId) {
  const out = [];
  for (const rec of readMarkerLines(permissionFile(sessionId))) {
    const ts = typeof rec.at === 'string' ? Date.parse(rec.at) : NaN;
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts,
      toolName: typeof rec.tool_name === 'string' ? rec.tool_name : null,
      permissionMode: typeof rec.permission_mode === 'string' ? rec.permission_mode : null,
      source: typeof rec.source === 'string' ? rec.source : 'permission_request',
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > MAX_MARKERS ? out.slice(-MAX_MARKERS) : out;
}
