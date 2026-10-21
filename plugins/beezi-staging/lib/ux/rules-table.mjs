// The user-facing markdown table of an account's workspace rules, with where this folder is and why it sends where it does.
import { isMultiTenant, isSingleTenant, joinTenantNames } from '../workspace/tenants.mjs';
import { rulesOf, shortLabel } from '../workspace/rule-model.mjs';
import { createRouteContext } from '../workspace/route-key.mjs';
import { defaultRoute, kindWords, placeOfDir, routeOfDir, routeTarget } from '../workspace/route-describe.mjs';
import { isLiveTrackingAllowed, readTrackingState } from '../state/tracking.mjs';
import { AccountStatus } from '../accounts/index-store.mjs';

const OUTSIDE_WHERE = 'home, /, temp or Copilot app chat folders';
const HERE_MARK = '← you\'re here';
// A revoked account's analytics still queue on disk and upload once it signs in again.
const HELD = 'held until you sign in again';
const NO_COUNTS = { rules: new Map(), default: 0 };

const cell = (text) => String(text).replace(/\|/g, '\\|');
// An empty cell stays one space wide, so the header's unnamed column reads `| |`.
const tableRow = (cells) => `|${cells.map((c) => (c === '' ? ' ' : ` ${cell(c)} `)).join('|')}|`;
const sessionsText = (n) => `${n} session${n === 1 ? '' : 's'}`;

// The Sends to cell: the target, marked held when a revoked account would send somewhere.
function sendsCell(row, ids, target) {
  return row.status === AccountStatus.REVOKED && ids.length > 0 ? `${target} (${HELD})` : target;
}

// "You're in **labacus-suite**, a git repo at /work/labacus-suite." and why its analytics go where they go.
export function hereSentences(row, place, route) {
  const at = place.path == null ? '' : ` at ${place.path}`;
  const first = place.kind === 'outside'
    ? 'You\'re outside a project folder (home, / or a temp folder).'
    : `You're in **${place.short}**, ${kindWords(place)}${at}.`;
  return [first, whySentence(row, route)];
}

function whySentence(row, route) {
  const reason = route.reason;
  // Worded as the Sends to cell, so a revoked account's sentence says its analytics are held too.
  const to = sendsCell(row, route.ids, routeTarget(row, route));
  // Audit mode or disabled: a one-workspace account sends no new sessions, whatever the default says.
  if (isSingleTenant(row) && route.ids.length > 0 && !isLiveTrackingAllowed(readTrackingState(row.key))) {
    return 'Live tracking is off for this workspace, so new sessions are not sent; these rules apply when history is uploaded.';
  }
  if (reason.kind === 'pending') return 'It has no rule yet. Beezi asks where its analytics go when a session starts here.';
  if (reason.kind === 'rule') {
    const wider = reason.own === false;
    const name = wider ? `Rule R${reason.index} for ${reason.short} covers it` : `Rule R${reason.index}`;
    if (route.ids.length === 0) return wider ? `${name}: nothing is sent.` : `${name} stops tracking it: nothing is sent.`;
    return wider ? `${name} and sends its analytics to ${to}.` : `${name} sends its analytics to ${to}.`;
  }
  if (!isMultiTenant(row)) return `Its sessions send analytics to ${to}, the default for every repo and folder.`;
  return route.ids.length === 0
    ? 'It has no rule of its own, and the default is Don\'t send: nothing is sent.'
    : `It has no rule of its own, so the default applies: analytics go to ${to}.`;
}

// Where Default sends: the one workspace, New folders' workspaces, "not tracked" or "ask me".
export function defaultTarget(row) {
  const route = defaultRoute(row);
  return route.reason.kind === 'pending' ? 'ask me' : routeTarget(row, route);
}

// The user-facing rules table, as lines: accounts with known workspaces, no machine fields.
// countsByKey: account key → ruleSessionCounts (last-30-days sessions per rule and for Default); a missing account counts 0.
export function rulesTableLines(rows, dir, ctx, { countsByKey = new Map() } = {}) {
  const known = rows.filter((row) => isMultiTenant(row) || isSingleTenant(row));
  if (known.length === 0) return ['Rules need the account\'s workspaces, which are not known yet. Start a new Copilot session and try again.'];
  const context = ctx == null ? createRouteContext() : ctx;
  const place = placeOfDir(dir, context);
  const out = [];
  known.forEach((row, i) => {
    if (known.length > 1) {
      if (i > 0) out.push('');
      out.push(`**${row.email || row.name || row.key}**`, '');
    }
    const route = place == null ? null : routeOfDir(row, dir, context);
    if (route != null) out.push(...hereSentences(row, place, route), '');
    const hereRule = route != null && route.reason.kind === 'rule' ? route.reason.index : null;
    const mark = (isHere) => (route == null ? [] : [isHere ? HERE_MARK : '']);
    const counts = countsByKey.has(row.key) ? countsByKey.get(row.key) : NO_COUNTS;
    const header = ['Rule', 'Repo or folder', 'Path or remote', 'Sends to', 'Last 30 days'].concat(route == null ? [] : ['']);
    out.push(tableRow(header), `|${header.map(() => '---').join('|')}|`);
    for (const r of rulesOf(row)) {
      const where = r.kind === 'outside' ? OUTSIDE_WHERE : r.label;
      const sends = r.tenantIds.length === 0 ? 'not tracked' : joinTenantNames(row, r.tenantIds);
      const n = counts.rules.has(r.index) ? counts.rules.get(r.index) : 0;
      out.push(tableRow([`R${r.index}`, shortLabel(r), where, sendsCell(row, r.tenantIds, sends), sessionsText(n)].concat(mark(hereRule === r.index))));
    }
    const scope = isMultiTenant(row) ? 'new repos and folders' : 'every repo and folder';
    const target = sendsCell(row, defaultRoute(row).ids, defaultTarget(row));
    out.push(tableRow(['Default', scope, '', target, sessionsText(counts.default)].concat(mark(hereRule == null))));
  });
  return out;
}
