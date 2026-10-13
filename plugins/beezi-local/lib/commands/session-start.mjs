// SessionStart: verifies each linked account and collects this session's notices, inside one run deadline.
import { getAuthentication as _getAuthentication } from '../auth/token.mjs';
import { flushQueue } from '../delivery/queue-flush.mjs';
import { git as _git } from '../repo/git.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { PROBE_OUTCOMES } from '../auth/whoami.mjs';
import { probeToken } from '../auth/probe.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../contract/auth-states.mjs';
import { authNotice, FORBIDDEN_NOTICE, UPGRADE_RESTART_NOTICE } from '../ux/auth-messages.mjs';
import { takeUpgradeNotice } from '../credentials/auth-markers.mjs';
import { recordAuthResult } from '../auth/diagnostics.mjs';
import { DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { listAccounts, updateAccount } from '../accounts/index-store.mjs';
import { recordWhoami, readTrackingState, allowsLiveFor } from '../state/tracking.mjs';
import { billingStatus } from '../billing/plan-resolution.mjs';
import { BillingSource, PlanSource } from '../contract/billing-vocab.mjs';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { reconcileBillingConfig, ReconcileOutcome } from '../billing/plan-reconcile.mjs';
import { readVscodeEntitlements } from '../sources/vscode/entitlement.mjs';
import { planNudgeDue } from '../billing/plan-nudge.mjs';
import { statuslineCaptureDetached } from '../statusline/install.mjs';
import { saveSessionState } from '../state/session-state.mjs';
import { checkForUpdate } from '../ux/update-check.mjs';
import { maybeRefreshQuotaInBackground } from '../billing/quota/refresh.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { expandTargets } from '../workspace/targets.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { pendingAskSummary, pendingAskNotice } from '../ux/workspace-prompt.mjs';
import { announceRepo, checkIn, deadlineTimer, localMaintenance } from '../pipeline/housekeeping.mjs';
import { readUsageHold } from '../pipeline/usage-hold.mjs';
import { healthSummary } from '../state/health-record.mjs';
import { spawnDetached } from '../platform/spawn.mjs';
import { maybeStartPendingHistory } from '../history/pending-trigger.mjs';
import { scriptPath } from '../config/plugin-root.mjs';
import { deliveryNotice, USAGE_HOLD_NOTICE } from '../ux/capture-health.mjs';
import {
  AUTH_TEMPORARILY_UNAVAILABLE_NOTICE,
  LINK_REJECTED_NOTICE,
  PLAN_UNKNOWN_NOTICE,
  STATUSLINE_DETACHED_NOTICE,
  accountLabel,
  consentPrompt,
  correlationOffer,
  labelled,
  targetLabel,
  trackingPolicyNotice,
} from '../ux/session-notices.mjs';

const SESSION_START_BUDGET_MS = 12000;
// Each SessionStart request waits at most this long, and never past the run's deadline.
const REQUEST_TIMEOUT_MS = 3000;
const IDENTITY_FIELDS = ['email', 'name', 'tenantId', 'tenantName', 'tenants'];

// The run's shared facts and its notice list; `several` is set once the linked rows are read.
function createRun(input, deps) {
  const budgetMs = deps.budgetMs == null ? SESSION_START_BUDGET_MS : deps.budgetMs;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const gitImpl = deps.gitImpl == null ? _git : deps.gitImpl;
  const deadline = Date.now() + budgetMs;
  const notices = [];
  return {
    input, deps, budgetMs, fetchImpl, gitImpl, deadline, notices, several: false,
    add: (kind, text, actionable = true) => { if (text) notices.push({ text, kind, actionable }); },
    // fetchImpl plus a timeout capped by what is left of the run.
    requestDeps: () => ({ fetchImpl, timeoutMs: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())) }),
  };
}

// The notices for this session start: [{ text, kind, actionable }]. `kind` is auth | update | billing | policy |
// consent | statusline | health | repo | targets | restart. The workspace ask and the relay of the most important notice
// are placed by commands/session-start-hook.mjs, so additionalContext is always null here. Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const run = createRun(input, deps);
  // The plugin's own version check. Started BEFORE the credential store is touched (the token read may spawn
  // `security` / `secret-tool` / PowerShell) and awaited last, so its bounded fetch overlaps work that was going to
  // happen anyway. Deliberately NOT behind the token check: a stale plugin is stale whether or not the machine is
  // linked. It is not handed this call's fetchImpl (a Beezi-API client): update-check resolves its own, unauthenticated.
  // .catch() at creation, so a promise awaited branches later can never surface as an unhandledRejection.
  const updatePromise = Promise.resolve().then(() => checkForUpdate()).catch(() => null);
  const restartNotice = takeUpgradeNotice() ? UPGRADE_RESTART_NOTICE : null;

  const timer = deadlineTimer(run.budgetMs);
  try {
    // Notices finished by the deadline are emitted; the rest are dropped for this session.
    await Promise.race([collectNotices(run, restartNotice, updatePromise).catch(() => {}), timer.promise]);
  } finally {
    timer.cancel();
  }
  return { notices: run.notices.slice(), additionalContext: null };
}

