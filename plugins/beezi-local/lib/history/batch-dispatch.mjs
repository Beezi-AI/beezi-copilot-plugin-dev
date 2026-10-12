// Sends a history run's replayed sessions in batches: the one-deep pipeline, the lease checks, ledger and coverage writes and error follow-ups.
import { ENDPOINTS } from '../config/api.mjs';
import { mapLimited } from '../core/async.mjs';
import { AUDIT_TIMEOUT_MS, BackfillHalt, BackfillSessionStatus } from '../contract/history.mjs';
import { markImported, markComplete } from '../state/ledger.mjs';
import { recordCoverageCheckpoint } from '../state/coverage-record.mjs';
import { planChunks, MAX_BODY_BYTES, MAX_CHUNK_ITEMS } from './chunk-planner.mjs';
import { sum, addFlushCounters } from './run-result.mjs';

const FOLLOWUP_CONCURRENCY = 4;

export function renewLease(run) {
  const renewed = run.lease.renew();
  if (renewed.ok) run.lastRenewAt = run.io.now();
  return renewed.ok === true;
}

export function loseLease(run) {
  run.result.halt = BackfillHalt.LOCK_LOST;
  run.result.lastError = 'the history lease was taken over';
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

// Accumulated groups, bounded by the request planner's caps; one batch in flight while the next sessions parse, and
// dispatches stay sequential so ledger writes are ordered.
export function createBatchQueue(run) {
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  let inFlight = null;
  const dispatch = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    if (inFlight) await inFlight;
    // A halt discovered by the previous flight drops this batch; its sessions stay unledgered and eligible.
    if (run.halted) return;
    inFlight = dispatchBatch(run, batch);
  };
  return {
    async add(group) {
      pending.push(group);
      pendingBytes += Buffer.byteLength(JSON.stringify({ reports: group.reports, timeline: group.timeline }), 'utf-8');
      pendingItems += group.reports.length;
      if (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS) await dispatch();
    },
    async drain() {
      await dispatch();
      if (inFlight) await inFlight;
    },
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
    { fetchImpl: run.io.fetchImpl },
    { timeoutMs: AUDIT_TIMEOUT_MS, endpoint: run.syncMode ? ENDPOINTS.sessionsSync : ENDPOINTS.sessionsBackfill },
  );
  addFlushCounters(result, flushed);
  const landed = settleBatch(run, batch, flushed.bySession);
  // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
  try { run.io.saveLedger(run.key, run.ledger, run.ledgerTenant); } catch { /* best-effort */ }
  if (run.coverageDirty) {
    run.io.saveCoverage(run.key, run.coverageRecord);
    run.coverageDirty = false;
  }

  if (flushed.halt) {
    result.halt = flushed.halt;
    run.halted = true;
    // The seal is the one-time import's, so a sync run leaves the local caches exactly as it found them.
    if (!run.syncMode && flushed.halt === BackfillHalt.ALREADY_COMPLETED) sealLocally(run);
    return;
  }
  if (run.followupsAllowed) await postFollowups(run, landed);
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
