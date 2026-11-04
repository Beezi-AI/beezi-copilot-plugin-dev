// CLI checkpoint step 10: the cursor patch, saved only after every queue file of the run is on disk.
import { CURSOR_TRAIL_MAX, saveSessionState } from '../state/session-state.mjs';
import { trailAfter } from '../capture/cursor.mjs';
import { shutdownKey } from '../capture/attribute-shutdowns.mjs';
import { mergeIntervals } from '../core/intervals.mjs';
import { CONTINUE, stopRun } from './run-skeleton.mjs';

const MAX_SHUTDOWN_REFS = 50;

// Billed shutdown refs, oldest first, each key once.
function unionRefs(a, b) {
  const seen = new Set();
  const out = [];
  for (const ref of a.concat(b)) {
    const key = shutdownKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.slice(-MAX_SHUTDOWN_REFS);
}

// True when another run saved a cursor past this run's end since this run loaded the state; a cursor this run moved
// back itself (relocation after a rewrite) is never mistaken for one, since the stored line is still the one it loaded.
function overtaken(ctx, cur) {
  return cur.cursorLine != null && cur.cursorLine !== ctx.state.cursorLine && cur.cursorLine > ctx.toLine;
}

// What survives a run that was overtaken: only the fields that merge, so the cursor never moves backwards.
function mergePatch(ctx, cur) {
  return {
    ...(ctx.lastRowId == null ? {} : { lastUsageRowId: Math.max(cur.lastUsageRowId, ctx.lastRowId) }),
    reportedShutdownLines: unionRefs(cur.reportedShutdownLines, ctx.billed),
    coveredIntervals: mergeIntervals(cur.coveredIntervals.concat(ctx.covered == null ? [] : ctx.covered)),
    subagents: { ...cur.subagents, ...ctx.subagentInfo },
  };
}

function cursorPatch(ctx, cur, lastEvent) {
  const { lastRowId, nextCalls, rowFloorMs, lastPayload, sessionName, cwd, nextCheckpoint } = ctx;
  return {
    cursorLine: ctx.toLine,
    cursorEvent: lastEvent == null ? null : { id: lastEvent.id, line: lastEvent.line },
    cursorTrail: trailAfter(cur, ctx.events, lastEvent, CURSOR_TRAIL_MAX),
    usageMode: ctx.usage.mode,
    ...(lastRowId == null ? {} : { lastUsageRowId: lastRowId }),
    ...(nextCalls == null ? {} : { lastCalls: nextCalls }),
    ...(ctx.establishing && rowFloorMs != null ? { usageRowFloorMs: rowFloorMs } : {}),
    ...(nextCheckpoint == null ? {} : { reportedCheckpoint: nextCheckpoint }),
    // The consumed window holds the shutdown that ends the last run, so nothing is left for a late catch-up.
    ...(ctx.runFinished ? { pendingShutdown: false } : {}),
    reportedShutdownLines: unionRefs(cur.reportedShutdownLines, ctx.billed),
    coveredIntervals: ctx.covered,
    subagents: { ...cur.subagents, ...ctx.subagentInfo },
    transcriptPath: ctx.transcript,
    cwd: cwd == null ? null : cwd,
    ...(lastPayload == null ? {} : { lastReport: ctx.delivery.mark(lastPayload), ...(sessionName != null ? { sessionName } : {}) }),
  };
}

// Step 10: the cursor patch (or, when another run got further meanwhile, the merge) under the session lock.
export function commitCursor(ctx) {
  if (ctx.live) {
    ctx.lock.current().touch();
    const events = ctx.events;
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    if (!saveSessionState(ctx.sessionId, (cur) => (overtaken(ctx, cur) ? mergePatch(ctx, cur) : cursorPatch(ctx, cur, lastEvent)))) {
      ctx.errors.push('state-write-failed');
      return stopRun('failed', 'internal', true);
    }
  }
  ctx.consumed = true;
  return CONTINUE;
}
