import { EVENT_TYPES, findShutdowns } from './copilot-events.mjs';
import { pathSignalOf } from './repo-timeline.mjs';
import { buildActiveIntervals, totalMs } from './active-time.mjs';

// Gaps longer than this between two activity events count as idle, not active time.
export const IDLE_GAP_SEC = 300;

// The server's effort column is varchar(50); a longer key 400s the whole segment.
const MAX_EFFORT_KEY = 50;
const MAX_CONTEXT_MODEL = 100;

// Stamped by the runtime at exit or load rather than by work, so they never stretch a segment's span.
const NON_ANCHOR_TYPES = [
  'session.shutdown', 'session.usage_checkpoint', 'hook.start', 'hook.end', 'session.skills_loaded',
  'session.mcp_servers_loaded', 'session.mcp_server_status_changed', 'session.tools_updated',
  'session.custom_agents_updated', 'session.extensions_loaded', 'commands.changed', 'capabilities.changed',
  'session.info', 'session.warning',
];

export function isTimingAnchor(event) {
  return event != null && NON_ANCHOR_TYPES.indexOf(event.type) === -1;
}

function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function n(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

// True when the host sent the field at all: a measured 0 differs from a value it never reported.
function isReported(v) {
  return typeof v === 'number' && isFinite(v);
}

function isPlain(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clampInt(v) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(v)));
}

// The event's working-directory context: main-stream session start/resume, or a context change.
function contextOf(ev) {
  if (ev.type === EVENT_TYPES.CONTEXT_CHANGED) return ev.data;
  if (ev.type === EVENT_TYPES.SESSION_START || ev.type === EVENT_TYPES.SESSION_RESUME) return ev.data.context;
  return null;
}

// A model name, or null for the router placeholder "auto", which never bills under its own name.
function modelName(v) {
  const s = str(v);
  return s != null && s.trim().toLowerCase() === 'auto' ? null : s;
}

// The model an event names, so a zero-usage segment can still name the active one.
function modelOf(ev) {
  const d = ev.data;
  switch (ev.type) {
    case EVENT_TYPES.SESSION_START:
    case EVENT_TYPES.SESSION_RESUME:
      return modelName(d.selectedModel);
    case EVENT_TYPES.AUTO_MODE_RESOLVED:
      return modelName(d.chosenModel);
    case EVENT_TYPES.MODEL_CHANGE:
      return modelName(d.newModel);
    case EVENT_TYPES.TURN_START:
    case EVENT_TYPES.TURN_END:
    case EVENT_TYPES.ASSISTANT_MESSAGE:
      return modelName(d.model);
    default:
      return null;
  }
}

function newWork(sessionId, agentId, repoRoot, branch, line) {
  return {
    segment: { sessionId, agentId, fromLine: line, toLine: line, repoRoot, remote: null, branch, startedAt: null, endedAt: null },
    events: [],
    timestamps: [],
    anchors: [],
    unclosedStamps: [],
    activeModel: null,
    models: {},
    sessionNano: 0,
    context: null,
    contextPeakHint: 0,
  };
}

function addEvent(work, ev, ms, model) {
  work.segment.toLine = ev.line;
  work.events.push(ev);
  if (Number.isFinite(ms)) {
    work.timestamps.push(ms);
    if (isTimingAnchor(ev)) work.anchors.push(ms);
    if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN) work.unclosedStamps.push(ms);
  }
  if (model) work.activeModel = model;
  if (work.segment.agentId == null) {
    const d = ev.data;
    if (ev.type === EVENT_TYPES.COMPACTION_START && typeof d.currentTokens === 'number' && isFinite(d.currentTokens)) {
      work.contextPeakHint = Math.max(work.contextPeakHint, d.currentTokens);
    } else if (ev.type === EVENT_TYPES.COMPACTION_COMPLETE && typeof d.preCompactionTokens === 'number' && isFinite(d.preCompactionTokens)) {
      work.contextPeakHint = Math.max(work.contextPeakHint, d.preCompactionTokens);
    }
  }
}

