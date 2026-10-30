// SessionStart's workspace ask and notices, and the pending-ask summary shown by /beezi-local-status and /beezi-local-settings.
import { isMultiTenant, joinTenantNames, newTenantsOf, roleLabel, tenantById } from '../workspace/tenants.mjs';
import { listSessionWorkspaces, readSessionWorkspace } from '../workspace/session-routes.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { QUEUE_HOLD_MS } from '../contract/queue-policy.mjs';
import { bindSessionRoutes } from '../workspace/routing.mjs';
import { createRouteContext, routeKeyForDir } from '../workspace/route-key.mjs';
import { ruleReasonText, rulesOf, shortLabel, usesRules } from '../workspace/rule-model.mjs';
import { unattendedStatus, UnattendedSignal } from '../host/attendance.mjs';
import { displayText } from '../auth/whoami.mjs';
import { pluginRoot as installRoot } from '../config/plugin-root.mjs';
import { AccountStatus, listAccounts as _listAccounts } from '../accounts/index-store.mjs';
import { markJoinNoticed } from '../workspace/settings-store.mjs';
import { sessionFor } from '../auth/recipients.mjs';

// Only a new session asks; resume never does (Copilot has no clear or compact source).
export const ASK_SOURCES = ['startup', 'new'];
const ALL_LABEL = 'All of these workspaces';
const SEVERAL_LINE = 'You can pick more than one: type their names separated by commas.';
const DONT_TRACK_MIXED = '"Don\'t track" can\'t be combined with a workspace — pick one or the other.';
// With no autopilot signal at all the ask cannot be told from an auto-answered one, so it relays a line instead.
const RELAY_TEXT = 'Tell the user in one line: "Beezi is holding this folder\'s analytics until you choose a workspace. Run /beezi-local-settings rules."';

// The plugin root for printed `node "<root>/scripts/…"` commands (the env var, else module-relative).
export function pluginRoot(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const root = deps.pluginRoot != null
    ? deps.pluginRoot
    : (env.COPILOT_PLUGIN_ROOT || env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || installRoot());
  return root.replace(/\\/g, '/');
}

export async function linkedRows(deps) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((a) => a.status === AccountStatus.LINKED);
}

// Only rows with a usable login (runSessionStart's "linked" test): one whose credentials are gone is neither asked nor told.
export async function withUsableLogin(rows, deps) {
  const live = await Promise.all(rows.map((row) => sessionFor(row.key, deps).catch(() => null)));
  return rows.filter((row, i) => live[i] != null);
}

function inputCwd(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
}

// Every value below lands inside a quoted or backticked span of text the model follows, so none may close the span or
// start a line. Names are already cleaned where whoami reads them; this also covers folder labels and stored rows.
function inline(value) {
  const text = displayText(value, null);
  return text == null ? '' : text;
}

// A multi-workspace row's tenantName is the web-side workspace, so accounts are named by email.
export function emailOf(row) {
  return inline(row.email || row.key);
}

