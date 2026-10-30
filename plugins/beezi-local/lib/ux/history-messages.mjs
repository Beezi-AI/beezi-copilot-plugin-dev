// What a history run's result means in words: /beezi-local-login's one-time import (backfill) and /beezi-local-sync, as outcome lines.
import { describeAccount } from '../accounts/refs.mjs';
import { newFoldersOf } from '../workspace/targets.mjs';
import { BackfillHalt } from '../contract/history.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { REAUTH_TEXT } from './capture-health.mjs';
import { tenantName } from './workspace-lines.mjs';
import { plural } from '../core/text.mjs';

// An outcome is stdout lines, then an optional error the caller prints as `✗ <error>` on stderr.
const ok = (...lines) => ({ lines, error: null });
const refused = (message) => ({ lines: [], error: message });
const orUnknown = (value) => (value == null ? 'unknown error' : value);

const FINALIZED_LINE = '✓ Beezi: your history pull is finalized.';
const DEFERRED_LINE = '  Your one-time history upload stays open until those repos and folders have a rule — run /beezi-local-login or /beezi-local-sync to choose.';
const PLAN_NOTE = '  Plan and billing details reflect your current setup, not the plan you were on at the time.';
export const NO_PAST_SESSIONS_LINE = '✓ Beezi: no past Copilot sessions found to upload.';
const NOT_LINKED = 'Beezi: this machine is not linked. Run /beezi-local-login first.';
const UNSUPPORTED_SERVER = 'Beezi: the server does not support the history pull yet — try again after the portal update.';

// "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still produce nothing to upload.
export function progressLine({ processed, total }) {
  return `Beezi: ${processed}/${total} sessions read…`;
}

export function runHeader(row, tenantId) {
  return `\n— ${describeAccount(row)} · ${tenantName(row, tenantId)} —`;
}

// The real count, after the live-session skip the audit already applies, not the pre-run plan.
export function excludedLine(label, excluded) {
  return `Beezi (${label}): ${plural(excluded, 'past session')} in repos or folders you don't track ${excluded === 1 ? 'is' : 'are'} skipped.`;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
export function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => tenantName(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// `  <n> <noun>s <text>` for every [n, text, noun] whose n is positive, in order.
function countLines(rows) {
  return rows.filter(([n]) => n > 0).map(([n, text, noun = 'session']) => `  ${plural(n, noun)} ${text}`);
}

const NO_REMOTE = 'could not be matched to a repository — not uploaded. Their session files record no working directory.';
const NO_USAGE_SUMMARY = 'ended without Copilot\'s usage summary (closed abruptly or still open elsewhere) — '
  + 'their activity was uploaded without token counts. If you resume one in Copilot, its tokens are added when it ends.';
const DEFERRED_OTHER = 'were still being written to and were left for the next run.';

// Sessions read but never sent, in the order both reports print them.
function notUploaded(result) {
  return [
    [result.noRemote, NO_REMOTE],
    [result.emitFailed, 'failed while being prepared — not uploaded.'],
    [result.unreadable, 'could not be read — not uploaded.'],
  ];
}

// The server's stored count against what we handed it. A silent shortfall here means reports were acknowledged but not persisted.
function shortfallLines(result) {
  if (!(result.plannedReports > result.reportsStored + result.reportsSkipped)) return [];
  return [`  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored and ${result.reportsSkipped} skipped by the server.`];
}

// The upload headline: sessions and reports stored, `middle`, then what the server skipped, rejected or never got.
function headline(result, middle, retry) {
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`].concat(middle);
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  // Sessions the server refused outright. Ledgered, so a re-run will not retry them — saying so is the only chance the user has to notice.
  if (result.sessionsRejected > 0) parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`);
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(`${plural(result.reportsFailed, 'report')} could not be delivered${reason} — ${retry} to retry them.`);
  }
  return parts.join(' ');
}

