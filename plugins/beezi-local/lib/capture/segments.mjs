// Owns segmentation: splits a window of events into works of one (repo root, branch) per stream.
import { EVENT_TYPES, contextLimitOf } from '../sources/cli/event-types.mjs';
import { isAutoName, modelName } from '../core/model-names.mjs';
import { str } from '../core/guards.mjs';
import { pathSignalOf } from './path-signals.mjs';
import { newWork } from './segment-stats.mjs';

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

// The event's working-directory context: main-stream session start/resume, or a context change.
function contextOf(ev) {
  if (ev.type === EVENT_TYPES.CONTEXT_CHANGED) return ev.data;
  if (ev.type === EVENT_TYPES.SESSION_START || ev.type === EVENT_TYPES.SESSION_RESUME) return ev.data.context;
  return null;
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

// True when the event chose the Auto router rather than a model.
function choosesAuto(ev) {
  const d = ev.data;
  if (ev.type === EVENT_TYPES.SESSION_START || ev.type === EVENT_TYPES.SESSION_RESUME) return isAutoName(d.selectedModel);
  return ev.type === EVENT_TYPES.MODEL_CHANGE && isAutoName(d.newModel);
}

// Main-stream signals the payload keeps for the session: compaction peaks, capacity and the newest abort reason.
function addMainSignals(work, ev) {
  const d = ev.data;
  if (ev.type === EVENT_TYPES.COMPACTION_START && typeof d.currentTokens === 'number' && isFinite(d.currentTokens)) {
    work.contextPeakHint = Math.max(work.contextPeakHint, d.currentTokens);
  } else if (ev.type === EVENT_TYPES.COMPACTION_COMPLETE && typeof d.preCompactionTokens === 'number' && isFinite(d.preCompactionTokens)) {
    work.contextPeakHint = Math.max(work.contextPeakHint, d.preCompactionTokens);
  } else if (ev.type === EVENT_TYPES.ABORT && str(d.reason) != null) {
    work.abortReason = d.reason;
  }
  const limit = contextLimitOf(ev);
  if (limit != null) work.contextWindow = Math.max(work.contextWindow, limit);
}

function addEvent(work, ev, ms, model) {
  work.segment.toLine = ev.line;
  work.events.push(ev);
  if (Number.isFinite(ms)) {
    work.timestamps.push(ms);
    if (isTimingAnchor(ev)) work.anchors.push(ms);
    if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN) work.unclosedStamps.push(ms);
  }
  if (model && model !== work.activeModel) {
    work.modelChanges.push({ line: ev.line, model });
    work.activeModel = model;
  }
  if (work.segment.agentId == null) addMainSignals(work, ev);
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
  const { isDirectory } = opts;
  const contextBranch = new Map();
  // Reflog at the stamp, then the branch the session itself recorded, then today's HEAD.
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
    // A stream that has only chosen Auto names its zero-usage entries `auto`, not `unknown`.
    else if (s.model == null && choosesAuto(ev)) s.model = 'auto';
    const dir = pathSignalOf(ev, s.cwd, isDirectory);
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
