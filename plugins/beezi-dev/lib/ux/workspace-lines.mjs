// Text for /beezi-dev-settings rules and workspaces: account, workspace and place labels, and every workspace.mjs machine line.
import { newFoldersOf } from '../workspace/targets.mjs';
import { roleLabel, tenantById, tenantsOf } from '../workspace/tenants.mjs';
import { shortLabel } from '../workspace/rule-model.mjs';
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

// This folder's place (`key`, null when unknown) and the rule that routes it (`route`, null when none).
export function hereLine(row, key, route) {
  if (key == null) return withFields('here: none', [['account', row.key]]);
  return withFields(`here: ${labeled(key)} → ${route == null ? 'no rule' : `R${route.index}`}`, [
    ['account', row.key], ['rule', route == null ? 'none' : route.index], ['kind', key.kind], ['match', key.match],
  ]);
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
