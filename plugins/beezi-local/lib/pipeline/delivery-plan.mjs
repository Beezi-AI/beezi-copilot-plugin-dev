// Step 3 of every checkpoint (Copilot CLI and VS Code): recipients, workspace fan-out, the tracking gate and the queue sink.
import { linkedRecipients, withToken, diagnosticsSession } from '../auth/recipients.mjs';
import { getDefaultKey, listAccounts as _listAccounts, AccountStatus } from '../accounts/index-store.mjs';
import { bindInstallationIfNeeded } from '../telemetry/installation-binding.mjs';
import { allowsLiveFor, isTenantDark, matchesIdentity, readTrackingState } from '../state/tracking.mjs';
import { rememberIdentityTarget } from '../state/identity-targets.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';
import { bindSessionRoutes } from '../workspace/routing.mjs';
import { usesRules } from '../workspace/rule-model.mjs';
import { enqueue, enqueueHeld } from '../delivery/queue-files.mjs';

// → { stop: 'no-recipients'|'no-activity'|'tracking-gated' } or { stop: null, plans, senders, emit, workspaceState, authorize }.
// bindCwd() names the folder a not-yet-bound live session binds from; beforeBind() false stops it as no-activity first.
// Planning and enqueuing read no credential: authorize() reads each planned account's token once, the first time a
// step needs the network, refreshes plans and senders with them, and → the live senders.
export async function planDelivery(sessionId, { deps = {}, options = {}, bindCwd = () => null, beforeBind = null } = {}) {
  const recipients = options.sessions == null ? await queuedRecipients(deps) : options.sessions;
  if (recipients.length === 0) return { stop: 'no-recipients' };
  // One read per checkpoint; a tenant set on caller-supplied sessions (sync --tenant) wins. Account
  // rows carry the web-side tenantId, which must never be followed.
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(sessionId); } catch { /* best-effort */ }
  // A live session whose SessionStart saw no multi-workspace account (a login mid-session) is bound from
  // here. Tenant-scoping invariant: only the hook's or the session file's own cwd binds; never process.cwd().
  if (workspaceState == null && options.sessions == null && recipients.some(usesRules)) {
    const cwd = bindCwd();
    if (cwd != null) {
      if (beforeBind != null && !(await beforeBind())) return { stop: 'no-activity' };
      try { workspaceState = bindSessionRoutes(sessionId, cwd, recipients); } catch { /* best-effort */ }
    }
  }
  const skipGate = options.skipLiveTrackingGate === true;
  const plans = withLinkedPlan(planTargets(recipients, workspaceState, options, skipGate));
  if (plans.length === 0) return { stop: 'tracking-gated' };
  const emit = options.sink == null ? fanOut(plans) : options.sink;
  const delivery = { stop: null, plans, senders: sendersOf(plans), emit, workspaceState, authorize: null };
  let authorized = null;
  delivery.authorize = () => {
    if (authorized == null) {
      authorized = authorizePlans(plans, deps).then(() => {
        delivery.senders = sendersOf(plans);
        return delivery.senders.filter((s) => s.token);
      });
    }
    return authorized;
  };
  return delivery;
}

// Every linked account as a token-less session, plus each revoked one until a re-login drains it (pruneStale bounds it):
// a temporarily unreadable or refreshing credential must not lose this delta. With no linked account there is none, so a
// revoked-only machine holds its cursor for the transcript to replay after a re-login.
async function queuedRecipients(deps) {
  let rows = [];
  try { rows = await (deps.listAccounts == null ? _listAccounts : deps.listAccounts)(deps); } catch { rows = []; }
  let linked = [];
  try { linked = await linkedRecipients({ ...deps, listAccounts: async () => rows }); } catch { linked = []; }
  return linked.length === 0 ? [] : linked.concat(rows.filter((row) => row.status === AccountStatus.REVOKED));
}

// Revoked accounts ride along only while a linked one is planned: alone, their queue would advance the cursor.
function withLinkedPlan(plans) {
  return plans.some((p) => p.session.status !== AccountStatus.REVOKED) ? plans : [];
}

// One clone per target; token-less ones stay, so the snapshot drain waits for them.
function sendersOf(plans) {
  const senders = [];
  for (const p of plans) for (const t of p.targets) senders.push({ ...p.session, tenantId: t });
  return senders;
}

// Reads every linked planned account's token concurrently into its plan (a revoked one and a failed read stay token-less),
// then binds the installation through the diagnostics account. Never rejects.
async function authorizePlans(plans, deps) {
  await Promise.all(plans.map(async (p) => {
    if (p.session.token || p.session.status === AccountStatus.REVOKED) return;
    const session = await withToken(p.session, deps).catch(() => null);
    if (session != null) p.session = session;
  }));
  const live = plans.map((p) => p.session).filter((s) => s.token);
  // Diagnostics use the machine-wide anonymous worker; only identity correlation is authenticated.
  let defaultKey = null;
  try { defaultKey = await getDefaultKey(); } catch { /* best-effort */ }
  try { await bindInstallationIfNeeded(diagnosticsSession(live, defaultKey), { postJsonImpl: deps.postJsonImpl }); } catch { /* best-effort */ }
}

// Per account: live targets (dark ones dropped) plus every workspace held until a rule answers; accounts with neither drop out.
function planTargets(recipients, workspaceState, options, skipGate) {
  return recipients.map((s) => {
    const tracking = trackingFor(s);
    const multi = isMultiTenant(s);
    if (options.sessions != null && typeof s.tenantId === 'string' && s.tenantId !== '') {
      return { session: s, multi, targets: skipGate || allowsLiveFor(s, tracking) ? [s.tenantId] : [], hold: [] };
    }
    const r = resolveTargets(s, workspaceState);
    const targets = skipGate ? r.targets : r.targets.filter((t) => allowsLiveFor({ ...s, tenantId: t }, tracking));
    const hold = r.pendingAsk ? r.askTenants.filter((t) => !isTenantDark(tracking, t)) : [];
    return { session: s, multi, targets, hold };
  }).filter((p) => p.targets.length > 0 || p.hold.length > 0);
}

// The account's cached tracking state, or null (fail-open) when another login recorded it.
function trackingFor(session) {
  const state = readTrackingState(session.key);
  return matchesIdentity(state, session.clientId == null ? null : session.clientId) ? state : null;
}

// Fan each payload into every target file, plus one held copy while the session awaits a rule; each target learns the
// payload's GitHub identity so that identity's quota rows follow its sessions only.
function fanOut(plans) {
  return (payload) => {
    for (const p of plans) {
      for (const t of p.targets) {
        enqueue(p.session.key, payload, t, { multi: p.multi });
        rememberIdentityTarget(p.session.key, payload.account_uuid, t);
      }
      if (p.hold.length > 0) enqueueHeld(p.session.key, payload, p.hold);
    }
  };
}
