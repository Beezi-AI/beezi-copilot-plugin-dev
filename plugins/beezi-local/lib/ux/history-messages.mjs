// What a history dry run's result means in words (backfill.mjs --dry-run), as outcome lines.
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

const DEFERRED_LINE = '  Some repos and folders still wait for a rule — run /beezi-local-sync to choose.';
export const NO_PAST_SESSIONS_LINE = '✓ Beezi: no past Copilot sessions found to upload.';
const NOT_LINKED = 'Beezi: this machine is not linked. Run /beezi-local-login first.';
const UNSUPPORTED_SERVER = 'Beezi: the server does not support the history pull yet — try again after the portal update.';
const SYNC_LINE = 'Run /beezi-local-sync to see and upload your past sessions.';
const ANON_KEY_MISSING = 'Beezi: this workspace anonymizes its sessions, but this machine has not received its anonymization key. Nothing was uploaded — run /beezi-local-login, then try again.';

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

// Linked, but the credential could not be read right now — a busy OS credential store, a refresh in flight, a held lock.
// Signing in again fixes none of those, so this says wait and retry.
function authUnavailable(result) {
  return refused('Beezi: this machine is linked, but its saved login could not be read just now '
    + `(${result.authReason == null ? result.authState : result.authReason}). `
    + `Nothing was removed — wait a moment. ${SYNC_LINE}`);
}

// The credential can no longer be used (pinned to another API origin, or no refresh token left): only a new sign-in helps.
function needsReauth(result) {
  return result.authState === AUTH_STATES.REAUTH_REQUIRED || result.lastError === AUTH_STATES.REAUTH_REQUIRED;
}

function reauthStop() {
  return refused(`Beezi: the dry run stopped because this account's saved sign-in can no longer be used. ${REAUTH_TEXT}, then run /beezi-local-sync.`);
}

function forbidden(result) {
  return refused(`Beezi: the server refused the history pull (${result.lastError == null ? 'forbidden' : result.lastError}). Check your seat with your workspace admin. ${SYNC_LINE}`);
}

// Stops before anything was uploaded: busy lease, account, auth or registration problems, and server halts, in that order.
function backfillStop(result) {
  if (result.reason === 'busy') return ok('Beezi: another history upload is running on this machine. Try again in a few minutes.');
  if (result.reason === 'no-account') return refused(NOT_LINKED);
  if (result.reason === 'workspace-required') {
    return refused(`Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi-local-settings. ${SYNC_LINE}`);
  }
  if (needsReauth(result)) return reauthStop();
  if (result.reason === 'auth-unavailable') return authUnavailable(result);
  if (result.reason === 'anonymization-key-missing') return refused(ANON_KEY_MISSING);
  if (result.reason === 'account-registration-failed') {
    return refused(`Beezi: Beezi did not confirm your GitHub account for this workspace (${orUnknown(result.lastError)}). ${SYNC_LINE}`);
  }
  // Checked against the server before anything was parsed.
  if (result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    const lines = ['Beezi already has the history for this workspace.'];
    if (result.upgradeAdvised) {
      lines.push('Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.');
    }
    return refused(lines.join(' '));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) return refused('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return refused(UNSUPPORTED_SERVER);
  if (result.halt === BackfillHalt.FORBIDDEN) return forbidden(result);
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return refused('Beezi: another history upload took over partway through. Nothing was uploaded by this dry run.');
  }
  return null;
}

function backfillNothingNew(result) {
  const bits = [];
  if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
  if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
  const lines = [`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`];
  if (result.routeDeferred > 0) lines.push(DEFERRED_LINE);
  return ok(...lines);
}

// One workspace's history dry run.
export function backfillOutcome(result) {
  const stop = backfillStop(result);
  if (stop != null) return stop;
  if (result.scanned === 0) return ok(NO_PAST_SESSIONS_LINE);
  if (result.candidates === 0) return backfillNothingNew(result);
  return ok(`Beezi: would upload ${plural(result.candidates, 'session')} / ${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} (dry run — nothing sent).`);
}

// A dry run for a workspace joined after the link, which resumes from what it already has.
export function joinedOutcome(result) {
  if (result.reason === 'no-account') return refused(NOT_LINKED);
  if (needsReauth(result)) return reauthStop();
  if (result.reason === 'auth-unavailable') return authUnavailable(result);
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return refused(UNSUPPORTED_SERVER);
  if (result.halt === BackfillHalt.FORBIDDEN) return forbidden(result);
  return ok(`✓ Beezi (dry run): would send ${plural(result.plannedReports > 0 ? result.plannedReports : 0, 'report')} to this workspace you joined — nothing was sent.`);
}
