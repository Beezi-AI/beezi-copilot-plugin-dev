import { canonicalToolName, tsMs } from './collectors/operations.mjs';
import { collectSubagents } from './collectors/subagents.mjs';
import { EVENT_TYPES, dataOf, isHumanPrompt } from '../sources/cli/event-types.mjs';
import { IDLE_GAP_SEC } from './segment-stats.mjs';

export const BREAK_GAP_SEC = 6 * 60 * 60;
const MIN_HUMAN_WAIT_MS = 1000;
const MAX_SUBAGENTS = 1000;
// The server's caps on periods and plan events: one more 400s the whole timeline, so a marathon session keeps its newest.
const MAX_PERIODS = 5000;
const MAX_PLAN_EVENTS = 1000;

const STATE ={ WORKING: 'working', PLANNING: 'planning', WAITING_USER: 'waiting_user', IDLE: 'idle', BREAK: 'break' };
const WAITING = {
  PLAN_APPROVAL: 'plan_approval',
  QUESTION_ANSWER: 'question_answer',
  COMMAND_APPROVAL: 'command_approval',
  NEXT_INSTRUCTION: 'next_instruction',
};
const UNATTENDED_MODES = { 'allow-all': true, dontAsk: true, bypassPermissions: true };
const NON_ANCHOR = {
  'session.start': true, 'session.resume': true, 'session.shutdown': true,
  'session.usage_checkpoint': true, 'session.context_changed': true, 'session.model_change': true,
  'session.mode_changed': true, 'session.info': true, 'session.warning': true,
  'hook.start': true, 'hook.end': true, 'system.message': true,
};

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPlanMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase().indexOf('plan') !== -1;
}

function modeOf(e) {
  const d = dataOf(e);
  if (e.type === 'session.mode_changed' && typeof d.newMode === 'string') return d.newMode;
  if (e.type === 'user.message' && e.agentId == null && typeof d.agentMode === 'string') return d.agentMode;
  return null;
}

// Steering and queued messages arrive mid-work, so only an idle delivery ends a human wait.
function isPrompt(e) {
  if (!isHumanPrompt(e)) return false;
  const delivery = dataOf(e).delivery;
  return delivery == null || delivery === 'idle';
}

function isBackgroundNotice(e) {
  return e.type === 'system.notification' && e.agentId == null;
}

function isPlanTool(e) {
  return e.type === 'tool.execution_start' && e.agentId == null && canonicalToolName(dataOf(e).toolName) === 'ExitPlanMode';
}

// Answered waits: decisions (completion → subtype), opens (permission requests), edges (both ends, any thread).
function humanWaits(events) {
  const openTools = new Map();
  const openPerms = new Map();
  const decisions = new Map();
  const opens = new Set();
  const edges = new Set();
  let permissionEvents = false;
  let mode = 'interactive';
  for (const e of events) {
    const d = dataOf(e);
    const ms = tsMs(e);
    const m = modeOf(e);
    if (m != null) mode = m;
    if (e.type === 'tool.execution_start' && typeof d.toolCallId === 'string') {
      const name = canonicalToolName(d.toolName);
      // Autopilot answers its own questions.
      if (name === 'AskUserQuestion' && mode !== 'autopilot') openTools.set(d.toolCallId, { event: e, ms, subtype: WAITING.QUESTION_ANSWER });
      else if (name === 'ExitPlanMode') openTools.set(d.toolCallId, { event: e, ms, subtype: WAITING.PLAN_APPROVAL });
    } else if (e.type === 'tool.execution_complete' && openTools.has(d.toolCallId)) {
      const open = openTools.get(d.toolCallId);
      openTools.delete(d.toolCallId);
      if (d.success !== false && ms != null && open.ms != null && ms - open.ms >= MIN_HUMAN_WAIT_MS) {
        decisions.set(e, open.subtype);
        edges.add(open.event);
        edges.add(e);
      }
    } else if (e.type === 'permission.requested') {
      permissionEvents = true;
      if (typeof d.requestId === 'string' && d.resolvedByHook !== true && UNATTENDED_MODES[d.permissionMode] !== true) {
        openPerms.set(d.requestId, { event: e, ms });
      }
    } else if (e.type === 'permission.completed') {
      permissionEvents = true;
      const open = openPerms.get(d.requestId);
      if (open == null) continue;
      openPerms.delete(d.requestId);
      // The SDK reads an absent decisionSource as "not a human decision".
      const human = d.decisionSource === 'human_response';
      if (human && ms != null && open.ms != null && ms - open.ms >= MIN_HUMAN_WAIT_MS) {
        opens.add(open.event);
        edges.add(open.event);
        edges.add(e);
      }
    }
  }
  return { decisions, opens, edges, permissionEvents };
}

