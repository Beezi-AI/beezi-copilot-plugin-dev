// How a window bills its tokens: per-call store rows, session-totals shutdowns, or a hold; plus the window's stamp bounds.

// Rows join by created_at and the store opens read-only, so per-call rows are billed.
export const PER_CALL_ENABLED = true;

// → { mode, useRows, useTotals, heldReason, storeGone }. isStoreGone and isDefinitive are the usage store's verdicts on
// store.reason. storeGone: the database itself is gone, so a per_call window advances with zero tokens and stays per_call.
// A main-stream usage_checkpoint carries session totals like a shutdown does, so either one can settle a null mode.
export function decideUsageMode({ mode, store, windowHasShutdown, windowHasCheckpoint = false, isStoreGone, isDefinitive }) {
  const decision = { mode, useRows: false, useTotals: false, heldReason: null, storeGone: false };
  if (mode === 'per_call') {
    if (store.available) decision.useRows = true;
    else if (isStoreGone) decision.storeGone = true;
    else decision.heldReason = store.reason;
  } else if (mode === 'session_totals') {
    decision.useTotals = true;
  } else if (store.available && store.rows.length > 0) {
    decision.mode = 'per_call';
    decision.useRows = true;
  } else if (windowHasShutdown || windowHasCheckpoint) {
    if (store.available || isDefinitive) {
      decision.mode = 'session_totals';
      decision.useTotals = true;
    } else decision.heldReason = store.reason;
  }
  return decision;
}

function stampMs(e) {
  return e.timestamp == null ? NaN : Date.parse(e.timestamp);
}

// The earliest parseable event stamp, Infinity when none: an establishing run's row floor.
export function earliestStampMs(events) {
  let lo = Infinity;
  for (const e of events) {
    const t = stampMs(e);
    if (Number.isFinite(t) && t < lo) lo = t;
  }
  return lo;
}

// The latest parseable event stamp, -Infinity when none: the horizon per-call rows are attributed up to.
export function latestStampMs(events) {
  let hi = -Infinity;
  for (const e of events) {
    const t = stampMs(e);
    if (Number.isFinite(t) && t > hi) hi = t;
  }
  return hi;
}

// The newest stamp a per-call row may carry to join this run: the file's last stamp, or for a run capped at `toLine` (a
// lagging recipient's replay) the instant before the first stamp past the cap, where the run starting there takes
// over its rows.
export function rowHorizonMs(events, toLine, capped) {
  if (!capped) return latestStampMs(events);
  const next = earliestStampMs(events.filter((e) => e.line > toLine));
  return next === Infinity ? latestStampMs(events.filter((e) => e.line <= toLine)) : next - 1;
}
