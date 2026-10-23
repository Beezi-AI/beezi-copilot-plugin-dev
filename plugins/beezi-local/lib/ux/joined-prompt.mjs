// SessionStart's joined-workspace ask for attended sessions, the one-time line for a finished history upload, and the past-sessions offer prompt.
import { joinTenantNames, newTenantsOf, offerableTenantIds } from '../workspace/tenants.mjs';
import { OfferAction, offerAction, offerTrackingDisabled, resultLine, takeResults } from '../workspace/pending-history.mjs';
import { readTrackingState } from '../state/tracking.mjs';
import { pastSessionsFor } from '../core/anon-target.mjs';
import { takeHistoryResults as _takeHistoryResults } from '../workspace/settings-store.mjs';
import { ASK_SOURCES, emailOf, linkedRows, nameOf, pluginRoot, withUsableLogin } from './workspace-prompt.mjs';

// A quoted literal, so make-variant's /beezi-<skill> rewrite renames both the mention and the skill folder path.
const SYNC_SKILL = '/beezi-local-sync';

// The re-check before the separate current-folder question, which the joined pass may already have answered.
function folderRecheck(sessionId, root) {
  return `(5) if a separate question about where this session's own folder's analytics go follows, first run EXACTLY \`node "${root}/scripts/workspace.mjs" rules --session ${sessionId} --account <key>\`, with <key> the --account value of that question's command, and ask it only when the \`here:\` line shows rule=none; otherwise skip that question and its command.`;
}

function joinedPromptText(rows, root, sessionId) {
  const who = rows.length === 1 ? `${emailOf(rows[0])} joined ${joinTenantNames(rows[0], newTenantsOf(rows[0]))}` : 'these Beezi accounts joined new workspaces';
  const commands = rows.map((row) => `\`node "${root}/scripts/workspace.mjs" joined --account ${row.key}\``).join(', then ');
  return [
    `Beezi: ${who}. Before doing anything else, run EXACTLY ${commands}.`,
    'If it prints joined=0, say nothing about this.',
    `Otherwise read "${root}/skills${SYNC_SKILL}/SKILL.md" and follow its "First, new workspaces" part from "Lines:" up to the paragraph that begins "Then, repos and folders with no rule. Run", for that output only, with these changes:`,
    '(1) always ask the first question ("You joined …") first, with the ask_user tool, even with 4 or fewer J lines, and add the choice "Later — ask me again in my next session", which runs nothing; on "Choose repos", ask for each new workspace "Which repos and folders should also send analytics to <name>?" (worded as in that skill) with the J lines as numbered choices ending in "None of these" ("None of these", alone or with other choices, wins: run no J-command for that question, though it still counts as an answer), and for each picked one run its `joined pick` J-command with that workspace\'s tenant id;',
    '(2) leave out the "Add … to all" choice when every J line ends in now=pending or now=none;',
    '(3) a dismissed question runs nothing; it is asked again next session;',
    '(4) stop after that part: run neither routes nor sync.mjs; these answers upload nothing, and past sessions for the new workspaces are offered separately through history-offer.mjs with their own "Upload" / "Not now" question.',
    sessionId == null ? null : folderRecheck(sessionId, root),
    'Then continue with the user\'s request.',
  ].filter((part) => part != null).join(' ');
}

// SessionStart: the joined re-pick on startup or new, asked until the join is reviewed; null when nothing is new.
// Only for attended sessions: the hook decides attendance.
export async function buildJoinedPrompt(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const fresh = (await linkedRows(deps)).filter((row) => newTenantsOf(row).length > 0);
  if (fresh.length === 0) return null;
  const rows = await withUsableLogin(fresh, deps);
  const sessionId = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
  return rows.length === 0 ? null : joinedPromptText(rows, pluginRoot(deps), sessionId);
}

// Local reads only (the row and tracking.json): whether any workspace of the row passes the offer gate.
function offersPastSessions(row, readTracking) {
  const tracking = readTracking(row.key);
  return offerableTenantIds(row).some((id) => offerAction(row, id, {
    pastSessions: pastSessionsFor(row, id),
    trackingDisabled: offerTrackingDisabled(row, id, tracking),
  }).action === OfferAction.SCAN);
}

function historyOfferText(rows, root, sessionId) {
  const session = sessionId == null ? '' : ` --session ${sessionId}`;
  const commands = rows.map((row) => `\`node "${root}/scripts/history-offer.mjs" --via session-start --account ${row.key}${session}\``).join(', then ');
  return [
    `Beezi: past sessions may be ready to upload. Run EXACTLY ${commands}.`,
    'If it prints offers=0, say nothing about this.',
    'Otherwise, for each <offer> block in order: write its lines before question= verbatim, then ask with the ask_user tool the question= text with the choices "Upload" and "Not now".',
    'On "Upload" run that block\'s accept-command= text EXACTLY and show its first line.',
    'On any other answer, a dismissed question or no answer, run its decline-command= text EXACTLY and show nothing from it.',
    'Never answer the question yourself. Then continue with the user\'s request.',
  ].join(' ');
}

// SessionStart on startup or new: the instruction to run the offer command, or null when no workspace is offered.
// Only for attended sessions: the hook decides attendance; the command scans, asks and records the decline.
export async function buildHistoryOfferPrompt(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const readTracking = deps.readTracking == null ? readTrackingState : deps.readTracking;
  const rows = (await linkedRows(deps)).filter((row) => offersPastSessions(row, readTracking));
  const sessionId = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
  return rows.length === 0 ? null : historyOfferText(rows, pluginRoot(deps), sessionId);
}

// SessionStart on startup or new: { text, mark } for the oldest finished history upload, or null; mark() takes exactly that result.
export async function buildHistoryNotice(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const take = deps.takeHistoryResults == null ? _takeHistoryResults : deps.takeHistoryResults;
  const rows = await linkedRows(deps);
  for (const row of rows) {
    // takeResults on a copy peeks at the result mark() will take, skipping malformed entries the same way.
    const first = takeResults({ historyResults: row.historyResults }, 1)[0];
    if (first == null) continue;
    const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
    const text = resultLine(first, { prefix, nameOf: (id) => nameOf(row, id), syncName: SYNC_SKILL });
    return { text, mark: () => take(row.key, 1).catch(() => []) };
  }
  return null;
}