// The span is the extremes of the anchor stamps; a run holding only bookkeeping falls back to its stamps other than shutdowns.
function finishRun(work) {
  const stamps = work.anchors.length > 0 ? work.anchors : (work.unclosedStamps.length > 0 ? work.unclosedStamps : work.timestamps);
  if (stamps.length === 0) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of stamps) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  work.segment.startedAt = new Date(lo).toISOString();
  work.segment.endedAt = new Date(hi).toISOString();
}

// Main-stream works partition [fromLine+1, toLine] so coverage stays contiguous.
function partitionMain(main, o) {
  const works = main.works;
  if (works.length === 0) {
    const empty = newWork(o.sessionId, null, o.root, o.branch, o.fromLine + 1);
    empty.segment.toLine = o.toLine;
    empty.activeModel = o.model;
    works.push(empty);
    return;
  }
  works[0].segment.fromLine = o.fromLine + 1;
  for (let i = 1; i < works.length; i++) works[i].segment.fromLine = works[i - 1].segment.toLine + 1;
  works[works.length - 1].segment.toLine = o.toLine;
}

// Splits (fromLine, toLine] into runs of one (repo root, branch) per stream: the main stream and each envelope agentId.
export function buildSegments(allEvents, opts) {
  const { sessionId, fromLine, toLine } = opts;
  if (!(toLine > fromLine)) return [];
  const repoRootOf = opts.repoRootOf == null ? ((d) => d) : opts.repoRootOf;
  const contextBranch = new Map();
  // Reflog at the stamp, then the branch the session itself recorded, then today's HEAD (Plan 04 order).
  const branchFor = (root, ms) => {
    if (!root) return '(unknown)';
    const b = opts.branchAt != null ? opts.branchAt(root, ms) : null;
    if (b && b !== '(unknown)') return b;
    const c = contextBranch.get(root);
    if (c != null) return c;
    const h = opts.headBranchOf != null ? opts.headBranchOf(root) : null;
    return h && h !== '(unknown)' ? h : '(unknown)';
  };
  const seedCwd = typeof opts.cwd === 'string' && opts.cwd ? norm(opts.cwd) : null;
  const main = { cwd: seedCwd, root: seedCwd ? repoRootOf(seedCwd) : null, model: null, pending: [], run: null, works: [] };
  const streams = new Map([['', main]]);
  const close = (s) => {
    if (s.run) {
      finishRun(s.run);
      s.works.push(s.run);
      s.run = null;
    }
  };
  // Newest pre-window signal that resolves wins; one git call in the common case.
  const settle = (s) => {
    for (let i = s.pending.length - 1; i >= 0; i--) {
      const root = repoRootOf(s.pending[i]);
      if (root) { s.root = root; break; }
    }
    s.pending = [];
  };

  for (const ev of allEvents) {
    if (ev.line > toLine) break;
    const key = ev.agentId == null ? '' : ev.agentId;
    let s = streams.get(key);
    if (!s) {
      settle(main);
      s = { cwd: main.cwd, root: main.root, model: null, pending: [], run: null, works: [] };
      streams.set(key, s);
    }
    const ctx = key === '' ? contextOf(ev) : null;
    // A preliminary change (pendingGitContext) is ignored: its settled follow-up always comes.
    if (ctx != null && ctx.pendingGitContext !== true && typeof ctx.cwd === 'string' && ctx.cwd) {
      s.cwd = norm(ctx.cwd);
      s.pending = [];
      const root = typeof ctx.gitRoot === 'string' && ctx.gitRoot ? norm(ctx.gitRoot) : repoRootOf(s.cwd);
      if (root) {
        s.root = root;
        if (typeof ctx.branch === 'string' && ctx.branch) contextBranch.set(root, ctx.branch);
      }
    }
    const named = modelOf(ev);
    if (named) s.model = named;
    const dir = pathSignalOf(ev, s.cwd);
    if (ev.line <= fromLine) {
      if (dir && s.pending[s.pending.length - 1] !== dir) s.pending.push(dir);
      continue;
    }
    if (s.pending.length) settle(s);
    if (dir) {
      const root = repoRootOf(dir);
      if (root) s.root = root;
    }
    const ms = ev.timestamp == null ? NaN : Date.parse(ev.timestamp);
    const branch = branchFor(s.root, Number.isFinite(ms) ? ms : null);
    if (!s.run || s.run.segment.repoRoot !== s.root || s.run.segment.branch !== branch) {
      close(s);
      s.run = newWork(sessionId, key === '' ? null : key, s.root, branch, ev.line);
    }
    addEvent(s.run, ev, ms, s.model);
  }
  for (const s of streams.values()) close(s);
  settle(main);
  partitionMain(main, { sessionId, fromLine, toLine, root: main.root, branch: branchFor(main.root, null), model: main.model });
  const out = main.works.slice();
  for (const [key, s] of streams) if (key !== '') out.push(...s.works);
  return out;
}

