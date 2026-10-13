// Owns the hook markers a session timeline reads: { permissions, subagents }, each list empty when its read fails.
import { readPermissionMarkers } from './permission-markers.mjs';
import { readSubagentMarkers } from './subagent-markers.mjs';

function readOrEmpty(read, sessionId) {
  try { return read(sessionId); } catch { return []; }
}

export function readTimelineMarkers(sessionId) {
  return {
    permissions: readOrEmpty(readPermissionMarkers, sessionId),
    subagents: readOrEmpty(readSubagentMarkers, sessionId),
  };
}
