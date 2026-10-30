// The gates before a history run reads any session: account and auth, audit-only workspaces, the queue drain and the seal.
import { INTERACTIVE_REFRESH_WAIT_MS } from '../auth/token.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { apiBase } from '../config/api.mjs';
import { refusesOrigin } from '../platform/http.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { matchesIdentity, isLiveTrackingAllowed, isTenantDark, TrackingMode } from '../state/tracking.mjs';
import { isComplete } from '../state/ledger.mjs';

const finishAuditOnly = (result) => {
  result.ok = true;
  result.reason = 'audit-only';
  result.upgradeAdvised = true;
};

const finishAlreadyCompleted = (result, upgradeAdvised) => {
  result.ok = true;
  result.reason = 'already-completed';
  result.upgradeAdvised = upgradeAdvised;
};

const finishNotDrained = (result, lastError) => {
  result.ok = true;
  result.reason = 'pending-not-drained';
  result.lastError = lastError;
};

// True when the run may go on: run gains key, session, tenantId, multi, ledgerTenant, identity, tracking, who and ledger.
export async function runPreamble(run) {
  if (!(await authenticate(run))) return false;
  // Step 3: the repair pass must not become a way around an audit-only workspace.
  const { result, syncMode, multi, tracking, trackingValid, tenantId } = run;
  if (syncMode && trackingValid && (multi ? isTenantDark(tracking, tenantId) : !isLiveTrackingAllowed(tracking))) {
    finishAuditOnly(result);
    return false;
  }
  if (syncMode && !(await drainQueue(run))) return false;
  return checkSeal(run);
}

// Step 2: auth and the account's session. A multi-workspace account never runs headerless.
async function authenticate(run) {
  const { result, options } = run;
  if (options.account == null) { result.reason = 'no-account'; return false; }
  const key = options.account;
  const auth = await run.io.getAuthentication(run.deps, { account: key, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  if (auth == null || auth.authState !== AUTH_STATES.READY) {
    result.reason = auth != null && auth.authState === AUTH_STATES.UNLINKED ? 'no-account' : 'auth-unavailable';
    result.authState = auth == null ? null : auth.authState;
    result.authReason = auth == null ? null : auth.reason;
    return false;
  }
  const resolved = await run.io.sessionFor(key, { ...run.deps, getAccessToken: async () => auth.accessToken }).catch(() => null);
  if (resolved == null) { result.reason = 'no-account'; return false; }
  const session = pinnedTo({ ...resolved, token: auth.accessToken }, auth);
  // A credential pinned to another API origin is never sent: only a new login clears it.
  if (refusesOrigin(apiBase(), session)) {
    result.reason = 'auth-unavailable';
    result.authState = AUTH_STATES.REAUTH_REQUIRED;
    result.authReason = null;
    return false;
  }
  const tenantId = options.tenantId == null ? null : options.tenantId;
  const multi = isMultiTenant(resolved);
  if (multi && tenantId == null) { result.reason = 'workspace-required'; return false; }
  run.key = key;
  run.tenantId = tenantId;
  run.multi = multi;
  // Each workspace of a multi-workspace account keeps its own ledger and coverage record, so one import never blocks the rest.
  run.ledgerTenant = multi ? tenantId : null;
  run.session = { ...session, tenantId };
  run.identity = run.session.clientId == null ? null : run.session.clientId;
  run.tracking = run.io.readTracking(key);
  run.trackingValid = matchesIdentity(run.tracking, run.identity);
  return true;
}

// Step 4: drain the queue first, or coverage is stale by exactly those segments and a narrow live row lands beside a wide replay.
async function drainQueue(run) {
  const { result } = run;
  let drained = null;
  // A user-run sync retries now: the live flush backoff does not apply.
  try { drained = await run.io.flushQueue(run.session, { fetchImpl: run.io.fetchImpl, ignoreBackoff: true }); } catch { drained = null; }
  if (drained == null) {
    finishNotDrained(result, 'queued reports could not be delivered');
    return false;
  }
  result.pendingDrained = drained.flushed == null ? 0 : drained.flushed;
  if (drained.trackingDisabled === true) {
    finishAuditOnly(result);
    return false;
  }
  // A quarantined file is set aside on disk and no longer sits in the queue, so it does not stale the coverage answer.
  if (drained.failed > 0 || drained.deferred > 0) {
    finishNotDrained(result, drained.lastError == null ? 'queued reports could not be delivered' : drained.lastError);
    return false;
  }
  return true;
}

// Step 5: --force skips the local caches only, never the server verdict; the account-wide sealed flag cannot vouch for one of several workspaces.
async function checkSeal(run) {
  const { result, options, syncMode, multi, tracking, trackingValid, key } = run;
  if (!syncMode && !options.force && !multi && trackingValid && tracking != null && tracking.backfillCompleted === true) {
    finishAlreadyCompleted(result, tracking.trackingMode != null && tracking.trackingMode !== TrackingMode.LIVE);
    return false;
  }
  const who = await run.io.whoami(run.session, { fetchImpl: run.io.fetchImpl }).catch(() => null);
  run.who = who;
  if (who != null && who.valid) {
    // One workspace's answer must not overwrite a multi-workspace account's cache.
    if (!multi) {
      try { run.io.recordWhoami(key, who, run.identity); } catch { /* best-effort */ }
    }
    if (!syncMode && who.backfillCompleted === true) {
      // The account-wide cache speaks for a one-workspace account only.
      if (!multi) {
        try { run.io.markCompleted(key); } catch { /* best-effort */ }
      }
      finishAlreadyCompleted(result, who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE);
      return false;
    }
    if (syncMode && who.trackingMode != null && who.trackingMode !== TrackingMode.LIVE) {
      finishAuditOnly(result);
      return false;
    }
  }
  run.ledger = run.io.loadLedger(key, run.identity, run.ledgerTenant);
  if (!syncMode && !options.force && isComplete(run.ledger)) {
    finishAlreadyCompleted(result, false);
    return false;
  }
  return true;
}
