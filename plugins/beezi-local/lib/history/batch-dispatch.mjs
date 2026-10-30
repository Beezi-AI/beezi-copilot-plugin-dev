// Sends a history run's replayed sessions in batches: the upload lanes, the lease checks, ledger and coverage writes and error follow-ups.
import { ENDPOINTS } from '../config/api.mjs';
import { mapLimited } from '../core/async.mjs';
import { AUDIT_TIMEOUT_MS, BackfillHalt, BackfillSessionStatus } from '../contract/history.mjs';
import { markImported, markComplete } from '../state/ledger.mjs';
import { recordCoverageCheckpoint } from '../state/coverage-record.mjs';
import { planChunks, MAX_BODY_BYTES, MAX_CHUNK_ITEMS } from './chunk-planner.mjs';
import { sum, addFlushCounters } from './run-result.mjs';

const FOLLOWUP_CONCURRENCY = 4;
const UPLOAD_LANES = 2;

export function renewLease(run) {
  const renewed = run.lease.renew();
  if (renewed.ok) run.lastRenewAt = run.io.now();
  return renewed.ok === true;
}

// The first halt and its error win: a later one on the other lane never masks them.
export function loseLease(run) {
  if (run.result.halt === null) {
    run.result.halt = BackfillHalt.LOCK_LOST;
    run.result.lastError = 'the history lease was taken over';
  }
  run.halted = true;
}

// The local half of a seal: the ledger says the pull is done, and so does the account-wide tracking cache unless the
// account has several workspaces, where one workspace's seal says nothing about the others.
export function sealLocally(run) {
  markComplete(run.ledger);
  try { run.io.saveLedger(run.key, run.ledger, run.ledgerTenant); } catch { /* best-effort */ }
  if (run.multi) return;
  try { run.io.markCompleted(run.key); } catch { /* best-effort */ }
}

export function progress(run) {
  run.io.onProgress({ processed: run.processed, total: run.total, ...run.result });
}

// Accumulated groups, bounded by the request planner's caps; up to UPLOAD_LANES batches upload while the next sessions
// parse, each holding whole sessions so a split session stays in one flush.
export function createBatchQueue(run) {
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  const flights = new Set();
  let flightFailure = null;
  // Flights never reject (see dispatch), so this only waits.
  const settle = () => Promise.all(flights);
  const drainFlights = async () => {
    await settle();
    if (flightFailure) throw flightFailure.error;
  };
  const dispatch = async ({ alone = false } = {}) => {
    if (flightFailure) await drainFlights();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    // The last batch goes alone, so its chunk is the one the server commits last.
    while (flights.size >= (alone ? 1 : UPLOAD_LANES)) await Promise.race(flights);
    if (flightFailure) await drainFlights();
    // A halt discovered by an earlier flight drops this batch; its sessions stay unledgered and eligible.
    if (run.halted) return;
    // A failure is kept for the next dispatch or drain instead of going unhandled.
    const flight = dispatchBatch(run, batch).then(
      () => { flights.delete(flight); },
      (error) => {
        flights.delete(flight);
        if (flightFailure === null) flightFailure = { error };
      },
    );
    flights.add(flight);
  };
  return {
    // A full batch launches only once the next group arrives, so batches close exactly where they always did.
    async add(group) {
      const bytes = Buffer.byteLength(JSON.stringify({ reports: group.reports, timeline: group.timeline }), 'utf-8');
      if (pending.length > 0 && (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS)) await dispatch();
      pending.push(group);
      pendingBytes += bytes;
      pendingItems += group.reports.length;
    },
    async drain() {
      await dispatch({ alone: true });
      await drainFlights();
    },
    settle,
  };
}

