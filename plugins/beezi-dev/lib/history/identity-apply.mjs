// Which account identity and plan a history report carries: the live path's account order at the session's start.
import { loadSessionState } from '../state/session-state.mjs';
import { accountStamp } from '../billing/identity-stamp.mjs';
import { resolveBilling } from '../billing/plan-resolution.mjs';
import { resolveSessionIdentity, SessionIdentityStatus } from '../billing/session-identity.mjs';

export const attempt = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

// { stamp, billing } of one account under the run's billing snapshot; no account means the current one.
// `at` is the session's start; a boolean `byok` is the session's own verdict, null leaves it to this process.
export function identityFor(snapshot, account = null, { at = null, byok = null } = {}) {
  return {
    stamp: attempt(() => accountStamp({ config: snapshot, account }), {}),
    billing: attempt(() => resolveBilling({ config: snapshot, account, at, byok }), {}),
  };
}

// A bound session takes its own account's stamp and plan; an unbound one takes the run snapshot's (the current account).
export function applyIdentity(reports, { stamp, billing }) {
  for (const report of reports) {
    for (const field of ['account_uuid', 'account_email']) {
      if (stamp[field] != null) report[field] = stamp[field];
      else delete report[field];
    }
    for (const field of ['billing_source', 'subscription_type', 'subscription_plan']) {
      if (billing[field] != null) report[field] = billing[field];
      else if (field !== 'billing_source') delete report[field];
    }
  }
}

// The saved binding, else resolveSessionIdentity for a past session: never this process's own, so the sync's env is not read.
async function sessionAccount(entry, facts) {
  const saved = loadSessionState(entry.sessionId).accountKey;
  if (saved != null) return { status: SessionIdentityStatus.BOUND, key: saved };
  const found = await resolveSessionIdentity({
    sessionId: entry.sessionId,
    surface: facts.surface,
    events: facts.events,
    transcriptPath: entry.transcriptPath,
    ownProcess: false,
  });
  return { status: found.status, key: found.account == null ? null : found.account.key };
}

// facts: readSessionFacts(entry). OMIT keeps only the billing source: the current account's plan would be a guess.
// A VS Code report keeps what its checkpoint stamped.
export async function stampHistoryReports(reports, entry, snapshot, facts) {
  if (entry.kind === 'vscode') return;
  const { status, key } = await sessionAccount(entry, facts);
  const identity = identityFor(snapshot, key, { at: facts.at, byok: facts.byok });
  if (status !== SessionIdentityStatus.OMIT) applyIdentity(reports, identity);
  else applyIdentity(reports, { stamp: {}, billing: { billing_source: identity.billing.billing_source } });
}
