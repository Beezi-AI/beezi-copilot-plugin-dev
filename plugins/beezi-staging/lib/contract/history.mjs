// History-run vocabulary: the run mode, its request budget, the run-ending halts and the per-session chunk verdicts.

// Repeatable history sync (/beezi-staging-sync) rather than the one-time pull driven by /beezi-staging-login.
export const SYNC_MODE = 'sync';

// Every history request's budget: a foreground command, so the hook budget behind postJson's 3s default does not apply.
export const AUDIT_TIMEOUT_MS = 60000;

// Per-session verdicts derived from the chunk response. ACCEPTED deliberately covers both
// "stored" and the server's benign zero-token skip — the response's stored/skipped are chunk
// totals with no per-session attribution, so claiming "stored" per session would assert
// something the wire never said.
export const BackfillSessionStatus = Object.freeze({
  ACCEPTED: 'accepted',
  PARTIAL: 'partial',
  REJECTED: 'rejected',
  FAILED: 'failed',
  UNATTRIBUTED: 'unattributed',
});

// Run-ending conditions — the caller stops sending and reports these distinctly. LOCK_LOST is
// never produced by the transport: the history run sets it when its lease is taken over mid-run.
export const BackfillHalt = Object.freeze({
  ALREADY_COMPLETED: 'already-completed',
  NOT_ALLOWED: 'not-allowed',
  UNSUPPORTED_SERVER: 'unsupported-server',
  FORBIDDEN: 'forbidden',
  LOCK_LOST: 'lock-lost',
});
