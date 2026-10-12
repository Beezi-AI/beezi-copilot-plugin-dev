// Owns session-totals billing (each shutdown's cumulative tokens diffed against the previous one, credits from the runtime
// counters) and the activity test.
import { EVENT_TYPES, findShutdowns } from '../sources/cli/event-types.mjs';
import { modelName } from '../core/model-names.mjs';
import { modelAtLine, newWork } from './segment-stats.mjs';
import { isReported, normalize, positive, tally } from './usage-tally.mjs';
import {
  checkpointDeltas, creditBaseline, cumulativeCredits, measuresNano, raiseBaseline, validReported,
} from './checkpoint-credits.mjs';
import { isPlain } from '../core/guards.mjs';

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function metricOf(m) {
  const u = isPlain(m) && isPlain(m.usage) ? m.usage : {};
  const r = isPlain(m) && isPlain(m.requests) ? m.requests : {};
  return {
    input: positive(u.inputTokens),
    output: positive(u.outputTokens),
    cacheRead: positive(u.cacheReadTokens),
    cacheWrite: positive(u.cacheWriteTokens),
    count: positive(r.count),
    cost: positive(r.cost),
    hasCost: isReported(r.cost),
    nano: isPlain(m) ? positive(m.totalNanoAiu) : 0,
    hasNano: isPlain(m) && isReported(m.totalNanoAiu),
    reasoning: positive(u.reasoningTokens),
    hasReasoning: isReported(u.reasoningTokens),
  };
}

const ACTIVITY_TYPES = [EVENT_TYPES.USER_MESSAGE, EVENT_TYPES.TURN_START, EVENT_TYPES.ASSISTANT_MESSAGE, EVENT_TYPES.TOOL_START];

// A prompt, turn, reply or tool call in any stream, or a shutdown that measured tokens or credits; currentTokens is context size, not usage.
export function hasActivity(events) {
  for (const ev of Array.isArray(events) ? events : []) {
    if (ACTIVITY_TYPES.indexOf(ev.type) !== -1) return true;
    if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN) continue;
    if (positive(ev.data.totalNanoAiu) > 0) return true;
    const models = isPlain(ev.data.modelMetrics) ? ev.data.modelMetrics : {};
    for (const name of Object.keys(models)) {
      const m = metricOf(models[name]);
      if (m.input + m.output + m.cacheRead + m.cacheWrite + m.nano > 0) return true;
    }
  }
  return false;
}

// True when any model of the shutdown measured tokens or requests.
function measuredUsage(data) {
  const models = isPlain(data.modelMetrics) ? data.modelMetrics : {};
  for (const name of Object.keys(models)) {
    const m = metricOf(models[name]);
    if (m.input + m.output + m.cacheRead + m.cacheWrite + m.count > 0) return true;
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
    reasoning: Math.max(0, a.reasoning - b.reasoning),
  };
}

// The key a billed shutdown is remembered under: its event id, or its line when the record carried none.
export function shutdownKey(ref) {
  return ref.id != null ? ref.id : `line:${ref.line}`;
}

