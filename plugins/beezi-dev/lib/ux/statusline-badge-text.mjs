// The Beezi badge at the end of the CLI status line: where this session's analytics go, from small local reads only.
import { AccountStatus, listAccounts } from '../accounts/index-store.mjs';
import { readAuthState } from '../credentials/auth-markers.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { isMultiTenant, joinTenantNames, tenantsOf } from '../workspace/tenants.mjs';
import { routeOfSession, routeTarget } from '../workspace/route-describe.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { TrackingMode, isTenantDark, readTrackingState } from '../state/tracking.mjs';

// The auth states a hook last recorded that only a new sign-in clears.
const SIGN_IN_STATES = [AUTH_STATES.REAUTH_REQUIRED, AUTH_STATES.UNLINKED];

function needsSignIn(row) {
  if (row.status === AccountStatus.REVOKED) return true;
  return SIGN_IN_STATES.indexOf(readAuthState(row.key).lastState) !== -1;
}

// An untracked account's name: its one workspace, else its email.
function accountName(row) {
  const tenants = tenantsOf(row) || [];
  if (tenants.length === 1 && tenants[0].name) return tenants[0].name;
  return row.email || row.name || 'an account';
}

// One account's parts: { kind: 'tracked'|'untracked'|'off'|'pending', text, alone? }; [] when its workspaces are unknown.
// `alone` is the whole badge when this is the only part: audit mode or analytics off.
function accountParts(row, state) {
  const route = routeOfSession(row, state);
  if (route.reason.kind === 'unknown') return [];
  if (route.reason.kind === 'pending') return [{ kind: 'pending', text: `? ${accountName(row)}` }];
  if (route.ids.length === 0) return [{ kind: 'untracked', text: `✗ ${accountName(row)}` }];
  const tracking = readTrackingState(row.key);
  if (!isMultiTenant(row)) {
    const mode = tracking == null ? null : tracking.trackingMode;
    if (mode === TrackingMode.BACKFILL_ONLY) return [{ kind: 'off', text: `✗ ${accountName(row)}`, alone: '✗ not tracked (audit mode)' }];
    if (mode === TrackingMode.DISABLED) return [{ kind: 'off', text: `✗ ${accountName(row)}`, alone: '✗ analytics off' }];
    return [{ kind: 'tracked', text: routeTarget(row, route) }];
  }
  // A target that answered TRACKING_DISABLED sends nothing live.
  const live = route.ids.filter((id) => !isTenantDark(tracking, id));
  const dark = route.ids.filter((id) => isTenantDark(tracking, id));
  const darkPart = { kind: 'off', text: `✗ ${joinTenantNames(row, dark)}`, alone: '✗ analytics off' };
  if (live.length === 0) return [darkPart];
  const tracked = { kind: 'tracked', text: joinTenantNames(row, live) };
  return dark.length === 0 ? [tracked] : [tracked, darkPart];
}

// The badge for these accounts and this session's workspace state; null for no badge.
export function badgeText(rows, state) {
  try {
    if (rows.length === 0) return null;
    if (rows.some(needsSignIn)) return 'Beezi ⚠ sign in: /beezi-dev-login';
    const parts = [].concat(...rows.map((row) => accountParts(row, state)));
    if (parts.length === 0) return null;
    const tracked = [];
    parts.filter((p) => p.kind === 'tracked').forEach((p) => { if (tracked.indexOf(p.text) === -1) tracked.push(p.text); });
    const others = parts.filter((p) => p.kind !== 'tracked').map((p) => p.text);
    if (tracked.length > 0) return `Beezi → ${tracked.concat(others).join(', ')}`;
    if (parts.length === 1 && parts[0].alone != null) return `Beezi ${parts[0].alone}`;
    if (parts.every((p) => p.kind === 'untracked' || p.kind === 'off')) return 'Beezi ✗ not tracked';
    if (parts.every((p) => p.kind === 'pending')) return 'Beezi ? no rule yet';
    return `Beezi ${others.join(', ')}`;
  } catch {
    return null;
  }
}

// The badge for one status-line render: the linked accounts and the payload's session; null on any failure.
export async function statuslineBadge(payload) {
  try {
    const sessionId = payload == null ? null : payload.session_id;
    return badgeText(await listAccounts(), readSessionWorkspace(sessionId));
  } catch {
    return null;
  }
}
