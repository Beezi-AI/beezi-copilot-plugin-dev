import { parseArgs, runAudit, planHistoryRuns } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { parseAccountFlag, getAccount, describeAccount } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { usesRules } from '../lib/workspace-rules.mjs';
import { readTrackingState, matchesIdentity } from '../lib/tracking.mjs';

// The last step of /beezi-local-login (re-running it resumes an interrupted upload); --dry-run, --since and --force are for manual runs only.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Prints the error and reports a failed run, so the remaining workspaces still run.
function failed(message) {
  console.error(`✗ ${message}`);
  return 1;
}

const DEFERRED_LINE = '  Your one-time history upload stays open until those repos and folders have a rule — run /beezi-local-login or /beezi-local-sync to choose.';

// One workspace's run; returns the exit status instead of exiting mid-loop.
async function backfillOne(account, tenantId, argv, sessionRoutes, excludedSessionIds = null, excludedLabel = null) {
  const options = parseArgs(argv);
  options.account = account;
  options.tenantId = tenantId;
  options.sessionRoutes = sessionRoutes;
  options.excludedSessionIds = excludedSessionIds;
  const viaLogin = options.via === 'login';

  const result = await runAudit(
    {
      // "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still produce nothing to upload.
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  // The real count, after the live-session skip the audit already applies, not the pre-run plan.
  if (excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }

  // The lease is machine-wide, and sync never performs the one-time import.
  if (result.reason === 'busy') {
    console.log(viaLogin
      ? 'Beezi: another history upload is running on this machine. Re-run /beezi-local-login in a few minutes to finish the one-time import.'
      : 'Beezi: another history upload is running on this machine. Run this again after it finishes.');
    return 0;
  }
  if (result.reason === 'no-account') {
    return failed('Beezi: this machine is not linked. Run /beezi-local-login first.');
  }
  if (result.reason === 'workspace-required') {
    return failed('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi-local-settings, then re-run /beezi-local-login.');
  }
  // Linked, but the credential could not be read right now — a busy OS credential store, a refresh in flight,
  // a held lock. Signing in again fixes none of those, so this says wait and retry.
  if (result.reason === 'auth-unavailable') {
    return failed(
      'Beezi: this machine is linked, but its saved login could not be read just now '
        + `(${result.authReason == null ? result.authState : result.authReason}). `
        + 'Nothing was removed — wait a moment and run /beezi-local-sync to finish the upload.',
    );
  }
  if (result.reason === 'account-registration-failed') {
    return failed(
      `Beezi: Beezi did not confirm your GitHub account for this workspace (${result.lastError == null ? 'unknown error' : result.lastError}). `
        + 'Nothing was uploaded — re-run /beezi-local-login.',
    );
  }

  // The one-time import has been used — verified against the server before anything was parsed.
  // Inside the login flow this is a normal outcome; a direct/manual run is a rejected request.
  const alreadyUsed =
    result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED;
  if (alreadyUsed) {
    const lines = [
      'Beezi already has the history for this workspace — the one-time import has been used and cannot run again.',
    ];
    if (result.upgradeAdvised) {
      lines.push(
        'Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.',
      );
    }
    if (viaLogin) {
      console.log(`✓ ${lines[0]}`);
      if (lines[1]) console.log(`  ${lines[1]}`);
      return 0;
    }
    return failed(lines.join(' '));
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return failed('Beezi: the audit period has ended — new history pulls are disabled for this workspace.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return failed('Beezi: the server does not support the history pull yet — try again after the portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then re-run /beezi-local-login.',
    );
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return failed('Beezi: another history upload took over partway through. What was sent is kept — re-run /beezi-local-login to finish the one-time import.');
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Copilot sessions found to upload.');
    return 0;
  }
  if (result.candidates === 0) {
    const bits = [];
    if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
    if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
    console.log(`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    if (result.finalized) console.log('✓ Beezi: your history pull is finalized.');
    else if (result.routeDeferred > 0) console.log(DEFERRED_LINE);
    return 0;
  }

  if (options.dryRun) {
    console.log(
      `Beezi: would upload ${plural(result.candidates, 'session')} / ` +
        `${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    return 0;
  }

  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // saying "log in again to continue" is accurate — the next login's backfill picks them up.
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return failed(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Re-run /beezi-local-login to continue where it left off.',
    );
  }

  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) parts.push(`${result.liveTracked} were already tracked live.`);
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  // Sessions the server refused outright. Ledgered, so a re-run will not retry them — saying so
  // is the only chance the user has to notice.
  if (result.sessionsRejected > 0) {
    parts.push(
      `${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`,
    );
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — re-run /beezi-local-login to retry them.`,
    );
  }
  console.log(parts.join(' '));

  // Every candidate that produced nothing to upload, so the totals add up.
  if (result.empty > 0) {
    console.log(`  ${plural(result.empty, 'session')} held no usage data — nothing to upload.`);
  }
  if (result.noActivity > 0) {
    console.log(`  ${plural(result.noActivity, 'session')} had no activity (no prompt was sent) — nothing to upload.`);
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their session files record no working directory.',
    );
  }
  if (result.emitFailed > 0) {
    console.log(`  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`);
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  if (result.oversize > 0) {
    console.log(`  ${plural(result.oversize, 'session')} were too large to read (over 64 MB) — not uploaded.`);
  }
  if (result.deferredOther > 0) {
    console.log(`  ${plural(result.deferredOther, 'session')} were still being written to and were left for the next run.`);
  }
  if (result.active > 0) {
    console.log(
      `  ${plural(result.active, 'session')} changed in the last 30 minutes and were left for live capture — they are still open or just finished.`,
    );
  }
  // V-08 (cumulative totals, a resume appends to the same file): a resumed session's tokens arrive when it ends.
  if (result.noUsageSummary > 0) {
    console.log(
      `  ${plural(result.noUsageSummary, 'session')} ended without Copilot's usage summary (closed abruptly or still open elsewhere) — ` +
        "their activity was uploaded without token counts. If you resume one in Copilot, its tokens are added when it ends.",
    );
  }
  // The server's stored count against what we handed it. A silent shortfall here means reports were acknowledged but not persisted.
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored ` +
        `and ${result.reportsSkipped} skipped by the server.`,
    );
  }

  if (result.finalized) {
    console.log('✓ Beezi: your history pull is finalized.');
  } else if (options.sinceMs != null) {
    console.log('  Scoped run (--since): the pull stays open — a full run (no flags) finalizes it.');
  } else if (result.retriableUnreadable > 0) {
    console.log(
      `  Your history is NOT finalized yet — ${plural(result.retriableUnreadable, 'session')} could not be read ` +
        'this time. Re-run /beezi-local-login to retry them; if they fail again the pull finalizes without them.',
    );
  } else if (result.routeDeferred > 0) {
    console.log(DEFERRED_LINE);
  } else {
    console.log(
      '  Your history is NOT finalized yet — re-run /beezi-local-login once the remaining sessions can be delivered.',
    );
  }
  if (result.timelines > 0) {
    console.log('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  // One stanza, not two: `timelinesDropped` is a subset of the offered-minus-attached gap, so an if/else would hide the unexplained remainder.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    console.log(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (!result.followupsAllowed) {
    console.log('  Error events are not collected in audit mode.');
  }
  console.log(
    '  Plan and billing details reflect your current setup, not the plan you were on at the time.',
  );
  return 0;
}

function tenantLabel(row, tenantId) {
  const t = tenantById(row, tenantId);
  return t != null && t.name ? t.name : tenantId;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => tenantLabel(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  if (account == null) fail('Beezi: backfill needs --account <key|email|n>. /beezi-local-login passes it automatically.');
  const row = (await getAccount(account)) || { key: account };
  const { argv, tenantIds: override } = parseTenantFlags(rest, row);
  // One or unknown workspaces: one headerless run.
  if (!isMultiTenant(row)) {
    // Already sealed (and not forced): the same test runAudit uses, identity included, so a mismatch still plans the exclusions.
    const tracking = readTrackingState(row.key);
    const sealed = tracking != null && tracking.backfillCompleted === true && matchesIdentity(tracking, row.clientId == null ? null : row.clientId) && !parseArgs(argv).force;
    if (usesRules(row) && !sealed) {
      const { excludedSessionIds } = planHistoryRuns(row).runs[0];
      if (await backfillOne(account, null, argv, null, excludedSessionIds, describeAccount(row)) !== 0) process.exit(1);
    } else if (await backfillOne(account, null, argv, null) !== 0) process.exit(1);
    return;
  }
  // --tenant is an override: those workspaces get every past session, unrouted.
  let runs = override.map((tenantId) => ({ tenantId, sessionRoutes: null }));
  if (runs.length === 0) {
    const plan = planHistoryRuns(row, { markWaiting: true });
    if (plan.scanned === 0) {
      console.log('✓ Beezi: no past Copilot sessions found to upload.');
      return;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(summary);
    runs = plan.runs;
  }
  let status = 0;
  for (const run of runs) {
    console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, run.tenantId)} —`);
    // One workspace's exception must not stop the rest.
    try {
      if (await backfillOne(account, run.tenantId, argv, run.sessionRoutes) !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  if (status !== 0) process.exit(status);
}

main().catch((error) => fail(friendlyMessage(error)));