function bucket() {
  return { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0 };
}

function effortKey(e) {
  return typeof e === 'string' && e !== '' ? e.slice(0, MAX_EFFORT_KEY) : 'unknown';
}

// inputTokens is the whole prompt including cache reads and writes, so uncached input is the remainder; output already includes reasoning.
function normalize(input, output, cacheRead, cacheWrite) {
  const prompt = n(input);
  const cr = n(cacheRead);
  const cw = n(cacheWrite);
  return { input: Math.max(0, prompt - cr - cw), output: n(output), cacheRead: cr, cacheWrite: cw, prompt };
}

// One tally for the model and its effort bucket, so the buckets always partition the model. A null `nano` or
// `premium` means the host never reported that measure; a number, even 0, is a measured value and is kept.
function tally(models, model, effort, t) {
  if (!own(models, model)) models[model] = bucket();
  const m = models[model];
  if (m.by_effort == null) m.by_effort = {};
  if (!own(m.by_effort, effort)) m.by_effort[effort] = bucket();
  for (const b of [m, m.by_effort[effort]]) {
    b.token_input += t.input;
    b.token_output += t.output;
    b.token_cache_read += t.cacheRead;
    b.token_cache_creation += t.cacheWrite;
    b.requests += t.requests;
  }
  if (t.nano != null) m.ai_credits_nano = (m.ai_credits_nano == null ? 0 : m.ai_credits_nano) + t.nano;
  if (t.premium != null) m.premium_requests = (m.premium_requests == null ? 0 : m.premium_requests) + t.premium;
}

function streamKey(work) {
  return work.segment.agentId == null ? '' : work.segment.agentId;
}

function firstStamp(work) {
  let lo = Infinity;
  for (const t of work.timestamps) if (t < lo) lo = t;
  // An event-less work covers its whole window.
  return work.timestamps.length === 0 ? -Infinity : lo;
}