// Linked, but the credential could not be read right now — a busy OS credential store, a refresh in flight, a held lock.
// Signing in again fixes none of those, so this says wait and retry.
function authUnavailable(result) {
  return refused('Beezi: this machine is linked, but its saved login could not be read just now '
    + `(${result.authReason == null ? result.authState : result.authReason}). `
    + 'Nothing was removed — wait a moment and run /beezi-local-sync to finish the upload.');
}

// The credential can no longer be used (pinned to another API origin, or no refresh token left): only a new sign-in helps.
function needsReauth(result) {
  return result.authState === AUTH_STATES.REAUTH_REQUIRED || result.lastError === AUTH_STATES.REAUTH_REQUIRED;
}

function reauthStop(then) {
  return refused(`Beezi: the upload stopped because this account's saved sign-in can no longer be used. ${REAUTH_TEXT}, then ${then}.`);
}

function forbidden(result) {
  return refused(`Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). Check your seat with your workspace admin, then re-run /beezi-local-login.`);
}

// Stops before anything was uploaded: busy lease, account, auth or registration problems, and server halts, in that order.
function backfillStop(result, viaLogin) {
  // The lease is machine-wide, and sync never performs the one-time import.
  if (result.reason === 'busy') {
    return ok(viaLogin
      ? 'Beezi: another history upload is running on this machine. Re-run /beezi-local-login in a few minutes to finish the one-time import.'
      : 'Beezi: another history upload is running on this machine. Run this again after it finishes.');
  }
  if (result.reason === 'no-account') return refused(NOT_LINKED);
  if (result.reason === 'workspace-required') {
    return refused('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi-local-settings, then re-run /beezi-local-login.');
  }
  if (needsReauth(result)) return reauthStop('the upload continues where it left off');
  if (result.reason === 'auth-unavailable') return authUnavailable(result);
  if (result.reason === 'account-registration-failed') {
    return refused(`Beezi: Beezi did not confirm your GitHub account for this workspace (${orUnknown(result.lastError)}). Nothing was uploaded — re-run /beezi-local-login.`);
  }
  // The one-time import has been used — verified against the server before anything was parsed.
  // Inside the login flow this is a normal outcome; a direct/manual run is a rejected request.
  if (result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    const lines = ['Beezi already has the history for this workspace — the one-time import has been used and cannot run again.'];
    if (result.upgradeAdvised) {
      lines.push('Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.');
    }
    if (!viaLogin) return refused(lines.join(' '));
    return ok(`✓ ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) return refused('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return refused(UNSUPPORTED_SERVER);
  if (result.halt === BackfillHalt.FORBIDDEN) return forbidden(result);
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return refused('Beezi: another history upload took over partway through. What was sent is kept — re-run /beezi-local-login to finish the one-time import.');
  }
  return null;
}

function backfillNothingNew(result) {
  const bits = [];
  if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
  if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
  const lines = [`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`];
  if (result.finalized) lines.push(FINALIZED_LINE);
  else if (result.routeDeferred > 0) lines.push(DEFERRED_LINE);
  return ok(...lines);
}

function finalizationLine(result, sinceMs) {
  if (result.finalized) return FINALIZED_LINE;
  if (sinceMs != null) return '  Scoped run (--since): the pull stays open — a full run (no flags) finalizes it.';
  if (result.retriableUnreadable > 0) {
    return `  Your history is NOT finalized yet — ${plural(result.retriableUnreadable, 'session')} could not be read `
      + 'this time. Re-run /beezi-local-login to retry them; if they fail again the pull finalizes without them.';
  }
  if (result.routeDeferred > 0) return DEFERRED_LINE;
  return '  Your history is NOT finalized yet — re-run /beezi-local-login once the remaining sessions can be delivered.';
}

// The uploaded run's report: headline, every candidate that produced nothing (so the totals add up), seal state and timelines.
function backfillReport(result, sinceMs) {
  const middle = [];
  if (result.alreadyImported > 0) middle.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) middle.push(`${result.liveTracked} were already tracked live.`);
  const lines = [headline(result, middle, 're-run /beezi-local-login')].concat(countLines([
    [result.empty, 'held no usage data — nothing to upload.'],
    [result.noActivity, 'had no activity (no prompt was sent) — nothing to upload.'],
    ...notUploaded(result),
    [result.deferredOther, DEFERRED_OTHER],
    [result.active, 'changed in the last 30 minutes and were left for live capture — they are still open or just finished.'],
    // Totals are cumulative and a resume appends to the same file, so a resumed session's tokens arrive when it ends.
    [result.noUsageSummary, NO_USAGE_SUMMARY],
  ]), shortfallLines(result), [finalizationLine(result, sinceMs)], countLines([[result.timelines, 'attached.', 'session timeline']]));
  // One stanza, not two: `timelinesDropped` is a subset of the offered-minus-attached gap, so an if/else would hide the unexplained remainder.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    lines.push(`  ${plural(notAttached, 'session timeline')} could not be attached${result.timelinesDropped > 0 ? ' (the server did not accept them)' : ''} — the usage itself was uploaded.`);
  }
  if (!result.followupsAllowed) lines.push('  Error events are not collected in audit mode.');
  lines.push(PLAN_NOTE);
  return ok(...lines);
}

// /beezi-local-login's one-time import of one workspace.
export function backfillOutcome(result, { viaLogin, dryRun, sinceMs }) {
  const stop = backfillStop(result, viaLogin);
  if (stop != null) return stop;
  if (result.scanned === 0) return ok(NO_PAST_SESSIONS_LINE);
  if (result.candidates === 0) return backfillNothingNew(result);
  if (dryRun) {
    return ok(`Beezi: would upload ${plural(result.candidates, 'session')} / ${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} (dry run — nothing sent).`);
  }
  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // saying "log in again to continue" is accurate — the next login's backfill picks them up.
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return refused(`Beezi: upload stopped — could not reach the server (${orUnknown(result.lastError)}). Re-run /beezi-local-login to continue where it left off.`);
  }
  return backfillReport(result, sinceMs);
}

// A workspace joined after the link resumes from what it already has; `complete` when nothing was left behind.
export function joinedOutcome(result, { dryRun, complete }) {
  if (result.reason === 'no-account') return refused(NOT_LINKED);
  if (needsReauth(result)) return reauthStop('run /beezi-local-sync');
  if (result.reason === 'auth-unavailable') return authUnavailable(result);
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return refused(UNSUPPORTED_SERVER);
  if (result.halt === BackfillHalt.FORBIDDEN) return forbidden(result);
  if (dryRun) {
    return ok(`✓ Beezi (dry run): would send ${plural(result.plannedReports > 0 ? result.plannedReports : 0, 'report')} to this workspace you joined — nothing was sent.`);
  }
  const lines = [];
  const imported = result.sessionsImported > 0 ? result.sessionsImported : 0;
  if (imported > 0) {
    const stored = result.reportsStored > 0 ? result.reportsStored : 0;
    lines.push(`✓ Beezi: uploaded ${plural(imported, 'session')} (${plural(stored, 'report')} stored) to this workspace you joined.`);
  } else if (complete) {
    lines.push('✓ Beezi: this workspace already has this machine\'s history.');
  }
  if (!complete) lines.push('  Some history did not reach this workspace this time. Run /beezi-local-sync to send the rest and see why.');
  return ok(...lines);
}

// Sync stops before anything was uploaded; each says what to do next.
function syncStop(result) {
  if (result.reason === 'busy') return ok('Beezi: another history upload is running on this machine. Try again after it finishes.');
  if (needsReauth(result)) return reauthStop('run /beezi-local-sync again');
  if (result.reason === 'auth-unavailable') return refused('Beezi: authentication is temporarily unavailable. Try /beezi-local-sync again.');
  if (result.reason === 'no-account') return refused('Beezi: that account is not linked or its link expired. Run /beezi-local-login and sign in as it.');
  if (result.reason === 'workspace-required') {
    return refused('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi-local-settings, then run /beezi-local-sync again.');
  }
  if (result.reason === 'audit-only') {
    return refused('Beezi: this workspace is in audit mode — /beezi-local-sync only repairs workspaces with live tracking. Upgrade the workspace plan in the Beezi portal to keep tracking new sessions.');
  }
  if (result.reason === 'pending-not-drained') {
    return refused(`Beezi: reports saved earlier could not be delivered yet (${orUnknown(result.lastError)}), so sync did not compare against Beezi. Nothing was lost — run /beezi-local-sync again later.`);
  }
  if (result.reason === 'account-registration-failed') {
    return refused(`Beezi: Beezi did not confirm your GitHub account for this workspace (${orUnknown(result.lastError)}). Nothing was uploaded — run /beezi-local-login, then /beezi-local-sync.`);
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) return refused('Beezi: uploads are disabled for this workspace — the audit period has ended.');
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return refused('Beezi: this portal does not support /beezi-local-sync yet — try again after the next portal update.');
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return refused(`Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). Check your seat with your workspace admin, then try again.`);
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return refused('Beezi: another history upload took over partway through. What was sent is kept — run /beezi-local-sync again after it finishes.');
  }
  return null;
}

// The uploaded run's report; deferred history is split by cause, because each cause needs different follow-up.
function syncReport(result) {
  // `empty` leads: a session already fully uploaded replays from end-of-file and yields no report.
  const middle = [];
  if (result.empty > 0) middle.push(`${result.empty} were already up to date.`);
  if (result.noActivity > 0) middle.push(`${plural(result.noActivity, 'session')} had no activity — nothing to upload.`);
  return ok(headline(result, middle, 'run /beezi-local-sync again'), ...countLines([
    [result.pendingDrained, 'were delivered before the check.', 'saved report'],
    [result.deferredUnavailable, 'were left for the next run — Beezi could not confirm what it already has for them.'],
    [result.deferredGap, 'were left alone: what Beezi has recorded for them does not line up with '
      + 'what this machine sent, so re-uploading could double-count. They stay eligible — run /beezi-local-sync again later.'],
    [result.deferredOverlap, 'were left alone because the resume point could not be honoured. Nothing was sent for them.'],
    [result.deferredUsageMode, 'were left alone: Beezi already holds per-request token counts for part of them, '
      + 'and this run could only read end-of-session totals, which would double-count. They stay eligible.'],
    [result.deferredOther, DEFERRED_OTHER],
    ...notUploaded(result),
    // Totals are cumulative and a resume appends to the same file, so a resumed session's tokens arrive when it ends.
    [result.noUsageSummary, NO_USAGE_SUMMARY],
    [result.active, 'changed in the last 30 minutes — live capture has them; run /beezi-local-sync later if one stays incomplete.'],
  ]), ...shortfallLines(result), ...countLines([[result.timelines, 'attached.', 'session timeline']]), PLAN_NOTE);
}

// One /beezi-local-sync run of one account and workspace.
export function syncOutcome(result) {
  const stop = syncStop(result);
  if (stop != null) return stop;
  if (result.scanned === 0) return ok('✓ Beezi: no Copilot sessions found on this machine.');
  // Active sessions are skipped before they count as candidates; they are reported below, never "already uploaded".
  if (result.candidates === 0 && result.deferred === 0 && result.active === 0) {
    return ok('✓ Beezi: everything is already uploaded.');
  }
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return refused(`Beezi: upload stopped — could not reach the server (${orUnknown(result.lastError)}). Run /beezi-local-sync again to continue where it left off.`);
  }
  return syncReport(result);
}
