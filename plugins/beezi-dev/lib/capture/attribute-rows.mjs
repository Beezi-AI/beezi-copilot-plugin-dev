// Owns the per-call join: session-store usage rows billed to the work of their stream that was active at the row's stamp.
import { modelName } from '../core/model-names.mjs';
import { isAutoAt } from './auto-selection.mjs';
import { observeCall, emptyCold, addCold, callStartMs } from './cold-prefix.mjs';
import { newWork } from './segment-stats.mjs';
import { effortKey, isReported, normalize, positive, tally } from './usage-tally.mjs';
import { isPlain } from '../core/guards.mjs';

function streamKey(work) {
  return work.segment.agentId == null ? '' : work.segment.agentId;
}

// The store's twin rule (one call re-inserted under a new rowid): same stamp, agent, model, tokens, credits and timings.
function twinKey(row) {
  if (row.at == null) return null;
  return [row.at, row.agentId, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens,
    row.nanoAiu, row.durationMs, row.timeToFirstTokenMs].join('|');
}

// Per-call timing peaks of the main stream: the portal keeps the largest of each.
function addTimings(work, row) {
  const ttft = isReported(row.timeToFirstTokenMs) ? positive(row.timeToFirstTokenMs) : null;
  const duration = isReported(row.durationMs) ? positive(row.durationMs) : null;
  if (ttft == null && duration == null) return;
  const t = work.timings == null ? { ttftMs: null, durationMs: null } : work.timings;
  if (ttft != null) t.ttftMs = Math.max(t.ttftMs == null ? 0 : t.ttftMs, ttft);
  if (duration != null) t.durationMs = Math.max(t.durationMs == null ? 0 : t.durationMs, duration);
  work.timings = t;
}

function firstStamp(work) {
  let lo = Infinity;
  for (const t of work.timestamps) if (t < lo) lo = t;
  // An event-less work covers its whole window.
  return work.timestamps.length === 0 ? -Infinity : lo;
}

// Per-call join by row timestamp. Consumes rows as a contiguous prefix bounded to the window; may push empty subagent works.
export function attributeRows(works, rows, allEvents, opts = {}) {
  const horizonMs = opts.horizonMs == null ? Infinity : opts.horizonMs;
  const { finalize = false, allowLate = true, windowFromLine = 0, windowToLine = 0, floorMs = -Infinity, autoPoints = null } = opts;
  // Copy: a failed run must not leave the saved state half-advanced.
  const lastCalls = { ...(isPlain(opts.lastCalls) ? opts.lastCalls : {}) };
  // The cold-prefix counters are a side measure: a failure there is reported, never allowed to lose the row's tokens.
  let coldFailed = false;
  const observe = (...args) => {
    try { return observeCall(lastCalls, ...args); } catch { coldFailed = true; return { switched: false, cold: false, idleCold: false }; }
  };
  const streams = new Map();
  let windowStart = Infinity;
  for (const w of works) {
    const key = streamKey(w);
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(w);
    for (const t of w.timestamps) if (t < windowStart) windowStart = t;
  }
  for (const list of streams.values()) list.sort((a, b) => a.segment.fromLine - b.segment.fromLine);
  // A window with no stamp at all cannot hold a late row.
  if (windowStart === Infinity) windowStart = -Infinity;

  let lastRowId = null;
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row.agentId == null ? '' : row.agentId;
    const t = row.at == null ? NaN : Date.parse(row.at);
    const stamped = Number.isFinite(t);
    const u = normalize(row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens);
    const model = modelName(row.model) || 'unknown';
    const twin = twinKey(row);
    // A twin of a row already read here is consumed and never billed.
    if (twin != null && seen.has(twin)) {
      lastRowId = row.rowId;
      continue;
    }
    if (twin != null) seen.add(twin);
    // A row created before the establishing window is already held by the server: consumed, never billed. A row with
    // no stamp cannot be shown to postdate a floor, so under one it is consumed too.
    if (t < floorMs || (!stamped && floorMs > -Infinity)) {
      lastRowId = row.rowId;
      observe(key === '' ? null : key, t, model, u);
      continue;
    }
    // A row past the horizon may belong to lines not yet written: it and everything after wait. So does a row with no
    // stamp, until the run finalizes.
    if ((t > horizonMs || !stamped) && !finalize) break;
    let list = streams.get(key);
    if (list == null) {
      const mains = streams.get('');
      if (mains == null || mains.length === 0) break;
      // A subagent's rows never fall back to the parent: give it an empty work over the window.
      const anchor = mains[mains.length - 1];
      const empty = newWork(anchor.segment.sessionId, key, anchor.segment.repoRoot, anchor.segment.branch, windowFromLine + 1);
      empty.segment.toLine = windowToLine;
      works.push(empty);
      list = [empty];
      streams.set(key, list);
    }
    if (list.length === 0) break;
    lastRowId = row.rowId;
    // Every consumed row advances the agent's previous call, including late rows an audit drops.
    const call = observe(key === '' ? null : key, t, model, u, row.durationMs);
    let target = null;
    if (!stamped) {
      // Placed only at the end of the run: the stream's newest work.
      target = list[list.length - 1];
    } else if (t < windowStart) {
      // Late: it maps before this window. Live runs bill it to the stream's first work; an audit drops it.
      if (!allowLate) continue;
      target = list[0];
    } else {
      for (const w of list) if (firstStamp(w) <= t) target = w;
      if (target == null) target = list[0];
    }
    // Only user-initiated calls bill their request_multiplier; sub-agent and other initiators cost 0.
    const premium = row.initiator == null || row.requestMultiplier == null ? null : (row.initiator === 'user' ? row.requestMultiplier : 0);
    const nano = isReported(row.nanoAiu) ? positive(row.nanoAiu) : null;
    // Auto is judged on the main stream only; a subagent's call counts as measured and not Auto.
    const isAuto = key === '' && autoPoints != null && isAutoAt(autoPoints, callStartMs(t, row.durationMs));
    tally(target.models, model, effortKey(row.reasoningEffort), {
      ...u,
      requests: 1,
      nano,
      premium,
      reasoning: isReported(row.reasoningTokens) ? positive(row.reasoningTokens) : null,
      auto: autoPoints == null ? null : { requests: isAuto ? 1 : 0, nano: isAuto && nano != null ? nano : null },
    });
    try {
      if (target.cold == null) target.cold = emptyCold();
      addCold(target.cold, call, nano);
    } catch { coldFailed = true; }
    if (key === '') {
      const peak = target.context == null ? 0 : target.context.peak;
      target.context = { peak: Math.max(peak, u.prompt), final: u.prompt, model };
      addTimings(target, row);
    }
  }
  return { lastRowId, lastCalls, coldFailed };
}