export function nameOf(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

// How the targets notice names a place: a folder's ~ path, a repo's name, or sessions outside a project.
function noticePlace(key) {
  if (key == null) return 'this folder';
  if (key.kind === 'outside') return 'sessions outside a project';
  if (key.kind === 'folder' && key.label) return inline(key.label);
  return inline(shortLabel(key)) || 'this folder';
}

// The question wording for this session's own directory: a repo, a folder, or the one "outside a project" place.
function placeOf(key) {
  if (key != null && key.kind === 'outside') {
    return {
      question: 'Where should analytics for sessions outside a project folder go?',
      dontTrack: 'Don\'t track these',
    };
  }
  const short = inline(shortLabel(key));
  // A folder rule covers everything under it, so its question names the whole path and says so.
  const asked = key != null && key.kind === 'folder'
    ? `${inline(key.label)}, the folder you're in (and everything inside it),`
    : `${short}, the repo you're in,`;
  return {
    question: `Where should analytics for ${asked} go?`,
    dontTrack: `Don't track ${short}`,
  };
}

function choiceList(choices) {
  const texts = choices.map((c) => `"${inline(c)}"`);
  return texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

// One account's single-choice question and the command its answer runs. ask_user choices are
// plain strings with no descriptions or multi-select, so several workspaces go through "All of these workspaces"
// or typed names, which the question invites and the CLI resolves by id, name or position and refuses when unknown.
function accountAsk(row, resolved, place, { sessionId, root, several }) {
  const tenants = resolved.tenants.filter((t) => resolved.askTenants.indexOf(t.id) !== -1);
  const label = (t) => inline(t.name ? t.name : t.id);
  const choices = tenants.map(label).concat([ALL_LABEL, place.dontTrack]);
  return {
    row,
    question: `${place.question}${several ? ` (${emailOf(row)})` : ''} ${SEVERAL_LINE}`,
    choices,
    command: `node "${root}/scripts/workspace.mjs" rule add --current --session ${sessionId} --account ${row.key} '<ids>'`,
    ids: tenants.map((t) => `${label(t)} = ${inline(t.id)}${inline(roleLabel(t)) ? ` (${inline(roleLabel(t))})` : ''}`).join(', '),
    allIds: tenants.map((t) => inline(t.id)).join(','),
    dontTrack: place.dontTrack,
  };
}

function promptText(asks) {
  const several = asks.length > 1;
  const steps = asks.map((ask) => {
    const lead = several ? `For ${emailOf(ask.row)}, use` : 'Use';
    return `${lead} the ask_user tool to ask: "${ask.question}" with the choices ${choiceList(ask.choices)}.`
      + ` Then run exactly \`${ask.command}\`. \`<ids>\` is the chosen workspace's id (${ask.ids}), \`${ask.allIds}\` when "${ALL_LABEL}" is chosen,`
      + ` the workspace names unchanged when the user types several separated by commas, or \`none\` when "${ask.dontTrack}" is the whole answer.`
      + ` When the answer has "${ask.dontTrack}" together with a workspace, run nothing and ask the same question once more, starting with ${DONT_TRACK_MIXED} A second mixed answer is a dismissal.`
      + ` Before running it, escape each ' inside '<ids>' for the shell you run it in: '\\'' in bash or sh, '' in PowerShell, where each ‘ ’ ‚ ‛ is doubled too.`;
  });
  const head = 'Before doing anything else, ask the user where these analytics go.'
    + (several ? ' Ask one question per message and wait for each answer before the next.' : '');
  const tail = 'Show the user only the first line of each command\'s output. If a question is dismissed or nothing is chosen, run nothing for it and continue with the user\'s request.';
  return [head, ...steps, tail].join(' ');
}

// Binds each rule-using account's rule for this directory (null unbinds); the pending (multi-workspace) rows, or null when none.
export async function markPendingWorkspace(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const sessionId = input.session_id;
  const cwd = inputCwd(input);
  const rows = await linkedRows(deps);
  const bound = rows.filter(usesRules);
  if (bound.length === 0) return null;
  const ctx = createRouteContext();
  // Re-matched on every start: a rule added since binds, a removed one unbinds.
  // Written even when nothing is pending: it keeps this the newest session in its directory for the cwd fallback.
  const state = bindSessionRoutes(sessionId, cwd, bound, ctx);
  if (state == null) return null;
  const multi = rows.filter(isMultiTenant);
  const pending = multi
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => r.resolved.pendingAsk);
  return pending.length === 0 ? null : { pending, cwd, ctx, several: rows.length > 1 };
}

// SessionStart: re-binds on every source; the ask text on startup or new, or null when nothing is pending.
// An autopilot, -p or ask_user-off session gets no ask: an auto-answered question must never create a rule,
// so its reports stay held. With no signal at all it relays one line instead of asking.
export async function buildWorkspacePrompt(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const marked = await markPendingWorkspace(input, deps);
  if (marked == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const status = (deps.unattendedStatus || unattendedStatus)({ input, sessionId: input.session_id });
  if (status.unattended) return null;
  const usable = await withUsableLogin(marked.pending.map((p) => p.row), deps);
  const pending = marked.pending.filter((p) => usable.indexOf(p.row) !== -1);
  if (pending.length === 0) return null;
  if (status.signal === UnattendedSignal.NO_SIGNAL) return RELAY_TEXT;
  const place = placeOf(routeKeyForDir(marked.cwd, marked.ctx));
  const root = pluginRoot(deps);
  const asks = pending.map(({ row, resolved }) => accountAsk(row, resolved, place, {
    sessionId: input.session_id, root, several: marked.several,
  }));
  return promptText(asks);
}

// "rule R1" for the stored rule a bound route came from (any outside rule matches an outside route), else "rule".
// The notice names the rule's own place, so it is never "for" a parent folder.
function ruleName(row, rule) {
  const stored = rulesOf(row).find((r) => r.kind === rule.kind && (r.kind === 'outside' || r.match === rule.match));
  return ruleReasonText(stored == null ? null : stored.index, true, null);
}

// SessionStart: the "→ not tracked" lines the hook relays to the user, one per account whose own rule sends nothing
// from here, or null when none. New folders set to Don't send was chosen machine-wide, so it is never relayed (D2).
export async function buildTargetsNotice(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const rows = await linkedRows(deps);
  const state = readSessionWorkspace(input.session_id);
  // A no-rules one-workspace row can never produce a line here (resolveTargets gives 'single'), so skip its credential read.
  const shown = await withUsableLogin(rows.filter((row) => isMultiTenant(row) || usesRules(row)), deps);
  const lines = [];
  for (const row of shown) {
    const resolved = resolveTargets(row, state);
    if (resolved.source !== 'rule' || resolved.targets.length !== 0) continue;
    const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
    const route = `${noticePlace(resolved.rule)} → not tracked (${ruleName(row, resolved.rule)})`;
    lines.push(`${prefix}: ${route}. Nothing from this session is sent. Track it again with /beezi-local-settings.`);
  }
  return lines.length === 0 ? null : lines.join('\n');
}

// SessionStart: the line announcing workspaces joined since the last notice here, and how to mark them announced once relayed; null when none.
export async function buildJoinedNotice() {
  const rows = (await _listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  const lines = [];
  const marks = [];
  for (const row of rows) {
    const announced = Array.isArray(row.joinNoticedTenantIds) ? row.joinNoticedTenantIds : [];
    const ids = newTenantsOf(row).filter((id) => announced.indexOf(id) === -1);
    if (ids.length === 0) continue;
    const prefix = rows.length > 1 ? `Beezi (${row.email ? row.email : row.key})` : 'Beezi';
    lines.push(`${prefix}: you joined ${joinTenantNames(row, ids)}. Run /beezi-local-sync to choose which repos send analytics there.`);
    marks.push({ key: row.key, ids });
  }
  if (lines.length === 0) return null;
  return {
    text: lines.join(' '),
    mark: async () => {
      for (const m of marks) {
        try { await markJoinNoticed(m.key, m.ids); } catch { /* announced again next session */ }
      }
    },
  };
}

// Sessions with no answer yet, grouped by account and repo or folder, for the notice at the next SessionStart in any folder
// and in /beezi-local-status and /beezi-local-settings. Age comes from the session file, so `expiresAt` approximates when held reports lapse.
// Each entry: { accountKey, email, label, sessions, oldestAt, expiresAt }. `excludeSessionId` leaves out the session being asked.
export async function pendingAskSummary(deps = {}) {
  try {
    const multi = (await linkedRows(deps)).filter(isMultiTenant);
    if (multi.length === 0) return [];
    const now = deps.now == null ? Date.now() : deps.now;
    const ctx = createRouteContext();
    const groups = new Map();
    for (const { sessionId, state } of listSessionWorkspaces()) {
      if (deps.excludeSessionId != null && sessionId === deps.excludeSessionId) continue;
      const updated = Date.parse(state.updatedAt);
      if (!Number.isFinite(updated) || now - updated > QUEUE_HOLD_MS) continue;
      const key = state.cwd == null ? null : routeKeyForDir(state.cwd, ctx);
      for (const row of multi) {
        if (!resolveTargets(row, state).pendingAsk) continue;
        const id = `${row.key}\n${key == null ? '' : `${key.kind}\n${key.match}`}`;
        let group = groups.get(id);
        if (group == null) {
          group = { accountKey: row.key, email: row.email || null, label: key == null ? 'an unknown folder' : shortLabel(key), sessions: 0, oldestMs: updated };
          groups.set(id, group);
        }
        group.sessions += 1;
        if (updated < group.oldestMs) group.oldestMs = updated;
      }
    }
    return Array.from(groups.values()).map((g) => ({
      accountKey: g.accountKey,
      email: g.email,
      label: g.label,
      sessions: g.sessions,
      oldestAt: new Date(g.oldestMs).toISOString(),
      expiresAt: new Date(g.oldestMs + QUEUE_HOLD_MS).toISOString(),
    }));
  } catch {
    return [];
  }
}

// One line for the summary, or null when it is empty.
export function pendingAskNotice(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return null;
  const total = summary.reduce((sum, g) => sum + g.sessions, 0);
  const labels = summary.map((g) => inline(g.label)).filter((label, i, all) => all.indexOf(label) === i);
  const shown = labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ');
  const until = summary.map((g) => g.expiresAt).sort()[0].slice(0, 10);
  const plural = total === 1;
  return `Beezi: ${total} session${plural ? '' : 's'} in ${shown} ${plural ? 'is' : 'are'} waiting for a workspace choice (held until ${until}). Run /beezi-local-settings rules.`;
}
