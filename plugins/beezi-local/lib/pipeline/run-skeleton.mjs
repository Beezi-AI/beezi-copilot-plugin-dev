// The frame a checkpoint engine runs in: result record, session lock, budget clock, step driver and crash capture.
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { acquireSessionLock } from '../state/session-state.mjs';

// The session lock goes stale after 2 minutes; a long read refreshes it at least this often.
const LOCK_KEEPALIVE_MS = 15 * 1000;

// A step's result when the run goes on.
export const CONTINUE = Object.freeze({ stop: null });

// A step's result when the run ends here with outcome/reason; tail says whether the shared tail still runs.
export function stopRun(outcome, reason, tail) {
  return { stop: { outcome, reason, tail } };
}

export function newRunResult() {
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false, usageHeld: false, cursorMismatch: false };
  return { segmentsQueued: 0, flushed: 0, errors: [], outcome: 'failed', reason: null, sessionErrors: [], skipped, gated: false };
}

export function finish(out, outcome, reason) {
  out.outcome = outcome;
  out.reason = reason == null ? null : reason;
}

// Runs the steps in order until one stops; → that stop ({ outcome, reason, tail }) or null when every step went on.
export async function runSteps(steps, ctx) {
  for (const step of steps) {
    const { stop } = await step(ctx);
    if (stop != null) return stop;
  }
  return null;
}

// A positive numeric budget in ms, else null (no deadline).
export function budgetOf(value) {
  return typeof value === 'number' && value > 0 ? value : null;
}

// The deadline a budget sets, the time left before it, and cap(ms): a request cap that never outlives the run budget.
export function budgetClock(budgetMs) {
  const deadline = budgetMs == null ? null : Date.now() + budgetMs;
  const timeLeft = () => (deadline == null ? null : deadline - Date.now());
  const cap = (ms) => {
    const left = timeLeft();
    return left == null ? ms : Math.max(1, Math.min(ms, left));
  };
  return { deadline, timeLeft, cap };
}

// How long a run waits for a busy session lock: a quarter of its budget, at most 2 s; 10 s with no budget.
function lockWaitMs(budgetMs) {
  return budgetMs == null ? 10000 : Math.min(2000, budgetMs / 4);
}

// The run's one session lock; release() is idempotent, so the tail and the guard may both call it.
export function createLockHolder() {
  let lock = null;
  return {
    hold(acquired) { lock = acquired; },
    current() { return lock; },
    release() {
      if (lock != null) {
        const held = lock;
        lock = null;
        held.release();
      }
    },
  };
}

// Takes the session lock into the holder; → keepLock(), which touches it at most every LOCK_KEEPALIVE_MS while it is
// held, or null when another run holds it past the wait.
export async function acquireRunLock(holder, sessionId, budgetMs) {
  const lock = await acquireSessionLock(sessionId, { waitMs: lockWaitMs(budgetMs) });
  if (lock == null) return null;
  holder.hold(lock);
  let touchedAt = Date.now();
  return () => {
    const held = holder.current();
    if (held == null || Date.now() - touchedAt < LOCK_KEEPALIVE_MS) return;
    held.touch();
    touchedAt = Date.now();
  };
}

// The step driver every engine shares: ctx.out takes the stop's outcome, or committed when no step stopped, and the
// tail runs unless the stop said tail:false; never rejects (guardRun).
export function driveRun(steps, ctx, tail) {
  return guardRun(ctx.out, ctx.lock, async () => {
    const stop = await runSteps(steps, ctx);
    if (stop == null) finish(ctx.out, 'committed', null);
    else finish(ctx.out, stop.outcome, stop.reason);
    if (stop == null || stop.tail) await tail(ctx);
  });
}

// Never rejects: a throw becomes failed/internal plus a HOOK_CRASH issue, and the lock is released either way.
export async function guardRun(out, lock, body) {
  try {
    await body();
  } catch (error) {
    out.outcome = 'failed';
    out.reason = 'internal';
    recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
  } finally {
    lock.release();
  }
  return out;
}
