// Owns the work record (one segment being built) and its serialization into report stats.
import { buildActiveIntervals, totalMs } from '../core/intervals.mjs';
import { bucket, clampInt } from './usage-tally.mjs';

// Gaps longer than this between two activity events count as idle, not active time.
export const IDLE_GAP_SEC = 300;

const MAX_CONTEXT_MODEL = 100;
const MAX_ABORT_REASON = 50;

export function newWork(sessionId, agentId, repoRoot, branch, line) {
  return {
    segment: { sessionId, agentId, fromLine: line, toLine: line, repoRoot, remote: null, branch, startedAt: null, endedAt: null },
    events: [],
    timestamps: [],
    anchors: [],
    unclosedStamps: [],
    activeModel: null,
    // { line, model } each time the stream's model changed inside the work, in line order.
    modelChanges: [],
    models: {},
    sessionNano: 0,
    context: null,
    contextPeakHint: 0,
    cold: null,
    // Main stream only: the largest context-window capacity, the newest abort reason and the per-call timing peaks.
    contextWindow: 0,
    abortReason: null,
    timings: null,
    // Set when the session counters bill this work's credits: the segment total is sent even at 0.
    creditsResidual: false,
    // Set when an exact shutdown's session total measured the credits: a 0 total is sent unless premium prices the work.
    sessionNanoMeasured: false,
  };
}

// The model a zero-token entry names: the active one, `auto` while only Auto was chosen, else unknown.
export function activeModelName(work) {
  return work.activeModel || 'unknown';
}

// The model active at `line`: the newest change at or before it, else the work's active one.
export function modelAtLine(work, line) {
  let model = null;
  for (const c of work.modelChanges) {
    if (c.line > line) break;
    model = c.model;
  }
  return model || activeModelName(work);
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
    if (m.token_reasoning_output != null) c.token_reasoning_output = Math.min(m.token_reasoning_output, m.token_output);
    if (m.auto_requests != null) {
      c.auto_requests = m.auto_requests;
      if (m.auto_ai_credits_nano != null) c.auto_ai_credits_nano = clampInt(m.auto_ai_credits_nano);
    }
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
        if (b.token_reasoning_output != null) c.by_effort[e].token_reasoning_output = Math.min(b.token_reasoning_output, b.token_output);
        if (b.auto_requests != null) {
          c.by_effort[e].auto_requests = b.auto_requests;
          if (b.auto_ai_credits_nano != null) c.by_effort[e].auto_ai_credits_nano = clampInt(b.auto_ai_credits_nano);
        }
      }
    }
    // Integers only; premium requests may be fractional. A measured 0 is sent, so the portal prices that
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

// The portal prices credits before premium requests, so a 0 credit total never travels beside a positive premium count.
function hasPremium(models) {
  return Object.keys(models).some((name) => models[name].premium_requests > 0);
}

// The report stats for one work, without code_changes and operations; duration_sec is refilled by the caller after the cross-stream subtraction.
export function segmentStats(work, { includeContext = false } = {}) {
  const models = copyModels(work.models);
  // The server stores nothing for `models: {}`, so a zero-usage segment names the active model with zero counters.
  if (Object.keys(models).length === 0) {
    models[activeModelName(work)] = { ...bucket(), by_effort: { unknown: bucket() } };
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
  if (total > 0 || work.creditsResidual || (work.sessionNanoMeasured && !hasPremium(models))) stats.ai_credits_nano = total;
  // Cache-rewrite counters exist only for segments built from per-call rows.
  if (work.cold != null) {
    stats.cold_prefix_calls = work.cold.calls;
    if (work.cold.nano != null) stats.cold_prefix_ai_credits_nano = clampInt(work.cold.nano);
    stats.model_switches = work.cold.switches;
    stats.idle_cold_calls = work.cold.idleCalls;
  }
  if (includeContext) Object.assign(stats, mainStreamFields(work));
  return { stats, activeIntervals };
}

// The fields the portal keeps for main-agent segments only (context occupancy and capacity, timings, aborts).
function mainStreamFields(work) {
  const out = {};
  if (work.context != null) {
    out.context_peak_tokens = Math.round(work.context.peak);
    out.context_final_tokens = Math.round(work.context.final);
    out.context_final_model = String(work.context.model).slice(0, MAX_CONTEXT_MODEL);
  }
  if (work.timings != null && work.timings.ttftMs != null) out.time_to_first_token_ms = clampInt(work.timings.ttftMs);
  if (work.timings != null && work.timings.durationMs != null) out.duration_ms = clampInt(work.timings.durationMs);
  if (work.abortReason != null) out.turn_aborted = work.abortReason.slice(0, MAX_ABORT_REASON);
  if (work.contextWindow > 0) out.model_context_window = clampInt(work.contextWindow);
  return out;
}
