// CLI checkpoint step 7 and the session_totals billing call: the window, its usage mode and rows, then the shutdowns and
// usage_checkpoint credits billed in totals mode.
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { EVENT_TYPES } from '../sources/cli/event-types.mjs';
import {
  readUsageRows, STORE_REASON, advancesWithoutRows, isDefinitiveReason, isSchemaChange, isStoreGone,
} from '../sources/cli/usage-store.mjs';
import { PER_CALL_ENABLED, decideUsageMode, earliestStampMs } from '../capture/usage-mode.mjs';
import { hasMeasuredCheckpoint, validReported } from '../capture/checkpoint-credits.mjs';
import { attributeShutdowns, shutdownKey } from '../capture/attribute-shutdowns.mjs';
import { clearUsageHold, markUsageHold } from './usage-hold.mjs';
import { CONTINUE, stopRun } from './run-skeleton.mjs';

// The usage store reader: the caller's seam, else the real read-only store.
export function rowsReader(ctx) {
  return ctx.deps.readUsageRows == null ? readUsageRows : ctx.deps.readUsageRows;
}

// Step 7: window, mode and rows (Step 6, the SessionEnd wait, lives in pipeline/shutdown-wait.mjs).
export async function chooseUsage(ctx) {
  const { state, live, cursor, toLine, errors } = ctx;
  ctx.windowEvents = ctx.events.filter((e) => e.line > cursor && e.line <= toLine);
  // A cursor first taken from the server (no local one) pins the earliest window stamp as the row floor every later run keeps.
  ctx.establishing = live && state.cursorLine == null && cursor > 0;
  ctx.rowFloorMs = live ? state.usageRowFloorMs : null;
  if (ctx.establishing) {
    const lo = earliestStampMs(ctx.windowEvents);
    // No stamped event yet means no floor to pin, so the establishing run waits for one.
    if (lo === Infinity && PER_CALL_ENABLED && state.usageMode !== 'session_totals') return stopRun('deferred', 'empty-window', true);
    ctx.rowFloorMs = lo === Infinity ? null : lo;
  }
  let store = { available: false, reason: STORE_REASON.NO_SQLITE, rows: [] };
  if (state.usageMode !== 'session_totals' && PER_CALL_ENABLED) {
    store = await rowsReader(ctx)(ctx.sessionId, { afterRowId: live ? state.lastUsageRowId : 0 });
  }
  const usage = decideUsageMode({
    mode: state.usageMode,
    store,
    windowHasShutdown: ctx.windowEvents.some((e) => e.type === EVENT_TYPES.SESSION_SHUTDOWN),
    // A main-stream usage_checkpoint that measured credits settles a row-less session to totals like a shutdown.
    windowHasCheckpoint: hasMeasuredCheckpoint(ctx.windowEvents),
    // Without node:sqlite a per_call window advances as for a deleted database, keeping lastUsageRowId for a later run.
    isStoreGone: advancesWithoutRows(store.reason),
    isDefinitive: isDefinitiveReason(store.reason),
  });
  if (usage.storeGone && isStoreGone(store.reason)) {
    errors.push(`usage-store-gone:${store.reason}`);
    recordIssue({ code: DIAGNOSTIC_CODES.USAGE_STORE_GONE, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
  }
  if (live && store.available) clearUsageHold();
  // A held per_call window must not move the cursor: unread rows would have no window left to attach to.
  if (usage.heldReason != null) {
    if (live && isSchemaChange(usage.heldReason)) markUsageHold(usage.heldReason);
    ctx.out.skipped.usageHeld = true;
    errors.push(`usage-hold:${usage.heldReason}`);
    return stopRun('deferred', 'usage-hold', true);
  }
  ctx.store = store;
  ctx.usage = usage;
  return CONTINUE;
}

// Totals mode: unbilled shutdowns and usage_checkpoint credit rises onto the works through capture's one
// attribution. A live run bills from its stored counter (a cursor saved without one was saved by a plugin that billed
// shutdowns only) and keeps the next one for the commit; an audit derives both from the file at its cursor.
// Sets ctx.billed (the shutdown refs) and, live only, ctx.nextCheckpoint.
export function billSessionTotals(ctx) {
  const { live, state } = ctx;
  const result = attributeShutdowns(ctx.works, ctx.events, {
    skipIds: live ? state.reportedShutdownLines.map(shutdownKey) : [],
    reportedCheckpoint: live ? state.reportedCheckpoint : null,
    forkLine: ctx.forkLine,
    cursor: ctx.cursor,
    shutdownsBilledOnly: live && state.cursorLine != null && validReported(state.reportedCheckpoint) == null,
  });
  ctx.billed = result.reported;
  if (live) ctx.nextCheckpoint = result.reportedCheckpoint;
}
