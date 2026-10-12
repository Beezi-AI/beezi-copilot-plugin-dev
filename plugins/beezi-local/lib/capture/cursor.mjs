// Where a persisted read cursor sits in a rewritten events file, and the anchor trail the next save keeps.

function eventAtLine(events, line) {
  let lo = 0;
  let hi = events.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = events[mid].line;
    if (at === line) return events[mid];
    if (at < line) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function eventById(events, id) {
  if (id == null) return null;
  for (const e of events) if (e.id === id) return e;
  return null;
}

// Where the persisted cursor sits in the file as it is now. The host can rewrite the file under it (a /rewind drops
// events and renumbers the rest), so a cursor whose anchor event is gone moves to the newest older anchor that
// survives, then to a clamp; it is never held. Double billing is stopped by shutdown ids and row ids, not by the line.
export function locateCursor(events, state, toLine) {
  const ce = state.cursorEvent;
  if (ce == null) {
    return state.cursorLine > toLine ? { cursor: toLine, note: 'cursor-reset' } : { cursor: state.cursorLine, note: null };
  }
  const at = eventAtLine(events, ce.line);
  if (at != null && at.id === ce.id) return { cursor: Math.min(state.cursorLine, toLine), note: null };
  const found = eventById(events, ce.id);
  if (found != null) return { cursor: Math.min(toLine, found.line + (state.cursorLine - ce.line)), note: 'cursor-relocated' };
  const byId = new Map();
  for (const e of events) if (e.id != null) byId.set(e.id, e);
  for (let i = state.cursorTrail.length - 1; i >= 0; i--) {
    const older = byId.get(state.cursorTrail[i].id);
    if (older != null) return { cursor: Math.min(toLine, older.line), note: 'cursor-relocated' };
  }
  return { cursor: Math.min(state.cursorLine, toLine), note: 'cursor-reset' };
}

// The earlier cursor events still present in the file, oldest first, at most `max`: what a rewind that removes the newest anchor relocates to.
export function trailAfter(cur, events, lastEvent, max) {
  if (lastEvent == null) return cur.cursorTrail;
  const ids = new Set();
  for (const e of events) if (e.id != null) ids.add(e.id);
  const earlier = cur.cursorEvent == null ? cur.cursorTrail : [...cur.cursorTrail, cur.cursorEvent];
  return earlier.filter((a) => a.id != null && a.id !== lastEvent.id && ids.has(a.id)).slice(-max);
}
