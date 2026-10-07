import fs from 'fs';
import path from 'path';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { flushQueue } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { beeziHome, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { probeIdentity, PROBE_OUTCOMES } from './whoami.mjs';
import { AUTH_STATES, AUTH_REASONS } from './auth-state.mjs';
import { authNotice, FORBIDDEN_NOTICE, UPGRADE_RESTART_NOTICE } from './auth-messages.mjs';
import { takeUpgradeNotice } from './auth-markers.mjs';
import { recordAuthResult } from './telemetry-auth.mjs';
import { DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { listAccounts, updateAccount } from './accounts.mjs';
import { linkedSessions } from './sessions.mjs';
import { authHeaders } from './http.mjs';
import {
  recordWhoami,
  readTrackingState,
  allowsLiveFor,
  shouldBackfill,
  TrackingMode,
} from './tracking.mjs';
import { billingStatus, BillingSource, PlanSource } from './billing.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { reconcileBillingConfig, ReconcileOutcome } from './billing-capture.mjs';
import { syncAccountIfNeeded } from './account-sync.mjs';
import { statuslineCaptureDetached } from './statusline-install.mjs';
import { pruneStatuslineSnapshots } from './statusline-snapshot.mjs';
import { saveSessionState } from './session-state.mjs';
import { hasBeenAsked, hasCorrelationBeenAsked, isTelemetryGranted } from './telemetry-consent.mjs';
import { checkForUpdate } from './update-check.mjs';
import { maybeRefreshQuotaInBackground } from './quota-copilot.mjs';
import { readSessionWorkspace, expandTargets, isMultiTenant } from './workspace.mjs';
import { pendingAskSummary, pendingAskNotice } from './workspace-prompt.mjs';

const SESSION_START_BUDGET_MS = 12000;
const HOUSEKEEPING_BUDGET_MS = 10000;
const PLAN_NUDGE_EVERY_MS = 24 * 60 * 60 * 1000;
const WATCHER_LOG_MAX_BYTES = 1024 * 1024;

// The consent ask, or null once it was answered or shown. It is not stamped as asked here: it is stamped only by a
// channel that is known to show it to the user (V-06/V-50 are open), so the user keeps being asked until they answer.
export function consentPrompt() {
  if (hasBeenAsked()) return null;
  return 'Beezi can send crash reports about the plugin itself — versions, OS, which plugin file '
    + 'failed, and whether it was signed in. Never your code, prompts, or file paths. It helps us '
    + 'fix bugs we would otherwise never see. Recommended: /beezi-local-settings telemetry correlate — the same '
    + 'reports plus a random installation ID, so support can find yours and tell you when it is '
    + 'fixed. Prefer to stay anonymous? /beezi-local-settings telemetry on sends the reports without that ID. '
    + '/beezi-local-settings telemetry off declines everything.';
}

// Offered once to a machine that already sends anonymous diagnostics; same no-stamp rule as consentPrompt.
function correlationOffer() {
  if (!isTelemetryGranted() || hasCorrelationBeenAsked()) return null;
  return 'Beezi diagnostics are on. Optionally, a random installation ID can associate a failure '
    + 'with the last Beezi account linked on this machine, so support can find your report. It is '
    + 'off unless you turn it on: run /beezi-local-settings telemetry correlate to allow it, or ignore this — '
    + 'anonymous reporting continues either way.';
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs == null ? fs : deps.fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin == null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      const childRoot = resolveRepoRoot(gitImpl, child, cache, map);
      recordRoot(childRoot == null ? child : childRoot);
    }
  }
  return { map, dirty };
}