// Per-call join (V-09 default: row timestamp). Consumes rows as a contiguous prefix bounded to the window; may push empty subagent works.
export function attributeRows(works, rows, allEvents, opts = {}) {
  const horizonMs = opts.horizonMs == null ? Infinity : opts.horizonMs;
  const { finalize = false, allowLate = true, windowFromLine = 0, windowToLine = 0, floorMs = -Infinity } = opts;
  const streams = new Map();
  let windowStart = Infinity;
  for (const w of works) {
    const key = streamKey(w);
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(w);
    for (const t of w.timestamps) if (t < windowStart) windowStart = t;
  }
  for (const list of streams.values()) list.sort((a, b) => a.segment.fromLine - b.segment.fromLine);

  let lastRowId = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row.agentId == null ? '' : row.agentId;
    const t = row.at == null ? NaN : Date.parse(row.at);
    // A row created before the establishing window is already held by the server: consumed, never billed.
    if (t < floorMs) {
      lastRowId = row.rowId;
      continue;
    }
    // A row past the horizon may belong to lines not yet written: it and everything after wait.
    if (t > horizonMs && !finalize) break;
    let list = streams.get(key);
    if (list == null) {
      const mains = streams.get('');
      if (mains == null || mains.length === 0) break;
      // A subagent's rows never fall back to the parent (R-04): give it an empty work over the window.
      const anchor = mains[mains.length - 1];
      const empty = newWork(anchor.segment.sessionId, key, anchor.segment.repoRoot, anchor.segment.branch, windowFromLine + 1);
      empty.segment.toLine = windowToLine;
      works.push(empty);
      list = [empty];
      streams.set(key, list);
    }
    if (list.length === 0) break;
    lastRowId = row.rowId;
    let target = null;
    if (t < windowStart) {
      // Late: it maps before this window. Live runs bill it to the stream's first work; an audit drops it.
      if (!allowLate) continue;
      target = list[0];
    } else {
      for (const w of list) if (firstStamp(w) <= t) target = w;
      if (target == null) target = list[0];
    }
    const u = normalize(row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens);
    // Only user-initiated calls bill their request_multiplier; sub-agent and other initiators cost 0.
    const premium = row.initiator == null || row.requestMultiplier == null ? null : (row.initiator === 'user' ? row.requestMultiplier : 0);
    const model = modelName(row.model) || 'unknown';
    tally(target.models, model, effortKey(row.reasoningEffort), { ...u, requests: 1, nano: isReported(row.nanoAiu) ? n(row.nanoAiu) : null, premium });
    if (key === '') {
      const peak = target.context == null ? 0 : target.context.peak;
      target.context = { peak: Math.max(peak, u.prompt), final: u.prompt, model };
    }
  }
  return { lastRowId };
}

function metricOf(m) {
  const u = isPlain(m) && isPlain(m.usage) ? m.usage : {};
  const r = isPlain(m) && isPlain(m.requests) ? m.requests : {};
  return {
    input: n(u.inputTokens),
    output: n(u.outputTokens),
    cacheRead: n(u.cacheReadTokens),
    cacheWrite: n(u.cacheWriteTokens),
    count: n(r.count),
    cost: n(r.cost),
    hasCost: isReported(r.cost),
    nano: isPlain(m) ? n(m.totalNanoAiu) : 0,
    hasNano: isPlain(m) && isReported(m.totalNanoAiu),
  };
}

const ACTIVITY_TYPES = [EVENT_TYPES.USER_MESSAGE, EVENT_TYPES.TURN_START, EVENT_TYPES.ASSISTANT_MESSAGE, EVENT_TYPES.TOOL_START];

// A prompt, turn, reply or tool call in any stream, or a shutdown that measured tokens or credits; currentTokens is context size, not usage.
export function hasActivity(events) {
  for (const ev of Array.isArray(events) ? events : []) {
    if (ACTIVITY_TYPES.indexOf(ev.type) !== -1) return true;
    if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN) continue;
    if (n(ev.data.totalNanoAiu) > 0) return true;
    const models = isPlain(ev.data.modelMetrics) ? ev.data.modelMetrics : {};
    for (const name of Object.keys(models)) {
      const m = metricOf(models[name]);
      if (m.input + m.output + m.cacheRead + m.cacheWrite + m.nano > 0) return true;
    }
  }
  return false;
}

// Field by field, clamped at 0.
function subtract(a, b) {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    count: Math.max(0, a.count - b.count),
    cost: Math.max(0, a.cost - b.cost),
    nano: Math.max(0, a.nano - b.nano),
  };
}

// The key a billed shutdown is remembered under: its event id, or its line when the record carried none.
export function shutdownKey(ref) {
  return ref.id != null ? ref.id : `line:${ref.line}`;
}

// Each model's tally from `before` to `current`, leaving out models whose delta is all zero.
function modelDeltas(current, before) {
  const out = [];
  for (const name of Object.keys(current)) {
    const now = metricOf(current[name]);
    // V-08 default: totals are cumulative across resume, so each shutdown bills its difference from the previous one in the file.
    const d = subtract(now, metricOf(before[name]));
    const t = normalize(d.input, d.output, d.cacheRead, d.cacheWrite);
    if (t.input + t.output + t.cacheRead + t.cacheWrite + d.count + d.cost + d.nano === 0) continue;
    out.push({ name, t: { ...t, requests: d.count, premium: now.hasCost ? d.cost : null, nano: now.hasNano ? d.nano : null } });
  }
  return out;
}

