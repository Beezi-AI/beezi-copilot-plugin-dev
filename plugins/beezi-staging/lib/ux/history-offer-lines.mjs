// The past-sessions offer copy (K7 wording, K7-C layout): the summary lines, the question, the decline and accept lines,
// and the no-ask notice and several-workspace summary.
import { joinNames, plural } from '../core/text.mjs';

export const SUBAGENT_TEXT = 'subagent names';
export const SUBAGENT_SHORT = 'subagent names';
export const SYNC_COMMAND = '/beezi-staging-sync';

const AGENT = 'Copilot';
const TITLE_NOTE = ' (the Copilot CLI uses your first message when a session has no name or summary)';
const MAX_FOLDERS = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_ITEMS = [
  ['repos', 'folder and repository names'],
  ['branches', 'branch names'],
  ['hosts', 'computer name'],
  ['accounts', 'GitHub login'],
];
const HIDE_WORDS = [['repos', 'repos'], ['branches', 'branches'], ['hosts', 'computer names'], ['accounts', 'accounts']];
const ALWAYS_SENT = '  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names';

const dayOf = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

// "3 Oct", "12 Aug – 21 Oct", or with both years when the range crosses one.
function dateRange(firstMs, lastMs) {
  const first = new Date(firstMs);
  const last = new Date(lastMs);
  if (first.getFullYear() !== last.getFullYear()) return `${dayOf(first)} ${first.getFullYear()} – ${dayOf(last)} ${last.getFullYear()}`;
  if (first.getMonth() === last.getMonth() && first.getDate() === last.getDate()) return dayOf(first);
  return `${dayOf(first)} – ${dayOf(last)}`;
}

// "  in a, b, c +k more": at most MAX_FOLDERS names.
function folderLine(folders) {
  const more = folders.length > MAX_FOLDERS ? ` +${folders.length - MAX_FOLDERS} more` : '';
  return `  in ${folders.slice(0, MAX_FOLDERS).join(', ')}${more}`;
}

// Hidden items two per line, in K7 order; an odd last item stands alone.
function hiddenLines(hidden) {
  const lines = [];
  for (let i = 0; i < hidden.length; i += 2) lines.push(`    ◆ ${hidden.slice(i, i + 2).join(', ')}`);
  return lines;
}

// → { lines: the plain K7-C lines H1 to N1, question }.
export function offerLines({ count, firstMs, lastMs, folders, kinds, workspace }) {
  const on = (kind) => kinds.indexOf(kind) !== -1;
  const shown = KIND_ITEMS.filter(([kind]) => !on(kind)).map(([, item]) => item);
  const hidden = KIND_ITEMS.filter(([kind]) => on(kind)).map(([, item]) => item);
  const folderCount = folders.length > 0 ? `, ${plural(folders.length, 'folder')}` : '';
  const lines = [`Beezi found ${plural(count, `past ${AGENT} session`)} (${dateRange(firstMs, lastMs)}${folderCount})`];
  if (folders.length > 0) lines.push(folderLine(folders));
  lines.push('  Sent', '    ✓ dates, duration, models, tokens, cost', '    ✓ tool, skill and MCP names');
  if (shown.length > 0) lines.push(`    ✓ ${joinNames(shown)}, as they are`);
  if (!on('sessions')) lines.push(`    ✓ session titles${TITLE_NOTE}, error messages (up to 1,000 characters) and ${SUBAGENT_TEXT}, as written`);
  if (hidden.length > 0) lines.push('  Hidden by your workspace — Beezi gets made-up names', ...hiddenLines(hidden));
  if (on('sessions')) lines.push('  Never sent', `    ✕ session titles, error messages and ${SUBAGENT_SHORT}`);
  const question = count === 1 ? `Upload this session to ${workspace}?` : `Upload ${count} sessions to ${workspace}?`;
  return { lines, question };
}

export function declineLine(audit) {
  return audit
    ? `Your audit reads only past sessions, so it stays empty until you upload. Run ${SYNC_COMMAND} any time.`
    : `Not uploaded. Run ${SYNC_COMMAND} any time to upload them.`;
}

export function acceptLine(count, workspace) {
  return `Beezi: uploading ${plural(count, 'past session')} to ${workspace} in the background.`;
}

// What a workspace hides, in a few words: its made-up names, then whether titles are sent.
export function hidesPhrase(kinds) {
  const names = HIDE_WORDS.filter(([kind]) => kinds.indexOf(kind) !== -1).map(([, word]) => word);
  const titles = kinds.indexOf('sessions') !== -1;
  if (names.length === 0) return titles ? 'names as they are, titles never sent' : 'names and titles as they are';
  return `made-up names for ${joinNames(names)}${titles ? ', titles never sent' : ''}`;
}

// `workspace` may be several names already joined.
export function progressLine(count, workspace) {
  return `Uploading ${plural(count, 'session')} to ${workspace}…`;
}

// In place of a no-ask workspace's question: who chose it, then the upload.
export function noAskLines(count, workspace) {
  return [`${workspace} uploads past sessions without asking, so there's no question.`, progressLine(count, workspace)];
}

const workspaceLine = (mark) => ({ workspace, count, kinds }) => `    ${mark} ${workspace} · ${plural(count, 'session')} · ${hidesPhrase(kinds)}`;

// Several workspaces' summary; `uploads` and `asks` are [{ workspace, count, kinds }], `count` the distinct sessions of all.
export function combinedLines({ count, firstMs, lastMs, uploads, asks }) {
  const lines = [`Beezi found ${plural(count, `past ${AGENT} session`)} (${dateRange(firstMs, lastMs)})`, ALWAYS_SENT];
  if (uploads.length > 0) lines.push('  Uploading without a question — these workspaces chose that', ...uploads.map(workspaceLine('✓')));
  if (asks.length > 0) lines.push('  Asks you first', ...asks.map(workspaceLine('?')));
  return lines;
}

// " too" only when no-ask workspaces upload in the same block (R16).
export function combinedQuestion(workspaces, too) {
  return `Upload your past sessions to ${joinNames(workspaces)}${too ? ' too' : ''}?`;
}

export function allChoice(n) {
  return n === 2 ? 'Upload to both' : `Upload to all ${n}`;
}
