import { EVENT_TYPES } from './copilot-events.mjs';

// True for the router placeholder "auto" (any case, padded).
export function isAutoName(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === 'auto';
}

// Main-stream points where the session's model choice became Auto or stopped being Auto, oldest first.
export function buildAutoTimeline(events) {
  const points = [];
  let order = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev.agentId != null) continue;
    const ms = ev.timestamp == null ? NaN : Date.parse(ev.timestamp);
    if (!Number.isFinite(ms)) continue;
    let auto = null;
    if (ev.type === EVENT_TYPES.SESSION_START || ev.type === EVENT_TYPES.SESSION_RESUME) {
      const chosen = ev.data.selectedModel;
      if (typeof chosen === 'string' && chosen.trim() !== '') auto = isAutoName(chosen);
    } else if (ev.type === EVENT_TYPES.MODEL_CHANGE) auto = isAutoName(ev.data.newModel);
    else if (ev.type === EVENT_TYPES.AUTO_MODE_RESOLVED) auto = true;
    if (auto != null) points.push({ ms, auto, order: order++ });
  }
  points.sort((a, b) => (a.ms - b.ms) || (a.order - b.order));
  return points;
}

// True when the latest choice at or before `ms` was Auto; false before any choice is recorded.
export function isAutoAt(points, ms) {
  if (!Number.isFinite(ms)) return false;
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ms <= ms) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found === -1 ? false : points[found].auto;
}