const SPLIT_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'count'];

// One agent's modelMetrics from a shutdown's agentMetrics, or {} when it reported none.
function agentModels(data, agent) {
  const a = isPlain(data.agentMetrics) ? data.agentMetrics[agent] : null;
  return isPlain(a) && isPlain(a.modelMetrics) ? a.modelMetrics : {};
}

// True when, for every model, agentMetrics summed over agents equals modelMetrics on tokens and request count.
function agentSplitHolds(data) {
  if (!isPlain(data.agentMetrics)) return false;
  const total = isPlain(data.modelMetrics) ? data.modelMetrics : {};
  const sums = new Map();
  for (const agent of Object.keys(data.agentMetrics)) {
    if (!isPlain(data.agentMetrics[agent])) return false;
    const models = agentModels(data, agent);
    for (const name of Object.keys(models)) {
      const m = metricOf(models[name]);
      const s = sums.get(name);
      if (s == null) sums.set(name, m);
      else for (const f of SPLIT_FIELDS) s[f] += m[f];
    }
  }
  for (const name of Object.keys(total)) if (!sums.has(name)) sums.set(name, metricOf(null));
  for (const [name, s] of sums) {
    const t = metricOf(own(total, name) ? total[name] : null);
    for (const f of SPLIT_FIELDS) if (s[f] !== t[f]) return false;
  }
  return true;
}

// A zero-duration subagent work at the shutdown line, for an agent whose events ended before this window.
function shutdownShare(holder, agentId, ev) {
  const w = newWork(holder.segment.sessionId, agentId, holder.segment.repoRoot, holder.segment.branch, ev.line);
  const ms = ev.timestamp == null ? NaN : Date.parse(ev.timestamp);
  if (Number.isFinite(ms)) {
    w.segment.startedAt = new Date(ms).toISOString();
    w.segment.endedAt = w.segment.startedAt;
  }
  w.shutdownShare = true;
  return w;
}

// The subagent's latest work in the window that starts before the shutdown, else a new one appended to `works`.
function shareTarget(works, holder, agentId, ev) {
  let target = null;
  for (const w of works) if (w.segment.agentId === agentId && w.segment.fromLine < ev.line) target = w;
  if (target == null) {
    target = shutdownShare(holder, agentId, ev);
    works.push(target);
  }
  return target;
}

function billShutdown(work, ev, prev, works) {
  const data = ev.data;
  const current = isPlain(data.modelMetrics) ? data.modelMetrics : {};
  const before = prev != null && isPlain(prev.data.modelMetrics) ? prev.data.modelMetrics : {};
  let anyModelNano = false;
  for (const name of Object.keys(current)) if (metricOf(current[name]).hasNano) anyModelNano = true;
  // Per-agent split only when this shutdown's split is consistent and the previous one has a split to diff against.
  if (agentSplitHolds(data) && (prev == null || isPlain(prev.data.agentMetrics))) {
    for (const agent of Object.keys(data.agentMetrics)) {
      const deltas = modelDeltas(agentModels(data, agent), prev == null ? {} : agentModels(prev.data, agent));
      if (deltas.length === 0) continue;
      const target = agent === 'main' ? work : shareTarget(works, work, agent, ev);
      for (const x of deltas) tally(target.models, x.name, 'unknown', x.t);
    }
  } else {
    for (const x of modelDeltas(current, before)) tally(work.models, x.name, 'unknown', x.t);
  }
  if (!anyModelNano) {
    work.sessionNano += Math.max(0, n(data.totalNanoAiu) - (prev == null ? 0 : n(prev.data.totalNanoAiu)));
  }
  if (typeof data.currentTokens === 'number' && isFinite(data.currentTokens)) {
    const final = Math.max(0, data.currentTokens);
    work.context = {
      peak: Math.max(final, work.contextPeakHint),
      final,
      model: modelName(data.currentModel) || work.activeModel || 'unknown',
    };
  }
}