// Without a plan tool, leaving plan mode after the plan file was written is the approval.
function planExits(events, hasPlanTool) {
  const exits = new Set();
  if (hasPlanTool) return exits;
  let written = false;
  for (const e of events) {
    const d = dataOf(e);
    if (e.type === 'session.plan_changed' && d.operation !== 'delete') written = true;
    if (e.type !== 'session.mode_changed') continue;
    if (isPlanMode(d.previousMode) && !isPlanMode(d.newMode) && written) exits.add(e);
    if (isPlanMode(d.newMode) !== isPlanMode(d.previousMode)) written = false;
  }
  return exits;
}

function buildAnchors(events, waits, exits) {
  let mode = 'interactive';
  const anchors = [];
  for (const e of events) {
    const m = modeOf(e);
    if (m != null) mode = m;
    const human = waits.edges.has(e) || exits.has(e);
    if (!human && (e.agentId != null || NON_ANCHOR[e.type] === true)) continue;
    const ms = tsMs(e);
    if (ms == null) continue;
    anchors.push({
      ts: ms,
      isPrompt: isPrompt(e),
      isBackground: isBackgroundNotice(e),
      decisionKind: waits.decisions.has(e) ? waits.decisions.get(e) : (exits.has(e) ? WAITING.PLAN_APPROVAL : null),
      opensWait: waits.opens.has(e),
      mode,
    });
  }
  anchors.sort((a, b) => a.ts - b.ts);
  return anchors;
}

function precedingIndex(anchors, ts) {
  let found = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].ts > ts) break;
    found = i;
  }
  return found;
}

// Stamped points where allow-all permissions turned on or off, oldest first; the state before the first is off.
function allowAllPoints(events) {
  const points = [];
  for (const e of events) {
    if (e.type !== EVENT_TYPES.PERMISSIONS_CHANGED) continue;
    const ms = tsMs(e);
    const d = dataOf(e);
    if (ms != null) points.push({ ms, on: d.allowAllPermissions === true || d.allowAllPermissionMode === 'on' });
  }
  return points.sort((a, b) => a.ms - b.ms);
}

function allowAllAt(points, ms) {
  let on = false;
  for (const p of points) {
    if (p.ms > ms) break;
    on = p.on;
  }
  return on;
}

// The hook fires for every call, auto-approved ones included, so a marker opens a wait only in an attended session.
function applyPermissionMarkers(anchors, markers, allowAll) {
  if (!Array.isArray(markers) || markers.length === 0 || anchors.length < 2) return;
  const firstTs = anchors[0].ts;
  const lastTs = anchors[anchors.length - 1].ts;
  const injected = [];
  let lastIdx = -1;
  for (const m of markers) {
    if (m == null || !Number.isFinite(m.ts)) continue;
    const name = canonicalToolName(m.toolName);
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode') continue;
    if (m.permissionMode != null && UNATTENDED_MODES[m.permissionMode] === true) continue;
    if (m.ts <= firstTs || m.ts >= lastTs || allowAllAt(allowAll, m.ts)) continue;
    const idx = precedingIndex(anchors, m.ts);
    if (idx === -1 || idx === lastIdx || m.ts <= anchors[idx].ts || anchors[idx].mode === 'autopilot') continue;
    if (anchors[idx + 1].ts - m.ts < MIN_HUMAN_WAIT_MS) continue;
    injected.push({ ts: m.ts, isPrompt: false, isBackground: false, decisionKind: null, opensWait: true, mode: anchors[idx].mode });
    lastIdx = idx;
  }
  for (const a of injected) anchors.push(a);
  anchors.sort((a, b) => a.ts - b.ts);
}