async function collectNotices(run, restartNotice, updatePromise) {
  if (restartNotice) run.add('restart', restartNotice);
  await accountNotices(run);
  run.add('update', await updatePromise);
}

// Every step that needs a linked account, in order; returns early when no account is usable.
async function accountNotices(run) {
  const { input } = run;
  const rows = await readLinkedRows(run);
  if (rows == null) return;
  run.several = rows.length > 1;
  // Where the session lives, for the checkpoint and the session resolver; it never writes the cursor.
  saveSessionState(input.session_id, { transcriptPath: input.transcript_path, cwd: input.cwd });
  // Sessions left behind their file or owing a shutdown are checkpointed by a detached worker, never inside this hook. Spawned
  // before any network wait, so a run cut off at its deadline still leaves it; the worker takes its own lock.
  spawnDetached(scriptPath('catch-up-worker.mjs'), { spawnImpl: run.deps.spawnImpl }, [input.session_id]);
  // Retries history uploads that are due, one detached worker per account; it never throws.
  await maybeStartPendingHistory({ spawnImpl: run.deps.spawnImpl });
  // Only this session's own choice scopes requests; the row's web-side tenantId never does.
  const workspaceState = readSessionWorkspace(input.session_id);
  const sessions = (await Promise.all(rows.map((row) => verifyAccount(row, run)))).filter(Boolean);
  if (sessions.length === 0) return;

  const { trackingByKey, liveSessions, targetSessions } = liveTargets(sessions, workspaceState);
  const reconciled = await reconcileBilling();
  // Fire-and-forget: the account check-in is never awaited past the deadline.
  checkIn(targetSessions, { config: reconciled.config, outcome: reconciled.outcome, via: 'session-start', fetchImpl: run.fetchImpl });
  await flushAndAnnounce(run, sessions, targetSessions);
  localMaintenance({ cwd: input.cwd, gitImpl: run.gitImpl, accountKeys: rows.map((row) => row.key) });

  if (liveSessions.length > 0) addLiveNotices(run, reconciled);
  addPolicyNotices(run, sessions, trackingByKey);
  addHealthNotices(run, sessions);
  await addClosingNotices(run);
}

// The linked rows, or null after the auth notice for an unreadable index or a machine with no account.
async function readLinkedRows(run) {
  let rows;
  try {
    rows = await listAccounts(run.deps);
  } catch {
    run.add('auth', authNotice({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.STORAGE_UNAVAILABLE }));
    return null;
  }
  if (rows.length === 0) {
    run.add('auth', authNotice({ authState: AUTH_STATES.UNLINKED, reason: AUTH_REASONS.NO_CREDENTIALS }));
    return null;
  }
  return rows;
}

// One linked row → its verified session (tenantId null), or null after the auth notice that says why it is unusable.
async function verifyAccount(row, run) {
  const warn = (line) => { if (line) run.add('auth', labelled(line, accountLabel(row, run.several))); };
  const auth = await _getAuthentication(run.deps, { account: row.key }).catch(() => ({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.STORAGE_UNAVAILABLE }));
  if (auth.authState !== AUTH_STATES.READY) { warn(authNotice(auth)); return null; }
  const verified = await probeWithRenewal(row, auth, run, warn);
  if (verified == null) return null;
  const { probe } = verified;
  let { session } = verified;
  if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
    recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.FORBIDDEN }, { source: DIAGNOSTIC_SOURCES.SESSION_START, account: row.key });
    warn(FORBIDDEN_NOTICE);
    return null;
  }
  if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE && probe.reason != null) {
    recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: probe.reason }, { source: DIAGNOSTIC_SOURCES.SESSION_START, account: row.key });
  }
  try { recordWhoami(session.key, probe.who, session.clientId); } catch { /* best-effort */ }
  if (probe.who != null) session = await storeIdentity(session, probe.who);
  return { ...session, tenantId: null };
}