// Session-totals mode: each unreported main-stream shutdown bills main's usage to the work holding it and each subagent's share to that subagent's work.
export function attributeShutdowns(works, allEvents, { skipIds = [] } = {}) {
  const skip = skipIds instanceof Set ? skipIds : new Set(skipIds);
  const shutdowns = findShutdowns(allEvents);
  const reported = [];
  for (const work of works) {
    if (work.segment.agentId != null) continue;
    for (const ev of work.events) {
      if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN || ev.agentId != null) continue;
      if (skip.has(shutdownKey(ev))) continue;
      // The previous shutdown comes from the file even when it lies below the cursor (R-04d).
      let prev = null;
      for (const s of shutdowns) {
        if (s.line >= ev.line) break;
        prev = s;
      }
      billShutdown(work, ev, prev, works);
      reported.push({ line: ev.line, id: ev.id });
    }
  }
  return { reported };
}

function copyModels(models) {
  const out = {};
  for (const name of Object.keys(models)) {
    const m = models[name];
    const c = {
      token_input: m.token_input,
      token_output: m.token_output,
      token_cache_read: m.token_cache_read,
      token_cache_creation: m.token_cache_creation,
      requests: m.requests,
    };
    if (m.by_effort != null) {
      c.by_effort = {};
      for (const e of Object.keys(m.by_effort)) {
        const b = m.by_effort[e];
        c.by_effort[e] = {
          token_input: b.token_input,
          token_output: b.token_output,
          token_cache_read: b.token_cache_read,
          token_cache_creation: b.token_cache_creation,
          requests: b.requests,
        };
      }
    }
    // Integers only (Plan 08 A4); premium requests may be fractional. A measured 0 is sent, so the portal prices that
    // model at 0 instead of falling back to token list price; a measure the host never reported stays absent.
    // The portal tries credits before requests, so a credits 0 never travels beside positive premium requests.
    const credits = m.ai_credits_nano == null ? null : clampInt(m.ai_credits_nano);
    const premium = m.premium_requests == null ? null : m.premium_requests;
    if (credits != null && !(credits === 0 && premium != null && premium > 0)) c.ai_credits_nano = credits;
    if (premium != null) c.premium_requests = premium;
    out[name] = c;
  }
  return out;
}

// The report stats for one work, without code_changes and operations; duration_sec is refilled by the caller after the cross-stream subtraction.
export function segmentStats(work, { includeContext = false } = {}) {
  const models = copyModels(work.models);
  // The server stores nothing for `models: {}`, so a zero-usage segment names the active model with zero counters (Plan 08 A3).
  if (Object.keys(models).length === 0) {
    models[work.activeModel || 'unknown'] = { ...bucket(), by_effort: { unknown: bucket() } };
  }
  let input = 0;
  let output = 0;
  let cache = 0;
  let credits = 0;
  for (const name of Object.keys(models)) {
    const m = models[name];
    input += m.token_input;
    output += m.token_output;
    cache += m.token_cache_read + m.token_cache_creation;
    if (m.ai_credits_nano != null) credits += m.ai_credits_nano;
  }
  const activeIntervals = work.anchors.length ? buildActiveIntervals(work.timestamps, IDLE_GAP_SEC * 1000) : [];
  const stats = {
    models,
    token_total: input + output + cache,
    token_input: input,
    token_output: output,
    token_cache: cache,
    duration_sec: Math.round(totalMs(activeIntervals) / 1000),
    started_at: work.segment.startedAt,
    ended_at: work.segment.endedAt,
  };
  // The segment total is the sum of the per-model integers, else the session-level total.
  const total = credits > 0 ? Math.min(Number.MAX_SAFE_INTEGER, credits) : (work.sessionNano > 0 ? clampInt(work.sessionNano) : 0);
  if (total > 0) stats.ai_credits_nano = total;
  if (includeContext && work.context != null) {
    stats.context_peak_tokens = Math.round(work.context.peak);
    stats.context_final_tokens = Math.round(work.context.final);
    stats.context_final_model = String(work.context.model).slice(0, MAX_CONTEXT_MODEL);
  }
  return { stats, activeIntervals };
}
