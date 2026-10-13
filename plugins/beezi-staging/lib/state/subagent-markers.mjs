// Owns the per-session subagent hook markers (<id>.subagents.jsonl): the record a hook writes, the append and the read.
import { appendMarkerLine, readMarkerLines, stateMarkerFile } from './permission-markers.mjs';
import { hookTimeIso } from '../core/hook-time.mjs';
import { str } from '../core/guards.mjs';

// Four marker lines per subagent the capture collector keeps (its MAX_AGENTS is 1000).
const MAX_MARKERS = 4000;

const markerFile = (sessionId) => stateMarkerFile(sessionId, '.subagents.jsonl');

function firstText(a, b) {
  return str(a) != null ? a : str(b);
}

// Input is the hook's NormalizedInput (snake_case); camelCase is tolerated for raw payloads.
export function subagentMarkerFromPayload(kind, input) {
  const p = input == null ? {} : input;
  return {
    ev: kind === 'stop' ? 'stop' : 'start',
    at: hookTimeIso(p.timestamp),
    agent_id: firstText(p.agent_id, p.agentId),
    agent_type: firstText(p.agent_type, p.agentType),
    agent_name: firstText(p.agent_name, p.agentName),
    agent_display_name: firstText(p.agent_display_name, p.agentDisplayName),
  };
}

export function appendSubagentMarker(sessionId, marker) {
  return appendMarkerLine(markerFile(sessionId), marker);
}

export function readSubagentMarkers(sessionId) {
  const out = [];
  for (const r of readMarkerLines(markerFile(sessionId))) {
    const ts = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(ts) || (r.ev !== 'start' && r.ev !== 'stop')) continue;
    out.push({
      ev: r.ev, ts,
      agentId: str(r.agent_id), agentType: str(r.agent_type),
      agentName: str(r.agent_name), displayName: str(r.agent_display_name),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > MAX_MARKERS ? out.slice(-MAX_MARKERS) : out;
}
