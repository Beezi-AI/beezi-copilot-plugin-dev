// Which linked recipients the watcher captures for: live-tracking workspaces, narrowed per session by its routes.
import { readSessionHead } from '../sources/cli/session-files.mjs';
import { readTrackingState, allowsLiveFor } from '../state/tracking.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { usesRules } from '../workspace/rule-model.mjs';
import { accountRowFor, isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { linkCutoffMs } from '../history/offer-scan.mjs';
import { settlementKey } from '../state/watcher-record.mjs';
import { str } from '../core/guards.mjs';

function headCwd(transcriptPath) {
  try {
    const head = readSessionHead(transcriptPath);
    return head == null ? null : str(head.cwd);
  } catch {
    return null;
  }
}

// The session's folder: the one its state recorded, else the cwd in its events.jsonl head; null when neither is known.
export function sessionCwd(state, transcriptPath) {
  return str(state == null ? null : state.cwd) || headCwd(transcriptPath);
}

// The recipients a session still sends to: a recipient it excludes (no target, no held ask) gets no coverage request.
// A session SessionStart never bound resolves against the route the checkpoint's bind fallback would give it from the same folder (never written here).
export function recipientsFor(item, recipients, routeCtx) {
  const id = item.entry.sessionId;
  let state = null;
  try { state = readSessionWorkspace(id); } catch { /* unreadable = unanswered */ }
  if (state == null) {
    try {
      const cwd = sessionCwd(item.state, item.entry.transcriptPath);
      if (cwd != null) {
        const route = {};
        let any = false;
        for (const recipient of recipients) {
          if (!usesRules(recipient)) continue;
          any = true;
          route[recipient.key] = routeForDir(recipient, cwd, routeCtx);
        }
        if (any) state = { cwd, route };
      }
    } catch { /* no known folder: every recipient, as before */ }
  }
  return recipients.filter((recipient) => {
    const resolved = resolveTargets(recipient, state);
    const tenantId = recipient.tenantId == null ? null : recipient.tenantId;
    return resolved.targets.includes(tenantId) || (resolved.pendingAsk && resolved.askTenants.includes(tenantId));
  });
}

// One session per workspace live tracking is on for; the row comes from accountRowFor since linked sessions may lack `tenants`, and a missing tracking cache reads as allowed.
export function liveRecipients(sessions) {
  const out = [];
  for (const session of sessions) {
    try {
      const row = accountRowFor(session);
      const tracking = readTrackingState(session.key);
      const view = { ...session, tenants: row.tenants };
      if (isMultiTenant(row)) {
        for (const tenant of tenantsOf(row) || []) {
          if (allowsLiveFor({ ...view, tenantId: tenant.id }, tracking)) out.push({ ...session, tenantId: tenant.id });
        }
      } else if (allowsLiveFor({ ...view, tenantId: null }, tracking)) {
        out.push({ ...session, tenantId: null });
      }
    } catch { /* an account whose state cannot be read is skipped this pass */ }
  }
  return out;
}

// Each recipient's link cutoff by settlement key; null when its link time is unknown or unreadable.
export function recipientCutoffs(recipients) {
  const cutoffs = new Map();
  for (const r of recipients) {
    let cutoff = null;
    try { cutoff = linkCutoffMs(accountRowFor(r), r.tenantId, readTrackingState(r.key)); } catch { cutoff = null; }
    cutoffs.set(settlementKey(r.key, r.tenantId), cutoff);
  }
  return cutoffs;
}