function buildPeriods(anchors) {
  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    const gap = cur.ts - prev.ts;
    let state;
    let subtype = null;
    if (cur.isBackground) state = STATE.IDLE;
    else if (gap >= BREAK_GAP_SEC * 1000) state = STATE.BREAK;
    else if (cur.isPrompt) { state = STATE.WAITING_USER; subtype = WAITING.NEXT_INSTRUCTION; }
    else if (cur.decisionKind != null) { state = STATE.WAITING_USER; subtype = cur.decisionKind; }
    else if (prev.opensWait) { state = STATE.WAITING_USER; subtype = WAITING.COMMAND_APPROVAL; }
    else if (gap >= IDLE_GAP_SEC * 1000) state = STATE.IDLE;
    else state = isPlanMode(cur.mode) ? STATE.PLANNING : STATE.WORKING;
    const last = merged[merged.length - 1];
    if (last && last.state === state && last.subtype === subtype) last.endMs = cur.ts;
    else merged.push({ state, subtype, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => {
    const period = { state: m.state, started_at: iso(m.startMs), ended_at: iso(m.endMs) };
    // An absent subtype means "older plugin" to the server, so the key is never sent empty.
    if (m.state === STATE.WAITING_USER && m.subtype != null) period.waiting_subtype = m.subtype;
    return period;
  });
}

function buildPlanEvents(events, hasPlanTool) {
  const out = [];
  let inPlan = false;
  let lastWrite = null;
  const close = () => {
    if (!hasPlanTool && lastWrite != null) out.push({ type: 'plan_ready', at: iso(lastWrite) });
    lastWrite = null;
  };
  for (const e of events) {
    const ms = tsMs(e);
    const m = modeOf(e);
    if (m != null) {
      const now = isPlanMode(m);
      if (now && !inPlan && ms != null) out.push({ type: 'plan_start', at: iso(ms) });
      if (!now && inPlan) close();
      inPlan = now;
    }
    if (ms == null) continue;
    if (inPlan && e.type === 'session.plan_changed' && dataOf(e).operation !== 'delete') lastWrite = ms;
    if (hasPlanTool && isPlanTool(e)) out.push({ type: 'plan_ready', at: iso(ms) });
  }
  close();
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out.length > MAX_PLAN_EVENTS ? out.slice(-MAX_PLAN_EVENTS) : out;
}

function subagentLanes(events, markers, fallbackEndMs) {
  let list = [];
  try { list = collectSubagents(events, { state: null, subagentMarkers: markers }); } catch { list = []; }
  const out = [];
  for (const s of list) {
    const start = Date.parse(s.startedAt);
    if (!Number.isFinite(start)) continue;
    const endRaw = typeof s.endedAt === 'string' ? Date.parse(s.endedAt) : NaN;
    const end = Number.isFinite(endRaw) ? endRaw : fallbackEndMs;
    out.push({
      agent_id: String(s.agentId).slice(0, 200),
      agent_type: s.agentType == null ? null : String(s.agentType).slice(0, 100),
      started_at: iso(start),
      ended_at: iso(Math.max(start, end)),
    });
  }
  out.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  return out.slice(0, MAX_SUBAGENTS);
}

function markersOr(given) {
  return Array.isArray(given) ? given : [];
}

// markers: { permissions, subagents } hook marker lists the caller read; a missing list counts as empty.
export function buildTimeline(sessionId, events, markers) {
  const all = Array.isArray(events) ? events : [];
  const first = all.findIndex(isPrompt);
  if (first === -1) return null;
  const list = all.slice(first);
  // A bare array is the permission-marker list.
  const mk = Array.isArray(markers) ? { permissions: markers } : (markers == null ? {} : markers);
  const permissionMarkers = markersOr(mk.permissions);
  const subagentMarkers = markersOr(mk.subagents);

  const hasPlanTool = list.some(isPlanTool);
  const waits = humanWaits(list);
  const anchors = buildAnchors(list, waits, planExits(list, hasPlanTool));
  if (!waits.permissionEvents) applyPermissionMarkers(anchors, permissionMarkers, allowAllPoints(all));
  if (anchors.length === 0) return null;

  const built = buildPeriods(anchors);
  const periods = built.length > MAX_PERIODS ? built.slice(-MAX_PERIODS) : built;
  let minTs = built.length > MAX_PERIODS ? Date.parse(periods[0].started_at) : anchors[0].ts;
  let maxTs = anchors[anchors.length - 1].ts;
  const subagents = subagentLanes(all, subagentMarkers, maxTs);
  for (const s of subagents) {
    const a = Date.parse(s.started_at);
    const b = Date.parse(s.ended_at);
    if (a < minTs) minTs = a;
    if (b > maxTs) maxTs = b;
  }
  return {
    sessionId,
    periods,
    plan_events: buildPlanEvents(list, hasPlanTool),
    subagents,
    started_at: iso(minTs),
    ended_at: iso(maxTs),
    generated_at: new Date().toISOString(),
  };
}
