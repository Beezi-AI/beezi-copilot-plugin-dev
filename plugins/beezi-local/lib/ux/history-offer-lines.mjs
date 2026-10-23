// The past-sessions offer copy (K7): the summary lines, the question, and the decline and accept lines.
import { joinNames, plural } from '../core/text.mjs';

export const SUBAGENT_TEXT = 'subagent names';
export const SYNC_COMMAND = '/beezi-local-sync';

const AGENT = 'Copilot';
const TITLE_NOTE = ' (the Copilot CLI uses your first message when a session has no name or summary)';
const MAX_FOLDERS = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_ITEMS = [
  ['repos', 'folder and repository names'],
  ['branches', 'branch names'],
  ['hosts', 'computer name'],
  ['accounts', 'GitHub login'],
];

const dayOf = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

// "on 3 Oct", "from 12 Aug to 21 Oct", or with both years when the range crosses one.
function dateRange(firstMs, lastMs) {
  const first = new Date(firstMs);
  const last = new Date(lastMs);
  if (first.getFullYear() !== last.getFullYear()) return `from ${dayOf(first)} ${first.getFullYear()} to ${dayOf(last)} ${last.getFullYear()}`;
  if (first.getMonth() === last.getMonth() && first.getDate() === last.getDate()) return `on ${dayOf(first)}`;
  return `from ${dayOf(first)} to ${dayOf(last)}`;
}

function folderPart(folders) {
  if (folders.length === 0) return '';
  const shown = folders.length > MAX_FOLDERS ? [...folders.slice(0, MAX_FOLDERS), `${folders.length - MAX_FOLDERS} more`] : folders;
  return ` in ${plural(folders.length, 'folder')}: ${joinNames(shown)}`;
}

// → { lines: [L1, L2, L3?, L4?, L5], question }.
export function offerLines({ count, firstMs, lastMs, folders, kinds, workspace }) {
  const on = (kind) => kinds.indexOf(kind) !== -1;
  const shown = KIND_ITEMS.filter(([kind]) => !on(kind)).map(([, item]) => item);
  const hidden = KIND_ITEMS.filter(([kind]) => on(kind)).map(([, item]) => item);
  const lines = [
    `Beezi found ${plural(count, `past ${AGENT} session`)} ${dateRange(firstMs, lastMs)}${folderPart(folders)}.`,
    'Uploading sends dates, duration, models, tokens, cost, and tool, skill and MCP names for each session.',
  ];
  if (shown.length > 0) lines.push(`Sent as they are: ${joinNames(shown)}.`);
  if (hidden.length > 0) lines.push(`Hidden by your workspace: ${joinNames(hidden)}. Beezi receives made-up names instead.`);
  lines.push(on('sessions')
    ? `Session titles, error messages and ${SUBAGENT_TEXT} are not sent.`
    : `Also sent as written: session titles${TITLE_NOTE}, error messages (up to 1,000 characters) and ${SUBAGENT_TEXT}.`);
  const question = count === 1 ? `Upload this session to ${workspace}?` : `Upload these ${count} sessions to ${workspace}?`;
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
