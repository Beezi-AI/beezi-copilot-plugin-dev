import { appendMarkerLine, hookTimeIso, readMarkerLines, stateMarkerFile } from './permission-markers.mjs';
import { dataOf, tsMs } from './operations.mjs';

const MAX_AGENTS = 1000;
const MAX_DEPTH = 16;
const MATCH_MS = 5000;

const markerFile = (sessionId) => stateMarkerFile(sessionId, '.subagents.jsonl');

function text(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function firstText(a, b) {
  return text(a) != null ? a : text(b);
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// Input is Plan 06's NormalizedInput (snake_case); camelCase is tolerated for raw payloads.
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
      agentId: text(r.agent_id), agentType: text(r.agent_type),
      agentName: text(r.agent_name), displayName: text(r.agent_display_name),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > 4 * MAX_AGENTS ? out.slice(-4 * MAX_AGENTS) : out;
}

// Later evidence fills nulls; startedAt only moves earlier, endedAt only later (ISO strings compare in order).
function merge(records, rec) {
  const cur = records.get(rec.agentId);
  if (cur == null) { records.set(rec.agentId, rec); return rec; }
  for (const k of Object.keys(rec)) if (cur[k] == null && rec[k] != null) cur[k] = rec[k];
  if (rec.startedAt != null && rec.startedAt < cur.startedAt) cur.startedAt = rec.startedAt;
  if (rec.endedAt != null && cur.endedAt != null && rec.endedAt > cur.endedAt) cur.endedAt = rec.endedAt;
  return cur;
}

function rekey(records, rec, agentId) {
  if (rec.agentId === agentId) return rec;
  records.delete(rec.agentId);
  rec.agentId = agentId;
  return merge(records, rec);
}

// Index of the latest unused start at or before the stop (same id when the start has one, else same name), or -1.
function pairedStart(markers, stop, used) {
  for (let i = markers.length - 1; i >= 0; i--) {
    const s = markers[i];
    if (s.ev !== 'start' || used.has(i) || s.ts > stop.ts) continue;
    const same = s.agentId != null ? s.agentId === stop.agentId : s.agentName == null || s.agentName === stop.agentName;
    if (!same) continue;
    used.add(i);
    return i;
  }
  return -1;
}

// Start markers carry no id: each joins the subagent.started record of the same name nearest in time (≤ 5 s).
function joinStarts(records, markers) {
  const owners = new Map();
  const taken = new Set();
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (m.ev !== 'start') continue;
    let best = null;
    let bestGap = MATCH_MS + 1;
    for (const r of records.values()) {
      if (r.source !== 'events' || r.toolCallId == null || r.startedAt == null || taken.has(r.agentId)) continue;
      if (m.agentName != null && r.configName != null && m.agentName !== r.configName) continue;
      const gap = Math.abs(Date.parse(r.startedAt) - m.ts);
      if (gap < bestGap) { best = r; bestGap = gap; }
    }
    if (best == null) continue;
    taken.add(best.agentId);
    owners.set(i, best);
    merge(records, { agentId: best.agentId, agentName: m.displayName });
  }
  return owners;
}

function applyMarkers(records, markers, eventsKnowAgents) {
  const owners = joinStarts(records, markers);
  const used = new Set();
  for (const m of markers) {
    if (m.ev !== 'stop') continue;
    const i = pairedStart(markers, m, used);
    let r = m.agentId == null ? null : records.get(m.agentId);
    if (r == null && owners.has(i)) r = owners.get(i);
    if (r != null) {
      merge(records, { agentId: r.agentId, agentType: m.agentType, agentName: m.agentName, endedAt: r.endedAt == null ? iso(m.ts) : null });
      continue;
    }
    if (eventsKnowAgents || i === -1 || m.agentId == null) continue;
    const s = markers[i];
    merge(records, {
      agentId: m.agentId, toolCallId: null, agentType: m.agentType,
      agentName: firstText(s.displayName, m.agentName), parentTaskId: null,
      configName: firstText(s.agentName, m.agentName), spawnDepth: null,
      startedAt: iso(s.ts), endedAt: iso(m.ts), source: 'hooks',
    });
  }
}

function resolveDepths(records) {
  const depthOf = (rec, hops) => {
    if (rec.spawnDepth != null) return rec.spawnDepth;
    if (rec.source !== 'events' || rec.toolCallId == null) return null;
    if (rec.parentTaskId == null) return 1;
    const parent = records.get(rec.parentTaskId);
    if (parent == null || hops >= MAX_DEPTH) return null;
    const pd = depthOf(parent, hops + 1);
    return pd == null ? null : pd + 1;
  };
  for (const rec of records.values()) rec.spawnDepth = depthOf(rec, 0);
}

