import path from 'path';
import { fileURLToPath } from 'url';
import {
  isMultiTenant,
  listSessionWorkspaces,
  readSessionWorkspace,
  resolveTargets,
  roleLabel,
  tenantById,
  QUEUE_HOLD_MS,
} from './workspace.mjs';
import { bindSessionRoutes, createRouteContext, routeKeyForDir, shortLabel, usesRules } from './workspace-rules.mjs';
import { unattendedStatus, UnattendedSignal } from './workspace-session.mjs';
import { displayText } from './whoami.mjs';

// Only a new session asks; resume never does (Copilot has no clear or compact source).
const ASK_SOURCES = ['startup', 'new'];
const ALL_LABEL = 'All of these workspaces';
// With no autopilot signal at all the ask cannot be told from an auto-answered one, so it relays a line instead.
const RELAY_TEXT = 'Tell the user in one line: "Beezi is holding this folder\'s analytics until you choose a workspace. Run /beezi-staging-settings rules."';

// The plugin root for printed `node "<root>/scripts/…"` commands (V-16/V-26 env var, else module-relative).
export function pluginRoot(deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const root = deps.pluginRoot != null
    ? deps.pluginRoot
    : (env.COPILOT_PLUGIN_ROOT || env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  return root.replace(/\\/g, '/');
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// Only rows with a usable login (runSessionStart's "linked" test): one whose credentials are gone is neither asked nor told.
async function withUsableLogin(rows, deps) {
  const { sessionFor } = await import('./sessions.mjs');
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
function emailOf(row) {
  return inline(row.email || row.key);
}

function nameOf(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

// "A", "A and B", "A, B and C".
function names(row, ids) {
  const list = ids.map((id) => nameOf(row, id));
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// How the targets notice names a place: a folder's ~ path, a repo's name, or sessions outside a project.
function noticePlace(key) {
  if (key == null) return 'this folder';
  if (key.kind === 'outside') return 'sessions outside a project';
  if (key.kind === 'folder' && key.label) return inline(key.label);
  return inline(shortLabel(key)) || 'this folder';
}

// The question wording for this directory: a repo, a folder, or the one "outside a project" place.
function placeOf(key) {
  if (key != null && key.kind === 'outside') {
    return {
      question: 'Where should analytics for sessions outside a project folder go?',
      dontTrack: 'Don\'t track these',
    };
  }
  const short = shortLabel(key);
  // A folder rule covers everything under it, so its question names the whole path and says so.
  const asked = key != null && key.kind === 'folder' ? `${inline(key.label)} (and everything inside it)` : inline(short);
  return {
    question: `Where should analytics for ${asked} go?`,
    dontTrack: key != null && key.kind === 'repo' ? 'Don\'t track this repo' : 'Don\'t track this folder',
  };
}

function choiceList(choices) {
  const texts = choices.map((c) => `"${inline(c)}"`);
  return texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

// One account's single-choice question and the command its answer runs. V-39 is open: ask_user choices are
// plain strings with no descriptions or multi-select, so several workspaces go through "All of these workspaces"
// or a typed comma list, which the CLI resolves by id, name or position and refuses when unknown.
function accountAsk(row, resolved, place, { sessionId, root, several }) {
  const tenants = resolved.tenants.filter((t) => resolved.askTenants.indexOf(t.id) !== -1);
  const label = (t) => inline(t.name ? t.name : t.id);
  const choices = tenants.map(label).concat([ALL_LABEL, place.dontTrack]);
  return {
    row,
    question: several ? `${place.question} (${emailOf(row)})` : place.question,
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
      + ` the workspace names unchanged when the user types several separated by commas, or \`none\` when "${ask.dontTrack}" is chosen; it wins over the others.`
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
  const status = (deps.unattendedStatus || unattendedStatus)({ env: process.env, input, sessionId: input.session_id });
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

// SessionStart: { context, notTracked } or null. `context` is one line per account for the model; `notTracked` is the
// "is not tracked (your rule)" lines, which the hook relays to the user. An unattended session that is waiting for a choice says its reports are held.
export async function buildTargetsNotice(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const rows = await linkedRows(deps);
  const state = readSessionWorkspace(input.session_id);
  // A no-rules one-workspace row can never produce a line here (resolveTargets gives 'single'), so skip its credential read.
  const shown = await withUsableLogin(rows.filter((row) => isMultiTenant(row) || usesRules(row)), deps);
  const ctx = createRouteContext();
  let here;
  const hereKey = () => {
    if (here === undefined) here = routeKeyForDir(state != null && state.cwd != null ? state.cwd : inputCwd(input), ctx);
    return here;
  };
  let unattended = null;
  const isUnattendedNow = () => {
    if (unattended == null) unattended = (deps.unattendedStatus || unattendedStatus)({ env: process.env, input, sessionId: input.session_id }).unattended;
    return unattended;
  };
  const context = [];
  const notTracked = [];
  for (const row of shown) {
    const resolved = resolveTargets(row, state);
    const multi = isMultiTenant(row);
    const excluded = resolved.source === 'rule' && resolved.targets.length === 0;
    if (multi ? !(resolved.multi && (!resolved.pendingAsk || isUnattendedNow())) : !excluded) continue;
    const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
    const key = resolved.rule != null ? resolved.rule : hereKey();
    const where = noticePlace(key);
    if (resolved.pendingAsk) {
      const label = inline(shortLabel(key));
      context.push(`${prefix} → held${label ? ` · ${label}` : ''} until you choose a workspace (run /beezi-staging-settings rules)`);
    } else if (excluded) {
      notTracked.push(`${prefix}: ${where} ${key != null && key.kind === 'outside' ? 'are' : 'is'} not tracked (your rule). Change with /beezi-staging-settings.`);
    } else if (resolved.source === 'none') {
      context.push(`${prefix}: analytics from ${where} are not uploaded (new folders: don't send). Change with /beezi-staging-settings.`);
    } else {
      const fallback = resolved.source === 'new-folders' ? ' (new folder default)' : '';
      context.push(`${prefix}: analytics from ${where} go to ${names(row, resolved.targets)}${fallback}. Change with /beezi-staging-settings.`);
    }
  }
  if (context.length === 0 && notTracked.length === 0) return null;
  return {
    context: context.length === 0 ? null : context.join('\n'),
    notTracked: notTracked.length === 0 ? null : notTracked.join('\n'),
  };
}

// Sessions with no answer yet, grouped by account and repo or folder, for the notice at the next SessionStart in any folder
// and in /beezi-staging-status and /beezi-staging-settings. Age comes from the session file, so `expiresAt` approximates when held reports lapse.
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
  return `Beezi: ${total} session${plural ? '' : 's'} in ${shown} ${plural ? 'is' : 'are'} waiting for a workspace choice (held until ${until}). Run /beezi-staging-settings rules.`;
}
