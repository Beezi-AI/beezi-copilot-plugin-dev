// Text for /beezi-dev-settings rules and workspaces: account, workspace and place labels, and every workspace.mjs machine line.
import { newFoldersOf } from '../workspace/targets.mjs';
import { isSingleTenant, joinTenantNames, roleLabel, tenantById, tenantsOf } from '../workspace/tenants.mjs';
import { shortLabel } from '../workspace/rule-model.mjs';
import { routeKeyForDir } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { placeOfDir, routeOfDir } from '../workspace/route-describe.mjs';
import { pluginRoot } from './workspace-prompt.mjs';
import { machineLine, withFields } from './machine-lines.mjs';
import { plural } from '../core/text.mjs';

export function accountLabel(row) {
  if (row.email) return row.email;
  return row.name ? row.name : row.key;
}

export function tenantName(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

export function tenantNames(row, ids) {
  return ids.map((id) => tenantName(row, id)).join(', ');
}

export function sendList(row, ids) {
  return ids.length === 0 ? 'not tracked' : tenantNames(row, ids);
}

export function idList(ids) {
  return ids.length === 0 ? 'none' : ids.join(',');
}

export function sessionsCount(n) {
  return plural(n, 'session');
}

export function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${tenantNames(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// A rule's place in a sentence: its short name, or "sessions outside a project".
export function placeOf(key) {
  return key.kind === 'outside' ? 'sessions outside a project' : shortLabel(key);
}

// A rule or place in a machine line: its short name, then its full label in parentheses (none for outside).
export function labeled(key) {
  return key.kind === 'outside' ? shortLabel(key) : `${shortLabel(key)} (${key.label})`;
}

// A literal /beezi-dev-settings, so variant builds rename it with the other skill names.
const UNDO_HINT = ' Undo: /beezi-dev-settings undo';
const DONE = '✓ ';

// Where a write sends, in a confirmation line: "Acme and Northwind" or "not tracked".
export function targetWords(row, ids) {
  return ids.length === 0 ? 'not tracked' : joinTenantNames(row, ids);
}

// A write's confirmation: its line, and the wording undo uses (`change`, default the line without "✓ "; `was` a set's old target).
function confirmation(line, change = line.slice(DONE.length), was = null) {
  return { line, summary: line.slice(DONE.length), change, was };
}

export function ruleAddedConfirmation(row, key, tenantIds, n) {
  return confirmation(`${DONE}${placeOf(key)} → ${targetWords(row, tenantIds)} (rule R${n}).`);
}

export function ruleSetConfirmation(row, rule, tenantIds) {
  const change = `${placeOf(rule)} → ${targetWords(row, tenantIds)} (rule R${rule.index}).`;
  const was = targetWords(row, rule.tenantIds);
  return confirmation(`${DONE}${change} Before: ${was}.`, change, was);
}

// `row` is the account before the removal: its kind and New folders say what the place follows now.
export function ruleRemovedConfirmation(row, removed) {
  const ruleText = `rule R${removed.index} (${placeOf(removed)}).`;
  const follows = isSingleTenant(row)
    ? 'It\'s tracked again unless another rule covers it.'
    : `New sessions there follow the default (${newFoldersLabel(row)}).`;
  return confirmation(`${DONE}Removed ${ruleText} ${follows}`, `removed ${ruleText}`);
}

export function rulesAddedConfirmation(row, n, tenantIds) {
  const those = n === 1 ? 'that repo or folder' : 'those repos and folders';
  const where = tenantIds.length === 0 ? `${those} ${n === 1 ? 'is' : 'are'} not tracked` : `${those} → ${joinTenantNames(row, tenantIds)}`;
  const rulesText = `${plural(n, 'rule')}: ${where}.`;
  return confirmation(`${DONE}Added ${rulesText}`, `added ${rulesText}`);
}

export function newFoldersConfirmation(row, mode, tenantIds) {
  if (mode === 'send') return confirmation(`${DONE}New folders → ${joinTenantNames(row, tenantIds)}.`);
  if (mode === 'none') return confirmation(`${DONE}New folders: not tracked.`);
  return confirmation(`${DONE}New folders: Ask me — Beezi asks once per repo or folder.`);
}

// The undo hint is left off when the calling flow uploads next (login, setup).
export function withUndoHint(line, defer) {
  return defer ? line : `${line}${UNDO_HINT}`;
}

export const UNDO_NOTHING = 'Nothing to undo.';
export const UNDO_CHANGED = 'Nothing undone: the rules changed after that change.';
export const UNDO_MISSING = 'Nothing to undo: that account is no longer linked.';

// The undo confirmation from the recorded change.
export function undoneLine(record) {
  const back = record.was == null ? '' : ` It's back to ${record.was}.`;
  return `${DONE}Undid your last change: ${record.change}${back} Sessions already uploaded stay where they went.`;
}

export function ruleDone(row, key, tenantIds, changed) {
  const now = changed ? 'now ' : '';
  if (tenantIds.length > 0) return `✓ Analytics for ${placeOf(key)} ${now}go to ${tenantNames(row, tenantIds)}.`;
  return `✓ ${key.kind === 'outside' ? 'Sessions outside a project are' : `${placeOf(key)} is`} ${now}not tracked.`;
}

// The rule-add target flag for a place; single quotes keep $, backticks, " and \ in the match literal (Windows PowerShell doubles quotes instead).
export function ruleTargetFlag(place, platform = process.platform) {
  const quoted = platform === 'win32' ? place.match.replace(/['‘-‛]/g, '$&$&') : place.match.replace(/'/g, "'\\''");
  return place.kind === 'outside' ? '--outside' : `--${place.kind} '${quoted}'`;
}

// `name=node "<root>/scripts/workspace.mjs" <args>`: tool output does not expand the plugin-root variable, so the path is spelled out.
export function commandLine(name, args) {
  return machineLine([[name, `node "${pluginRoot()}/scripts/workspace.mjs" ${args}`]]);
}

// ` --defer-upload` for a printed command whose caller uploads next, else nothing; it goes right after `--account <key>`.
export function deferSuffix(defer) {
  return defer ? ' --defer-upload' : '';
}

// The command that answers one place with a rule.
export function ruleAddCommandLine(name, place, row, defer = false) {
  return commandLine(name, `rule add ${ruleTargetFlag(place)} --account ${row.key}${deferSuffix(defer)} <tenants>`);
}

// The command that adds one newly-joined workspace to a place.
export function joinedPickCommandLine(name, place, row, defer = false) {
  return commandLine(name, `joined pick ${ruleTargetFlag(place)} --account ${row.key}${deferSuffix(defer)} <tenant>`);
}

// The workspaces to offer, one line each; with `newIds`, new= says which were just joined. role= is last and may be empty.
export function workspaceLines(row, newIds = null) {
  return tenantsOf(row).map((t) => {
    const pairs = [['account', row.key], ['tenant', t.id]];
    if (newIds != null) pairs.push(['new', newIds.indexOf(t.id) === -1 ? 'no' : 'yes']);
    pairs.push(['role', roleLabel(t)]);
    return withFields(`W. ${t.name ? t.name : t.id}`, pairs);
  });
}

export function workspacesUnknownLine(row) {
  return withFields(`${accountLabel(row)}: workspaces not known yet; rules do not apply`, [['account', row.key]]);
}

// A one-workspace account says workspaces=1, so the skill offers only "not tracked".
export function rulesHeaderLine(row, count, single) {
  const pairs = [['account', row.key]];
  if (single) pairs.push(['workspaces', 1]);
  return withFields(`${accountLabel(row)}: ${count} rule(s)`, pairs);
}

// A stored rule: R<n>. <place> → <where it sends>.
export function ruleLine(row, rule, sends) {
  return withFields(`R${rule.index}. ${labeled(rule)} → ${sends}`, [
    ['account', row.key], ['rule', rule.index], ['kind', rule.kind], ['tenants', idList(rule.tenantIds)], ['match', rule.match],
  ]);
}

// The `here:` line: this directory's place, its rule, where it sends now (now=), its path (none outside a project), then the machine fields with match= last.
export function hereLine(row, dir, ctx) {
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return withFields('here: none', [['account', row.key]]);
  const rule = routeForDir(row, dir, ctx);
  const now = routeOfDir(row, dir, ctx);
  const place = key.kind === 'outside' ? null : placeOfDir(dir, ctx);
  const pairs = [['now', now.reason.kind === 'pending' ? 'pending' : idList(now.ids)]];
  if (place != null && place.path != null) pairs.push(['path', place.path]);
  pairs.push(['account', row.key], ['rule', rule == null ? 'none' : rule.index], ['kind', key.kind], ['match', key.match]);
  return withFields(`here: ${labeled(key)} → ${rule == null ? 'no rule' : `R${rule.index}`}`, pairs);
}

// The folder picker's header: how many places it offers.
export function pickerHeaderLine(row, count) {
  const places = count === 1 ? '1 repo or folder' : `${count} repos or folders`;
  return withFields(`${accountLabel(row)}: ${places} with recent sessions`, [['account', row.key]]);
}

// F<n>: a recent repo or folder with no rule of its own.
export function pickerLine(n, row, place) {
  return withFields(`F${n}. ${labeled(place)}, ${sessionsCount(place.sessions)}`, [['account', row.key], ['kind', place.kind], ['match', place.match]]);
}

export function routesHeaderLine(row, placeCount, sessionCount) {
  const places = placeCount === 1 ? '1 repo or folder has' : `${placeCount} repos or folders have`;
  return withFields(`${accountLabel(row)}: ${places} past sessions with no rule (${sessionsCount(sessionCount)})`, [['account', row.key]]);
}

// P<n>: a repo or folder with past sessions and no rule.
export function routeLine(n, row, place) {
  return withFields(`P${n}. ${labeled(place)}, ${sessionsCount(place.sessions)}`, [['account', row.key], ['kind', place.kind], ['match', place.match]]);
}

export function joinedHeaderLine(row, joinedNames, newIds, placeCount) {
  const count = placeCount === 1 ? '1 repo or folder' : `${placeCount} repos or folders`;
  return withFields(`${accountLabel(row)}: you joined ${joinedNames} — ${count} to review`, [['account', row.key], ['new', newIds.join(',')]]);
}

// J<n>: a place to re-pick and where it sends now (`now.pending` when it has no rule yet).
export function joinedLine(n, row, place, now) {
  const where = now.pending ? 'no rule yet' : sendList(row, now.ids);
  return withFields(`J${n}. ${labeled(place)}, ${sessionsCount(place.sessions)}, now: ${where}`, [
    ['account', row.key], ['kind', place.kind], ['match', place.match], ['now', now.pending ? 'pending' : idList(now.ids)],
  ]);
}