async function announceRepo(cwd, session, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    const res = await fetchImpl(`${apiBase()}${ENDPOINTS.reposStatus}`, {
      method: 'POST',
      headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote }),
    });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Task-branch sessions will be tracked.`
      : 'Beezi: this repo is not connected to Beezi. No analytics tracked here.';
  } catch { return null; } // offline — silent
}

// The portal's verdict on the token, kept at full resolution. 401 is a verdict on the
// credential and one refresh may fix it; 403 is a verdict on the account and no refresh can;
// anything else is a check we could not run, which stays silent. Nothing here ever discards
// credentials — that is the loop that used to delete a refreshable session (findings 1, 2).
// `who` carries the tenant's tracking policy for the rest of the hook.
async function probeToken(session, fetchImpl) {
  const probe = await probeIdentity(session, { fetchImpl });
  return {
    outcome: probe.outcome,
    reason: probe.reason == null ? null : probe.reason,
    who: probe.outcome === PROBE_OUTCOMES.AUTHENTICATED ? { valid: true, ...probe.identity } : null,
  };
}

// Resolves after `ms` (unref'd, so it never holds a process open); `cancel` drops it.
function deadlineTimer(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Drops log files that only grow: the watcher's own log past 1 MB.
function truncateWatcherLog() {
  try {
    const file = path.join(beeziHome(), 'logs', 'watcher.log');
    if (fs.statSync(file).size > WATCHER_LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch { /* no log yet */ }
}

function countEntries(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

// Prune, then the repo-map pre-warm and self-heal (`cwd` names the session's repo discovery; the watcher has none).
// Returns the number of entries removed. Never throws.
function localMaintenance({ cwd = null, gitImpl = _git } = {}) {
  const before = countEntries(stateDir());
  try { pruneStale(); } catch { /* best-effort */ }
  let removed = Math.max(0, before - countEntries(stateDir()));
  try { removed += pruneStatuslineSnapshots(); } catch { /* best-effort */ }
  truncateWatcherLog();
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(cwd, gitImpl, map);
    const dropped = pruneRepoMap(map);
    if (dirty || dropped > 0) saveRepoMap(map);
  } catch { /* best-effort */ }
  return removed;
}

// A reconcile that switched identity or captured a plan forces the check-in: the only moment the portal can learn about it.
const forcedOutcome = (outcome) => outcome === ReconcileOutcome.IDENTITY_CHANGED || outcome === ReconcileOutcome.CAPTURED;

// Fire-and-forget check-ins: each returns a promise that cannot reject.
function checkIn(sessions, { config, outcome, via, fetchImpl }) {
  const deps = { fetchImpl, readBillingConfig: () => config };
  return sessions.map((session) => Promise.resolve()
    .then(() => syncAccountIfNeeded(session, { force: forcedOutcome(outcome), via }, deps))
    .catch(() => null));
}

// What the watcher (and SessionStart) run to keep the machine tidy: prune, repo-map self-heal, billing reconcile,
// account check-in and a queue flush for every linked account. Never throws and never prints (its caller may
// be the MCP server, whose stdout is JSON-RPC). Returns { flushed, pruned }.
export async function runHousekeeping({ budgetMs = HOUSEKEEPING_BUDGET_MS, reason = 'watcher', cwd = null, fetchImpl, gitImpl } = {}) {
  const out = { flushed: 0, pruned: 0 };
  let timer = null;
  try {
    const fetchFn = fetchImpl == null ? resolveFetch() : fetchImpl;
    const deadline = Date.now() + budgetMs;
    const work = (async () => {
      out.pruned = localMaintenance({ cwd, gitImpl });
      const reconciled = reconcileBillingConfig({ config: readBillingConfig() });
      const sessions = await linkedSessions().catch(() => []);
      const results = await Promise.all([
        ...sessions.map((s) => flushQueue(s, { fetchImpl: fetchFn, deadline }).catch(() => null)),
        ...checkIn(sessions, { config: reconciled.config, outcome: reconciled.outcome, via: reason, fetchImpl: fetchFn }),
      ]);
      for (const r of results) if (r != null && typeof r.flushed === 'number') out.flushed += r.flushed;
    })();
    timer = deadlineTimer(budgetMs);
    await Promise.race([work.catch(() => {}), timer.promise]);
  } catch { /* housekeeping is best-effort */ } finally {
    if (timer != null) timer.cancel();
  }
  return out;
}

// Once a day at most.
function planNudgeDue(now) {
  const file = path.join(beeziHome(), 'plan-nudge.json');
  try {
    const last = Date.parse((readJson(file, null) || {}).at);
    if (Number.isFinite(last) && now - last < PLAN_NUDGE_EVERY_MS && last <= now) return false;
    writeJsonSecure(file, { at: new Date(now).toISOString() });
  } catch { /* an unwritable marker never blocks the session */ }
  return true;
}

// The notices for this session start: [{ text, kind, actionable }]. `kind` is auth | update | billing | policy |
// consent | statusline | repo | targets | restart. The workspace ask and the relay of the most important notice
// are placed by scripts/session-start.mjs, so additionalContext is always null here. Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const budgetMs = deps.budgetMs == null ? SESSION_START_BUDGET_MS : deps.budgetMs;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const gitImpl = deps.gitImpl == null ? _git : deps.gitImpl;
  const notices = [];
  const add = (kind, text, actionable = true) => { if (text) notices.push({ text, kind, actionable }); };

  // The plugin's own version check. Started BEFORE the credential store is touched (the token read may spawn
  // `security` / `secret-tool` / PowerShell) and awaited last, so its bounded fetch overlaps work that was going to
  // happen anyway. Deliberately NOT behind the token check: a stale plugin is stale whether or not the machine is
  // linked. It is not handed this call's fetchImpl (a Beezi-API client): update-check resolves its own, unauthenticated.
  // .catch() at creation, so a promise awaited branches later can never surface as an unhandledRejection.
  const updatePromise = Promise.resolve().then(() => checkForUpdate()).catch(() => null);
  const restartNotice = takeUpgradeNotice() ? UPGRADE_RESTART_NOTICE : null;

  const work = async () => {
    if (restartNotice) add('restart', restartNotice);
    const finish = async () => add('update', await updatePromise);

    let rows;
    try {
      rows = await listAccounts(deps);
    } catch {
      add('auth', authNotice({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.STORAGE_UNAVAILABLE }));
      await finish();
      return;
    }
    if (rows.length === 0) {
      add('auth', authNotice({ authState: AUTH_STATES.UNLINKED, reason: AUTH_REASONS.NO_CREDENTIALS }));
      await finish();
      return;
    }
    // Where the session lives, for the checkpoint and the session resolver; it never writes the cursor (R-03).
    saveSessionState(input.session_id, { transcriptPath: input.transcript_path, cwd: input.cwd });

    // Only this session's own choice scopes requests; the row's web-side tenantId never does.
    const workspaceState = readSessionWorkspace(input.session_id);
    // A multi-workspace account's tenantName is the web-side workspace, so it is named by email.
    const label = (session) => rows.length > 1 ? `Beezi (${(isMultiTenant(session) ? null : session.tenantName) || session.email || session.key})` : 'Beezi';
    const sessions = (await Promise.all(rows.map(async (row) => {
      const warn = (line) => { if (line) add('auth', line.replace('Beezi:', `${label(row)}:`)); };
      const auth = await _getAuthentication(deps, { account: row.key }).catch(() => ({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.STORAGE_UNAVAILABLE }));
      if (auth.authState !== AUTH_STATES.READY) { warn(authNotice(auth)); return null; }
      let session = { ...row, tenantId: null, token: auth.accessToken, clientId: auth.clientId == null ? row.clientId : auth.clientId };
      let probe = await probeToken(session, fetchImpl);
      if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
        const retry = await _getAuthentication(deps, { account: row.key, forceRefresh: true }).catch(() => null);
        if (retry == null || retry.authState !== AUTH_STATES.READY) {
          warn(retry == null ? 'Beezi: authentication is temporarily unavailable.' : authNotice(retry));
          return null;
        }
        session = { ...session, token: retry.accessToken, clientId: retry.clientId == null ? session.clientId : retry.clientId };
        probe = await probeToken(session, fetchImpl);
        if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED) {
          warn('⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi-local-login to authorize it again.');
          return null;
        }
      }
      if (probe.outcome === PROBE_OUTCOMES.FORBIDDEN) {
        recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: AUTH_REASONS.FORBIDDEN }, { source: DIAGNOSTIC_SOURCES.SESSION_START, account: row.key });
        warn(FORBIDDEN_NOTICE);
        return null;
      }
      if (probe.outcome === PROBE_OUTCOMES.UNAVAILABLE && probe.reason != null) {
        recordAuthResult({ authState: AUTH_STATES.UNAVAILABLE, reason: probe.reason }, { source: DIAGNOSTIC_SOURCES.SESSION_START, account: row.key });
      }
      try { recordWhoami(session.key, probe.who, session.clientId); } catch { /* best-effort */ }
      if (probe.who != null) {
        const patch = {};
        for (const field of ['email', 'name', 'tenantId', 'tenantName', 'tenants']) {
          if (probe.who[field] != null) patch[field] = probe.who[field];
        }
        try { await updateAccount(session.key, patch); } catch { /* best-effort */ }
        session = { ...session, ...patch };
      }
      return { ...session, tenantId: null };
    }))).filter(Boolean);
    if (sessions.length === 0) { await finish(); return; }

    const trackingByKey = new Map(sessions.map((s) => [s.key, readTrackingState(s.key)]));
    const liveSessions = sessions.filter((s) => allowsLiveFor(s, trackingByKey.get(s.key)));
    // One clone per target workspace; a session still waiting for a rule has none.
    const targetSessions = expandTargets(liveSessions, workspaceState).filter((s) => allowsLiveFor(s, trackingByKey.get(s.key)));
    const liveAllowed = liveSessions.length > 0;
    // A target clone of a multi-workspace account names its workspace, and its email when several accounts are linked.
    const targetLabel = (s) => {
      if (!isMultiTenant(s) || s.tenantId == null) return label(s);
      const tenant = (s.tenants || []).find((t) => t.id === s.tenantId);
      const workspace = (tenant && tenant.name) || s.tenantId;
      return rows.length > 1 ? `Beezi (${s.email || s.key} · ${workspace})` : `Beezi (${workspace})`;
    };

    // One billing snapshot for the whole run (R-20): file-only, so it costs no network and no spawn.
    const config = readBillingConfig();
    let reconciled = { config, outcome: ReconcileOutcome.UNCHANGED, changes: [] };
    try { reconciled = reconcileBillingConfig({ config }); } catch { /* best-effort */ }
    // Fire-and-forget: the account check-in is never awaited past the deadline.
    checkIn(targetSessions, { config: reconciled.config, outcome: reconciled.outcome, via: 'session-start', fetchImpl });

    const [, announcements] = await Promise.all([
      Promise.all(sessions.map((s) => flushQueue(s, { fetchImpl }).catch(() => null))),
      Promise.all(targetSessions.map(async (s) => {
        const line = await announceRepo(input.cwd, s, fetchImpl, gitImpl);
        return line == null ? null : line.replace('Beezi:', `${targetLabel(s)}:`);
      })),
    ]);
    for (const line of announcements) add('repo', line, false);
    localMaintenance({ cwd: input.cwd, gitImpl });

    if (liveAllowed) {
      // Every automatic change of the billing record is announced, verbatim: it changes what later reports are priced against.
      for (const line of reconciled.changes) add('billing', line);
      const status = billingStatus({ config: reconciled.config });
      if (status.source === BillingSource.SUBSCRIPTION && status.planSource === PlanSource.NONE && planNudgeDue(Date.now())) {
        add('billing', 'Beezi: your Copilot plan is unknown. Tell Beezi in /beezi-local-settings.');
      }
      // The status-line wrapper is a settings.json entry anything can overwrite; silence would read as "still capturing".
      let detached = false;
      try { detached = statuslineCaptureDetached(); } catch { /* best-effort */ }
      if (detached) add('statusline', 'Beezi: your status line no longer runs Beezi\'s wrapper. Turn it back on with /beezi-local-settings statusline on.');
    }

    // Tracking-policy messages: tell a dark workspace it is dark, and point at the login flow wherever the one-time
    // history pull has not completed yet (the backfill is the last step of /beezi-local-login).
    for (const session of sessions) {
      // A multi-workspace account's cached mode describes the web-side workspace, not this session's.
      if (isMultiTenant(session)) continue;
      const tracking = trackingByKey.get(session.key);
      const mode = tracking == null || tracking.trackingMode == null ? null : tracking.trackingMode;
      let policy = null;
      if (mode === TrackingMode.BACKFILL_ONLY) {
        policy = shouldBackfill(tracking)
          ? 'Beezi: audit mode — new sessions are not tracked. Run /beezi-local-login to upload your session history, or upgrade your workspace plan to track new sessions.'
          : 'Beezi: audit mode — new sessions are not tracked. Upgrade your workspace plan to start tracking them.';
      } else if (mode === TrackingMode.DISABLED) {
        policy = 'Beezi: analytics are off for this workspace.';
      } else if (shouldBackfill(tracking)) {
        policy = 'Beezi: run /beezi-local-login once to include your past sessions.';
      }
      if (policy) add('policy', policy.replace('Beezi:', `${label(session)}:`));
    }

    // Analytics held for a workspace answer in other folders; this session's own ask is placed by the script.
    try { add('targets', pendingAskNotice(await pendingAskSummary({ excludeSessionId: input.session_id }))); } catch { /* best-effort */ }
    add('consent', consentPrompt() || correlationOffer());
    // Never awaited: it only spawns the detached quota worker when the cache is stale.
    try { maybeRefreshQuotaInBackground(); } catch { /* best-effort */ }
    await finish();
  };

  const timer = deadlineTimer(budgetMs);
  try {
    // Notices finished by the deadline are emitted; the rest are dropped for this session.
    await Promise.race([work().catch(() => {}), timer.promise]);
  } finally {
    timer.cancel();
  }
  return { notices: notices.slice(), additionalContext: null };
}