async function dispatchBatch(run, batch) {
  const { result } = run;
  if (run.dryRun) {
    result.plannedReports += sum(batch, (g) => g.reports.length);
    result.plannedChunks += planChunks(batch).length;
    for (const group of batch) run.followups.delete(group.sessionId);
    return;
  }
  // Before any network work, and the batch is dropped unsent on a lost lease so its sessions stay eligible.
  if (!renewLease(run)) {
    loseLease(run);
    for (const group of batch) run.followups.delete(group.sessionId);
    return;
  }
  result.plannedReports += sum(batch, (g) => g.reports.length);

  const flushed = await run.io.flushBackfillChunks(
    batch,
    run.session,
    { fetchImpl: run.io.fetchImpl, renewSession: run.renewSession, compression: run.compression },
    { timeoutMs: AUDIT_TIMEOUT_MS, endpoint: run.syncMode ? ENDPOINTS.sessionsSync : ENDPOINTS.sessionsBackfill },
  );
  // A halt another lane recorded during this flight keeps its error (needsReauth reads it).
  const haltedBefore = result.halt !== null;
  const { lastError } = result;
  addFlushCounters(result, flushed);
  if (haltedBefore) result.lastError = lastError;
  const landed = settleBatch(run, batch, flushed.bySession);
  // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
  try { run.io.saveLedger(run.key, run.ledger, run.ledgerTenant); } catch { /* best-effort */ }
  if (run.coverageDirty) {
    run.io.saveCoverage(run.key, run.coverageRecord);
    run.coverageDirty = false;
  }

  if (flushed.halt) {
    if (result.halt === null) result.halt = flushed.halt;
    run.halted = true;
    // The seal is the one-time import's, so a sync run leaves the local caches exactly as it found them.
    if (!run.syncMode && flushed.halt === BackfillHalt.ALREADY_COMPLETED) sealLocally(run);
    return;
  }
  if (run.followupsAllowed && !run.halted) await postFollowups(run, landed);
  progress(run);
}

// Each group's verdict into the counters, the ledger and the coverage record → the ids the server accepted.
function settleBatch(run, batch, bySession) {
  const { result } = run;
  // Follow-ups only for sessions the server accepted — a failed one must stay unledgered so a re-run retries it.
  const landed = [];
  for (const group of batch) {
    const verdict = bySession.get(group.sessionId);
    const status = verdict == null || verdict.status == null ? BackfillSessionStatus.FAILED : verdict.status;
    if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
      result.sessionsImported += 1;
      landed.push(group.sessionId);
    }
    // ACCEPTED only: a PARTIAL upload would put the checkpoint ahead of the real prefix forever and defer the session for good.
    if (status === BackfillSessionStatus.ACCEPTED && Number.isInteger(group.parentMaxLine) && group.parentMaxLine > 0) {
      recordCoverageCheckpoint(run.coverageRecord, group.sessionId, group.parentMaxLine, run.io.now(), group.usageSource);
      run.coverageDirty = true;
    }
    if (status === BackfillSessionStatus.REJECTED) {
      result.reportsRejected += group.reports.length;
      result.sessionsRejected += 1;
    }
    if (status === BackfillSessionStatus.FAILED) result.reportsFailed += group.reports.length;
    // Anything the server judged is ledgered, including a rejection: an unconnected repository rejects on every future run too.
    if (
      status === BackfillSessionStatus.ACCEPTED ||
      status === BackfillSessionStatus.PARTIAL ||
      status === BackfillSessionStatus.REJECTED
    ) {
      markImported(run.ledger, group.sessionId, { outcome: status, reports: group.reports.length });
      result.settledIds.push(group.sessionId);
    } else {
      run.followups.delete(group.sessionId);
    }
  }
  return landed;
}

async function postFollowups(run, landed) {
  await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
    const followup = run.followups.get(sessionId);
    run.followups.delete(sessionId);
    if (!followup) return;
    for (const errorPayload of followup.sessionErrors) {
      const { reported } = await run.io.postSessionError(errorPayload, run.session, { fetchImpl: run.io.fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
      if (reported) run.result.sessionErrors += 1;
    }
  });
}