// The token probe, retried once with a forced refresh after a 401: { session, probe }, or null once warned. A token kept
// for another API origin was never sent, so no refresh can fix it; only a new sign-in does.
async function probeWithRenewal(row, auth, run, warn) {
  let session = pinnedTo({ ...row, tenantId: null, token: auth.accessToken, clientId: auth.clientId == null ? row.clientId : auth.clientId }, auth);
  let probe = await probeToken(session, run.requestDeps());
  if (probe.outcome !== PROBE_OUTCOMES.UNAUTHORIZED) return { session, probe };
  if (probe.originMismatch === true) {
    warn(LINK_REJECTED_NOTICE);
    return null;
  }
  const retry = await _getAuthentication(run.deps, { account: row.key, forceRefresh: true }).catch(() => null);
  if (retry == null || retry.authState !== AUTH_STATES.READY) {
    warn(retry == null ? AUTH_TEMPORARILY_UNAVAILABLE_NOTICE : authNotice(retry));
    return null;
  }
  session = pinnedTo({ ...session, token: retry.accessToken, clientId: retry.clientId == null ? session.clientId : retry.clientId }, retry);
  probe = await probeToken(session, run.requestDeps());
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
    warn(LINK_REJECTED_NOTICE);
    return null;
  }
  return { session, probe };
}

// Copies the whoami identity onto the stored row (best-effort) and onto the session.
async function storeIdentity(session, who) {
  const patch = {};
  for (const field of IDENTITY_FIELDS) {
    if (who[field] != null) patch[field] = who[field];
  }
  try { await updateAccount(session.key, patch); } catch { /* best-effort */ }
  return { ...session, ...patch };
}

// Each account's tracking state, the sessions live tracking allows, and one clone per target workspace of those
// (a session still waiting for a rule has none).
function liveTargets(sessions, workspaceState) {
  const trackingByKey = new Map(sessions.map((s) => [s.key, readTrackingState(s.key)]));
  const liveSessions = sessions.filter((s) => allowsLiveFor(s, trackingByKey.get(s.key)));
  const targetSessions = expandTargets(liveSessions, workspaceState).filter((s) => allowsLiveFor(s, trackingByKey.get(s.key)));
  return { trackingByKey, liveSessions, targetSessions };
}

// One billing snapshot for the whole run: local reads only (VS Code's entitlement included), no network and no spawn.
async function reconcileBilling() {
  const config = readBillingConfig();
  let reconciled = { config, outcome: ReconcileOutcome.UNCHANGED, changes: [] };
  try { reconciled = reconcileBillingConfig({ config, entitlements: await readVscodeEntitlements() }); } catch { /* best-effort */ }
  return reconciled;
}

// Flushes every verified account's queue while each target announces whether this repo is connected.
async function flushAndAnnounce(run, sessions, targetSessions) {
  const [, announcements] = await Promise.all([
    Promise.all(sessions.map((s) => flushQueue(s, { fetchImpl: run.fetchImpl, deadline: run.deadline }).catch(() => null))),
    Promise.all(targetSessions.map(async (s) => {
      const line = await announceRepo(run.input.cwd, s, run.requestDeps(), run.gitImpl);
      return line == null ? null : labelled(line, targetLabel(s, run.several));
    })),
  ]);
  for (const line of announcements) run.add('repo', line, false);
}

// Notices for a machine that tracks live sessions: billing record changes, an unknown plan, a detached status line.
function addLiveNotices(run, reconciled) {
  // Every automatic change of the billing record is announced, verbatim: it changes what later reports are priced against.
  for (const line of reconciled.changes) run.add('billing', line);
  const status = billingStatus({ config: reconciled.config });
  if (status.source === BillingSource.SUBSCRIPTION && status.planSource === PlanSource.NONE && planNudgeDue(Date.now())) {
    run.add('billing', PLAN_UNKNOWN_NOTICE);
  }
  // The status-line wrapper is a settings.json entry anything can overwrite; silence would read as "still capturing".
  let detached = false;
  try { detached = statuslineCaptureDetached(); } catch { /* best-effort */ }
  if (detached) run.add('statusline', STATUSLINE_DETACHED_NOTICE);
}

function addPolicyNotices(run, sessions, trackingByKey) {
  for (const session of sessions) {
    // A multi-workspace account's cached mode describes the web-side workspace, not this session's.
    if (isMultiTenant(session)) continue;
    const policy = trackingPolicyNotice(trackingByKey.get(session.key));
    if (policy) run.add('policy', labelled(policy, accountLabel(session, run.several)));
  }
}

// One line when any verified account's delivery is degraded, and one when the usage store is on hold.
function addHealthNotices(run, sessions) {
  try {
    const degraded = sessions.map((s) => deliveryNotice(healthSummary(s.key))).find((line) => line != null);
    run.add('health', degraded);
    if (readUsageHold() != null) run.add('health', USAGE_HOLD_NOTICE);
  } catch { /* best-effort */ }
}

async function addClosingNotices(run) {
  // Analytics held for a workspace answer in other folders; this session's own ask is placed by the script.
  try { run.add('targets', pendingAskNotice(await pendingAskSummary({ excludeSessionId: run.input.session_id }))); } catch { /* best-effort */ }
  run.add('consent', consentPrompt() || correlationOffer());
  // Never awaited: it only spawns the detached quota worker when the cache is stale.
  try { maybeRefreshQuotaInBackground(); } catch { /* best-effort */ }
}
