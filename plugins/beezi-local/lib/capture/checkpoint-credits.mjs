// Owns session-level credit billing from the runtime's cumulative counters: each usage_checkpoint bills its rise over
// what was already billed, and a shutdown bills the residual. Pure.
import { EVENT_TYPES } from '../sources/cli/event-types.mjs';
import { isPlain } from '../core/guards.mjs';
import { isReported, positive } from './usage-tally.mjs';

const NOTHING_BILLED = Object.freeze({ id: null, line: 0, nano: 0, premium: 0 });

// Sum of one measure over a shutdown's modelMetrics, null when no model reported it.
function modelSum(data, pick) {
  const models = isPlain(data.modelMetrics) ? data.modelMetrics : {};
  let sum = null;
  for (const name of Object.keys(models)) {
    const v = isPlain(models[name]) ? pick(models[name]) : null;
    if (isReported(v)) sum = (sum == null ? 0 : sum) + positive(v);
  }
  return sum;
}

function nanoOf(m) {
  return m.totalNanoAiu;
}

function costOf(m) {
  return isPlain(m.requests) ? m.requests.cost : null;
}

// The cumulative { nano, premium } a main-stream usage_checkpoint or shutdown carries, null when it carries neither.
export function cumulativeCredits(ev) {
  if (ev == null || ev.agentId != null) return null;
  const isShutdown = ev.type === EVENT_TYPES.SESSION_SHUTDOWN;
  if (!isShutdown && ev.type !== EVENT_TYPES.USAGE_CHECKPOINT) return null;
  const d = ev.data;
  const nano = isReported(d.totalNanoAiu) ? positive(d.totalNanoAiu) : (isShutdown ? modelSum(d, nanoOf) : null);
  const premium = isReported(d.totalPremiumRequests) ? positive(d.totalPremiumRequests) : (isShutdown ? modelSum(d, costOf) : null);
  if (nano == null && premium == null) return null;
  return { nano: nano == null ? 0 : nano, premium: premium == null ? 0 : premium };
}

// True when the window holds a main-stream usage_checkpoint that measured credits or premium requests: the
// decideUsageMode windowHasCheckpoint input (a 0-row session whose usage the store never holds, such as Agent Host).
export function hasMeasuredCheckpoint(windowEvents) {
  return (Array.isArray(windowEvents) ? windowEvents : []).some((ev) => {
    if (ev.type !== EVENT_TYPES.USAGE_CHECKPOINT) return false;
    const c = cumulativeCredits(ev);
    return c != null && c.nano + c.premium > 0;
  });
}

// A persisted reportedCheckpoint { id, line, nano, premium }, or null when the state holds none usable.
export function validReported(r) {
  return isPlain(r) && isReported(r.nano) && isReported(r.premium) ? r : null;
}

// True when the main-stream counter measured credits, not only premium requests: a premium-only run sends no credit total.
export function measuresNano(ev) {
  if (ev == null || ev.agentId != null) return false;
  const d = ev.data;
  if (isReported(d.totalNanoAiu)) return true;
  return ev.type === EVENT_TYPES.SESSION_SHUTDOWN && modelSum(d, nanoOf) != null;
}

// What was billed through `fromLine` when no state remembers it: the newest own counter at or below it, under-counting
// rather than double-counting (an audit, a server-established start); `shutdownsOnly` takes the newest own shutdown, for a
// cursor an older plugin saved, since it billed shutdowns only.
export function creditBaseline(events, fromLine, forkLine, shutdownsOnly = false) {
  let base = NOTHING_BILLED;
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev.line > fromLine) break;
    if (ev.line <= forkLine || (shutdownsOnly && ev.type !== EVENT_TYPES.SESSION_SHUTDOWN)) continue;
    const c = cumulativeCredits(ev);
    if (c != null) base = { id: ev.id, line: ev.line, nano: c.nano, premium: c.premium };
  }
  return base;
}

// `base` raised field by field to each event's counters: a shutdown already billed is billed through its totals, whatever
// the stored baseline says (an older version's shutdown, a rewritten file).
export function raiseBaseline(base, events) {
  let out = base;
  for (const ev of events) {
    const c = cumulativeCredits(ev);
    if (c == null || (c.nano <= out.nano && c.premium <= out.premium)) continue;
    out = { id: ev.id, line: ev.line, nano: Math.max(out.nano, c.nano), premium: Math.max(out.premium, c.premium) };
  }
  return out;
}

// The shutdown's totals above what was billed, clamped at 0: a counter never bills twice.
export function shutdownResidual(shutdown, billedTotals) {
  const c = cumulativeCredits(shutdown);
  if (c == null) return { aiCreditsNano: 0, premiumRequests: 0 };
  return {
    aiCreditsNano: Math.max(0, c.nano - billedTotals.nano),
    premiumRequests: Math.max(0, c.premium - billedTotals.premium),
  };
}

// The window's main-stream counters in line order → { entries: [{ event, line, shutdown, aiCreditsNano, premiumRequests,
// before }], next }. A checkpoint's delta and a shutdown's residual are the same rise; both move the baseline, which
// never falls, so `next` is the reportedCheckpoint to persist once the window commits. A null `reported` billed nothing.
export function checkpointDeltas(windowEvents, reported) {
  let next = reported == null ? NOTHING_BILLED : reported;
  const entries = [];
  for (const ev of Array.isArray(windowEvents) ? windowEvents : []) {
    const c = cumulativeCredits(ev);
    if (c == null) continue;
    const before = { nano: next.nano, premium: next.premium };
    entries.push({ event: ev, line: ev.line, shutdown: ev.type === EVENT_TYPES.SESSION_SHUTDOWN, ...shutdownResidual(ev, before), before });
    next = { id: ev.id, line: ev.line, nano: Math.max(before.nano, c.nano), premium: Math.max(before.premium, c.premium) };
  }
  return { entries, next };
}
