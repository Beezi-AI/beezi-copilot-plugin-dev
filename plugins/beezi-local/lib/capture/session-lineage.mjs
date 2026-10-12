// Owns where a session's own history starts: the lines a fork copied from its parent and the parent session a
// detached run reports under. Pure.
import { EVENT_TYPES, dataOf, sessionStartOf } from '../sources/cli/event-types.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';

function isRunStart(e) {
  return e.type === EVENT_TYPES.SESSION_START || e.type === EVENT_TYPES.SESSION_RESUME;
}

// The last line a fork copied from its parent, 0 when the session is not a fork. `facts` is the app database's
// { forkedFromSessionId, forkHistoryEventCount } or null; its count is of events, so it maps through the parsed list.
export function forkBoundary(events, sessionId, facts) {
  const list = Array.isArray(events) ? events : [];
  const count = facts != null && facts.forkedFromSessionId != null ? facts.forkHistoryEventCount : null;
  if (Number.isInteger(count) && count > 0) return list.length === 0 ? 0 : list[Math.min(count, list.length) - 1].line;
  // Copied history opens with the parent's own start, so this session's history begins at its own start record.
  const first = sessionStartOf(list);
  const firstId = first == null ? null : dataOf(first).sessionId;
  if (typeof firstId !== 'string' || firstId === '' || firstId === sessionId) return 0;
  for (const e of list) if (isRunStart(e) && dataOf(e).sessionId === sessionId) return e.line - 1;
  return 0;
}

// The events past the lines a fork copied (forkLine 0: all of them).
export function ownEvents(events, forkLine) {
  return forkLine === 0 ? events : events.filter((e) => e.line > forkLine);
}

// The parent a detached run's telemetry belongs to (session.start detachedFromSpawningParentSessionId), else null.
export function detachedParentOf(events, sessionId) {
  const start = sessionStartOf(events);
  const parent = start == null ? null : dataOf(start).detachedFromSpawningParentSessionId;
  return isUsableSessionId(parent) && parent !== sessionId ? parent : null;
}