// Each model's tally from `before` to `current`, leaving out models whose delta is all zero; without `withCredits` the
// credits and premium requests stay unmeasured, since the session counters bill them, and `pinPremium` sends premium 0 so
// a premium-only run's tokens are never priced at list price.
function modelDeltas(current, before, withCredits, pinPremium) {
  const out = [];
  for (const name of Object.keys(current)) {
    const now = metricOf(current[name]);
    // Totals are cumulative across resume, so each shutdown bills its difference from the previous one in the file.
    const d = subtract(now, metricOf(before[name]));
    const t = normalize(d.input, d.output, d.cacheRead, d.cacheWrite);
    if (t.input + t.output + t.cacheRead + t.cacheWrite + d.count + d.cost + d.nano === 0) continue;
    out.push({
      name,
      t: {
        ...t,
        requests: d.count,
        premium: withCredits && now.hasCost ? d.cost : (pinPremium ? 0 : null),
        nano: withCredits && now.hasNano ? d.nano : null,
        reasoning: now.hasReasoning ? d.reasoning : null,
      },
    });
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

// A previous shutdown can be diffed per agent when it has a split, or measured nothing, so every agent started at {}.
function splitBaseline(prev) {
  return prev == null || isPlain(prev.data.agentMetrics) || !measuredUsage(prev.data);
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

// Tokens per model (per agent when the split holds); credits per model only when `exact`, else the counters bill them:
// every target then reports a segment total so the portal never prices it from tokens, or, when the counters measured
// premium requests only, a premium 0 per model.
function billShutdown(work, ev, prev, works, exact) {
  const data = ev.data;
  const current = isPlain(data.modelMetrics) ? data.modelMetrics : {};
  const before = prev != null && isPlain(prev.data.modelMetrics) ? prev.data.modelMetrics : {};
  const pinPremium = !exact && !measuresNano(ev);
  let anyModelNano = false;
  for (const name of Object.keys(current)) if (metricOf(current[name]).hasNano) anyModelNano = true;
  if (agentSplitHolds(data) && splitBaseline(prev)) {
    for (const agent of Object.keys(data.agentMetrics)) {
      const deltas = modelDeltas(agentModels(data, agent), prev == null ? {} : agentModels(prev.data, agent), exact, pinPremium);
      if (deltas.length === 0) continue;
      const target = agent === 'main' ? work : shareTarget(works, work, agent, ev);
      if (!exact && !pinPremium) target.creditsResidual = true;
      for (const x of deltas) tally(target.models, x.name, 'unknown', x.t);
    }
  } else {
    for (const x of modelDeltas(current, before, exact, pinPremium)) tally(work.models, x.name, 'unknown', x.t);
  }
  if (exact && !anyModelNano) {
    work.sessionNano += Math.max(0, positive(data.totalNanoAiu) - (prev == null ? 0 : positive(prev.data.totalNanoAiu)));
    if (isReported(data.totalNanoAiu)) work.sessionNanoMeasured = true;
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

const NO_TOKENS = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, reasoning: null, auto: null });

// A counter rise rides a zero-token entry under the model active at its line, its credits explicit (the checkpoint credit wire rule)
// when the counter measured any.
function tallyCredits(work, entry) {
  if (entry.aiCreditsNano === 0 && entry.premiumRequests === 0) return;
  const nano = measuresNano(entry.event) ? entry.aiCreditsNano : null;
  tally(work.models, modelAtLine(work, entry.line), 'unknown', { ...NO_TOKENS, nano, premium: entry.premiumRequests });
}

// Per-model credits move into the segment total, which is then always sent: never explicit credits beside a residual.
function foldCredits(work) {
  for (const name of Object.keys(work.models)) {
    const m = work.models[name];
    if (m.ai_credits_nano == null) continue;
    work.sessionNano += m.ai_credits_nano;
    delete m.ai_credits_nano;
  }
  work.creditsResidual = true;
}

function hasModelCredits(work) {
  return Object.keys(work.models).some((name) => work.models[name].ai_credits_nano != null);
}

function near(a, b) {
  return Math.abs(a - b) < 1e-6;
}

// True when everything billed since `prev` was this work's own checkpoints, so the shutdown's per-model credits are exact.
function settledSince(before, run, prev) {
  const at = prev == null ? null : cumulativeCredits(prev);
  let nano = before.nano;
  let premium = before.premium;
  for (const e of run) {
    nano -= e.aiCreditsNano;
    premium -= e.premiumRequests;
  }
  return near(nano, at == null ? 0 : at.nano) && near(premium, at == null ? 0 : at.premium);
}

function previousShutdown(shutdowns, line) {
  let prev = null;
  for (const s of shutdowns) {
    if (s.line >= line) break;
    prev = s;
  }
  return prev;
}

// One main work: its unreported shutdowns, then the counter entries no exact shutdown absorbed.
function billWork(work, c) {
  const entries = c.entries.filter((e) => e.event.line >= work.segment.fromLine && e.event.line <= work.segment.toLine);
  const absorbed = new Set();
  for (const ev of work.events) {
    if (ev.type !== EVENT_TYPES.SESSION_SHUTDOWN || ev.agentId != null || c.skip.has(shutdownKey(ev))) continue;
    // The previous shutdown comes from the file even when it lies below the cursor.
    const prev = previousShutdown(c.shutdowns, ev.line);
    const runFrom = prev == null ? c.forkLine : prev.line;
    const run = entries.filter((e) => !e.shutdown && e.event.line > runFrom && e.event.line < ev.line);
    const residual = entries.find((e) => e.event === ev);
    const exact = residual == null || settledSince(residual.before, run, prev);
    if (exact) for (const e of run) absorbed.add(e);
    else {
      if (measuresNano(ev)) work.creditsResidual = true;
      tallyCredits(work, residual);
    }
    billShutdown(work, ev, prev, c.works, exact);
    c.reported.push({ line: ev.line, id: ev.id });
  }
  for (const e of entries) if (!e.shutdown && !absorbed.has(e)) tallyCredits(work, e);
  if (work.creditsResidual || (work.sessionNano > 0 && hasModelCredits(work))) foldCredits(work);
}

// Session-totals mode: each unreported main-stream shutdown bills main's tokens to the work holding it and each
// subagent's share to that subagent's work; usage_checkpoint rises bill credits as they happen. reportedCheckpoint is
// the persisted billed counter (null derives it from the file at `cursor`, the line the window starts after, by default
// the first main work's; `shutdownsBilledOnly` when an older plugin saved that cursor); forkLine is the last line a fork
// copied from its parent. → { reported (shutdown refs), reportedCheckpoint (to persist once the window commits) }.
export function attributeShutdowns(works, allEvents, {
  skipIds = [], reportedCheckpoint = null, forkLine = 0, cursor = null, shutdownsBilledOnly = false,
} = {}) {
  const skip = skipIds instanceof Set ? skipIds : new Set(skipIds);
  const shutdowns = findShutdowns(allEvents).filter((s) => s.agentId == null && s.line > forkLine);
  const mains = works.filter((w) => w.segment.agentId == null);
  const fromLine = cursor != null ? cursor : (mains.length === 0 ? 0 : mains[0].segment.fromLine - 1);
  const stored = validReported(reportedCheckpoint) || creditBaseline(allEvents, fromLine, forkLine, shutdownsBilledOnly);
  const start = raiseBaseline(stored, shutdowns.filter((s) => skip.has(shutdownKey(s))));
  const windowEvents = [];
  for (const w of mains) for (const ev of w.events) windowEvents.push(ev);
  const credits = checkpointDeltas(windowEvents, start);
  const reported = [];
  for (const work of mains) billWork(work, { entries: credits.entries, shutdowns, skip, forkLine, works, reported });
  return { reported, reportedCheckpoint: credits.next };
}
