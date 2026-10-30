// The history run's result counters and the pure classification of one replayed session.

export function newResult() {
  return {
    ok: false,
    reason: null,
    halt: null,
    scanned: 0,
    live: 0,
    active: 0,
    liveTracked: 0,
    alreadyImported: 0,
    routedElsewhere: 0,
    routeDeferred: 0,
    // One-workspace runs only: sessions a matched rule excludes from tracking (`excludedSessionIds`).
    excluded: 0,
    candidates: 0,
    plannedChunks: 0,
    plannedReports: 0,
    sessionsImported: 0,
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    reportsRejected: 0,
    reportsFailed: 0,
    itemErrors: 0,
    unattributed: 0,
    permanentRejections: 0,
    timelines: 0,
    timelinesOffered: 0,
    timelinesDropped: 0,
    sessionErrors: 0,
    // Candidates that produced no report, split by cause; `empty` is the benign one, the fallback only after every other cause is ruled out.
    empty: 0,
    // Sessions with no prompt, turn, tool call or usage anywhere in the file: settled like `empty`, never ledgered.
    noActivity: 0,
    noRemote: 0,
    emitFailed: 0,
    unreadable: 0,
    // Unreadable sessions this run holds the pull open for: the ones not already tried once.
    retriableUnreadable: 0,
    noUsageSummary: 0,
    // Sessions left for a later run; the four named causes are part of `deferred`, `deferredOther` is the rest (busy, budget).
    deferred: 0,
    deferredUnavailable: 0,
    deferredGap: 0,
    deferredOverlap: 0,
    deferredUsageMode: 0,
    deferredOther: 0,
    pendingDrained: 0,
    // Sync only: false means the server could not answer, so every candidate was deferred.
    coverageKnown: false,
    followupsAllowed: true,
    upgradeAdvised: false,
    finalized: false,
    lastError: null,
    // Ids with a final answer for now (accepted, partial, rejected, empty, noRemote); deferred, failed and unreadable are excluded.
    settledIds: [],
    // Sessions skipped as live or active, as { sessionId, path }: the history worker waits on the ones older than its request.
    recent: [],
  };
}

// A finished run with no refusal, halt, failed report or session left unproven for lack of coverage (none can be eligible without it).
export function isCleanSync(result) {
  if (result.ok !== true || result.reason != null || result.halt != null) return false;
  return !(result.reportsFailed > 0) && !(result.deferredUnavailable > 0);
}

export const sum = (list, pick) => list.reduce((total, item) => total + (typeof pick(item) === 'number' ? pick(item) : 0), 0);
export const countOf = (value) => (Array.isArray(value) ? value.length : 0);

export function addCounters(result, counters) {
  for (const name of counters) result[name] += 1;
}

// One flushBackfillChunks answer folded into the run's totals.
export function addFlushCounters(result, flushed) {
  result.plannedChunks += flushed.chunks;
  result.timelinesDropped += flushed.timelinesDropped == null ? 0 : flushed.timelinesDropped;
  result.reportsStored += flushed.stored;
  result.reportsSkipped += flushed.skipped;
  result.timelines += flushed.timelines;
  result.itemErrors += flushed.itemErrors;
  result.unattributed += flushed.unattributed;
  result.permanentRejections += flushed.permanentRejections;
  if (flushed.lastError) result.lastError = flushed.lastError;
}

const skip = (counters, settled = false) => ({ counters, settled, unreadable: false, upload: null });
const UNREADABLE = Object.freeze({ counters: ['unreadable'], settled: false, unreadable: true, upload: null });

// → { counters, settled, unreadable, upload: null | { parentMaxLine } } for one engine answer; readPriorMode() is asked
// only when a shutdown-totals replay starts past line 0.
export function classifyReplay(checkpoint, reports, startCursor, readPriorMode) {
  const skipped = checkpoint == null || checkpoint.skipped == null ? {} : checkpoint.skipped;
  // Anything that did not commit is not consumed, so it is never `empty` and never ledgered.
  if (checkpoint == null || checkpoint.outcome !== 'committed') return classifyUncommitted(checkpoint, skipped);
  if (reports.length === 0) {
    // `empty` is the only benign outcome, so it is the fallback only once every reason worth reporting is ruled out.
    if (skipped.emitFailed != null && skipped.emitFailed > 0) return skip(['emitFailed']);
    if (skipped.noRemote != null && skipped.noRemote > 0) return skip(['noRemote'], true);
    return skip(['empty'], true);
  }
  // Overlap ban: parent and subagent reports alike must start after the proven prefix, since subagents share the parent's line space.
  if (startCursor > 0 && reports.some((r) => Number.isInteger(r.from_line) && r.from_line <= startCursor)) {
    return skip(['deferred', 'deferredOverlap']);
  }
  let parentMaxLine = startCursor;
  for (const r of reports) {
    if (r.is_subagent !== true && Number.isInteger(r.to_line) && r.to_line > parentMaxLine) parentMaxLine = r.to_line;
  }
  // Usage-mode rule: lines below the start may hold per-call tokens, so the shutdown totals replay only when the prior mode
  // (local state, else the coverage checkpoint) is known to be session_totals; an unknown prior defers.
  const tokens = sum(reports, (r) => r.token_total);
  const credits = sum(reports, (r) => r.ai_credits_nano);
  const allTotals = reports.every((r) => r.usage_source === 'session_totals');
  if (startCursor > 0 && allTotals && tokens > 0 && readPriorMode() !== 'session_totals') {
    return skip(['deferred', 'deferredUsageMode']);
  }
  // No session.shutdown in the window: the activity, code changes and timeline are real, so it still uploads without tokens.
  const counters = allTotals && tokens === 0 && credits === 0 ? ['noUsageSummary'] : [];
  return { counters, settled: false, unreadable: false, upload: { parentMaxLine } };
}

function classifyUncommitted(checkpoint, skipped) {
  const reason = checkpoint == null ? null : checkpoint.reason;
  // runCheckpoint never throws, so an engine crash ('internal') or a file that vanished ('no-transcript') arrives as a failed outcome:
  // the first one holds the seal like any unreadable session, the second lets it through.
  if (checkpoint == null || skipped.deltaFailed || reason === 'internal' || reason === 'no-transcript') return UNREADABLE;
  if (reason === 'no-activity') return skip(['noActivity'], true);
  // The file is shorter than the start line: its stored prefix cannot be trusted against this file.
  if (reason === 'cursor-mismatch' || skipped.cursorMismatch) return skip(['deferred', 'deferredGap']);
  if (reason === 'usage-hold' || skipped.usageHeld) return skip(['deferred', 'deferredUsageMode']);
  // Busy session, spent budget, no recipients: retried by a later run and holds the seal meanwhile.
  if (checkpoint.outcome === 'deferred') return skip(['deferred', 'deferredOther']);
  // A parent with no usable working directory is reported under the engine's fallback remote, so a failed emit is a real one.
  return skip(['emitFailed']);
}