export function collectSubagents(events, ctx) {
  const c = ctx == null ? {} : ctx;
  const list = Array.isArray(events) ? events : [];
  const records = new Map();
  const prior = c.state != null && c.state.subagents != null && typeof c.state.subagents === 'object' ? c.state.subagents : {};
  for (const id of Object.keys(prior)) {
    const p = prior[id];
    if (p != null && typeof p === 'object' && text(p.agentId) != null) records.set(p.agentId, Object.assign({}, p));
  }

  const idByTool = new Map();
  const spans = new Map();
  const started = [];
  const endByTool = new Map();
  const notices = new Map();
  let evidence = false;
  for (const e of list) {
    const d = dataOf(e);
    const ms = tsMs(e);
    if (text(e.agentId) != null) {
      evidence = true;
      const s = spans.get(e.agentId);
      if (s == null) spans.set(e.agentId, { first: ms, last: ms });
      else if (ms != null) {
        if (s.first == null || ms < s.first) s.first = ms;
        if (s.last == null || ms > s.last) s.last = ms;
      }
      if (text(d.parentToolCallId) != null && !idByTool.has(d.parentToolCallId)) idByTool.set(d.parentToolCallId, e.agentId);
    }
    if (e.type === 'subagent.started' && text(d.toolCallId) != null) {
      evidence = true;
      started.push(e);
    } else if ((e.type === 'subagent.completed' || e.type === 'subagent.failed') && text(d.toolCallId) != null) {
      evidence = true;
      endByTool.set(d.toolCallId, ms);
    } else if (e.type === 'system.notification' && d.kind != null && d.kind.type === 'agent_completed' && text(d.kind.agentId) != null) {
      notices.set(d.kind.agentId, { agentType: text(d.kind.agentType), agentName: firstText(d.kind.displayName, d.kind.description), ms });
    }
  }

  const byTool = new Map();
  for (const r of records.values()) if (r.toolCallId != null) byTool.set(r.toolCallId, r);

  for (const e of started) {
    const d = dataOf(e);
    const prev = byTool.get(d.toolCallId);
    const agentId = idByTool.has(d.toolCallId) ? idByTool.get(d.toolCallId)
      : text(e.agentId) != null ? e.agentId
      : prev != null ? prev.agentId : 'task:' + d.toolCallId;
    if (prev != null) rekey(records, prev, agentId);
    byTool.set(d.toolCallId, merge(records, {
      agentId, toolCallId: d.toolCallId,
      agentType: firstText(d.agentType, d.agentName),
      agentName: firstText(d.agentDisplayName, d.agentName),
      parentTaskId: text(d.parentId), configName: text(d.agentName), spawnDepth: null,
      startedAt: iso(tsMs(e)), endedAt: null, source: 'events',
    }));
  }
  // A start seen before any child event was keyed task:<toolCallId>; the child's own id wins.
  for (const [toolCallId, agentId] of idByTool) {
    const r = byTool.get(toolCallId);
    if (r != null) byTool.set(toolCallId, rekey(records, r, agentId));
  }
  for (const [toolCallId, ms] of endByTool) {
    const r = byTool.get(toolCallId);
    if (r != null && ms != null) merge(records, { agentId: r.agentId, endedAt: iso(ms) });
  }
  for (const [agentId, s] of spans) {
    const note = notices.get(agentId);
    const end = note != null && note.ms != null && (s.last == null || note.ms > s.last) ? note.ms : s.last;
    merge(records, {
      agentId, toolCallId: null,
      agentType: note == null ? null : note.agentType,
      agentName: note == null ? null : note.agentName,
      parentTaskId: null, spawnDepth: null,
      startedAt: iso(s.first), endedAt: iso(end), source: 'events',
    });
  }

  let eventsKnowAgents = evidence;
  for (const r of records.values()) if (r.source === 'events') eventsKnowAgents = true;
  const markers = Array.isArray(c.subagentMarkers) ? c.subagentMarkers : readSubagentMarkers(c.sessionId);
  applyMarkers(records, markers, eventsKnowAgents);
  resolveDepths(records);

  const out = [];
  for (const r of records.values()) if (r.startedAt != null) out.push(r);
  out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return out.length > MAX_AGENTS ? out.slice(-MAX_AGENTS) : out;
}

export function subagentStateMap(list) {
  const map = {};
  for (const r of Array.isArray(list) ? list : []) {
    if (r != null && text(r.agentId) != null && r.agentId !== '__proto__') map[r.agentId] = r;
  }
  return map;
}
