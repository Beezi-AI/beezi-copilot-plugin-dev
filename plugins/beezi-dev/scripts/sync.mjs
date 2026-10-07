import { runAudit, planHistoryRuns, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { parseAccountFlag, listAccounts, getAccount, describeAccount, AccountStatus } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant, tenantById, newFoldersOf } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// /beezi-dev-sync: repeatable upload of what Beezi is missing; --account/--tenant only scope it, --since would hide half-uploaded old sessions and --force has no seal to force past.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Refused before anything is read, the accounts index included. --account and --tenant each take a value.
function refuseFlags(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account' || arg === '--tenant') { i += 1; continue; }
    if (arg === '--since') {
      fail('Beezi: /beezi-dev-sync takes no --since. It uploads exactly what Beezi is missing, wherever in your history those sessions ran. Run it with no flags.');
    }
    if (arg === '--force') {
      fail('Beezi: /beezi-dev-sync takes no --force. There is no one-time seal to force past — sync resumes each session from where Beezi already has it. Run it with no flags.');
    }
    if (arg.startsWith('--')) fail(`Beezi: /beezi-dev-sync takes no flags (got ${arg}). Run it with no flags.`);
  }
}

// A refusal prints, marks the exit code and returns, so the accounts after it still run.
function refuse(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

const orUnknown = (value) => (value == null ? 'unknown error' : value);

// One account/workspace run.
async function syncOne(account, tenantId, sessionRoutes, excludedSessionIds = null, excludedLabel = null) {
  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    { account, tenantId, sessionRoutes, excludedSessionIds, mode: SYNC_MODE },
  );

  // The real count, after the live-session skip the audit already applies, not the pre-run plan.
  if (excludedLabel != null && result.excluded > 0) {
    console.log(`Beezi (${excludedLabel}): ${plural(result.excluded, 'past session')} in repos or folders you don't track ${result.excluded === 1 ? 'is' : 'are'} skipped.`);
  }

  if (result.reason === 'busy') {
    console.log('Beezi: another history upload is running on this machine. Try again after it finishes.');
    return;
  }
  if (result.reason === 'auth-unavailable') {
    return refuse('Beezi: authentication is temporarily unavailable. Try /beezi-dev-sync again.');
  }
  if (result.reason === 'no-account') {
    return refuse('Beezi: that account is not linked or its link expired. Run /beezi-dev-login and sign in as it.');
  }
  if (result.reason === 'workspace-required') {
    return refuse('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi-dev-settings, then run /beezi-dev-sync again.');
  }
  if (result.reason === 'audit-only') {
    return refuse('Beezi: this workspace is in audit mode — /beezi-dev-sync only repairs workspaces with live tracking. Upgrade the workspace plan in the Beezi portal to keep tracking new sessions.');
  }
  if (result.reason === 'pending-not-drained') {
    return refuse(
      `Beezi: reports saved earlier could not be delivered yet (${orUnknown(result.lastError)}), so sync did not compare against Beezi. `
        + 'Nothing was lost — run /beezi-dev-sync again later.',
    );
  }
  if (result.reason === 'account-registration-failed') {
    return refuse(
      `Beezi: Beezi did not confirm your GitHub account for this workspace (${orUnknown(result.lastError)}). `
        + 'Nothing was uploaded — run /beezi-dev-login, then /beezi-dev-sync.',
    );
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return refuse('Beezi: uploads are disabled for this workspace — the audit period has ended.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return refuse('Beezi: this portal does not support /beezi-dev-sync yet — try again after the next portal update.');
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return refuse(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). `
        + 'Check your seat with your workspace admin, then try again.',
    );
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return refuse('Beezi: another history upload took over partway through. What was sent is kept — run /beezi-dev-sync again after it finishes.');
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no Copilot sessions found on this machine.');
    return;
  }
  // Active and oversize sessions are skipped before they count as candidates; they are reported below, never "already uploaded".
  if (result.candidates === 0 && result.deferred === 0 && result.active === 0 && result.oversize === 0) {
    console.log('✓ Beezi: everything is already uploaded.');
    return;
  }
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return refuse(
      `Beezi: upload stopped — could not reach the server (${orUnknown(result.lastError)}). `
        + 'Run /beezi-dev-sync again to continue where it left off.',
    );
  }

  // `empty` leads: a session already fully uploaded replays from end-of-file and yields no report.
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.empty > 0) parts.push(`${result.empty} were already up to date.`);
  if (result.noActivity > 0) parts.push(`${plural(result.noActivity, 'session')} had no activity — nothing to upload.`);
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.sessionsRejected > 0) {
    parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(`${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run /beezi-dev-sync again to retry them.`);
  }
  console.log(parts.join(' '));

  if (result.pendingDrained > 0) {
    console.log(`  ${plural(result.pendingDrained, 'saved report')} were delivered before the check.`);
  }
  // Deferred history, split by cause, because each cause needs different follow-up.
  if (result.deferredUnavailable > 0) {
    console.log(`  ${plural(result.deferredUnavailable, 'session')} were left for the next run — Beezi could not confirm what it already has for them.`);
  }
  if (result.deferredGap > 0) {
    console.log(
      `  ${plural(result.deferredGap, 'session')} were left alone: what Beezi has recorded for them does not line up with `
        + 'what this machine sent, so re-uploading could double-count. They stay eligible — run /beezi-dev-sync again later.',
    );
  }
  if (result.deferredOverlap > 0) {
    console.log(
      `  ${plural(result.deferredOverlap, 'session')} were left alone because the resume point could not be honoured. Nothing was sent for them.`,
    );
  }
  if (result.deferredUsageMode > 0) {
    console.log(
      `  ${plural(result.deferredUsageMode, 'session')} were left alone: Beezi already holds per-request token counts for part of them, `
        + 'and this run could only read end-of-session totals, which would double-count. They stay eligible.',
    );
  }
  if (result.deferredOther > 0) {
    console.log(`  ${plural(result.deferredOther, 'session')} were still being written to and were left for the next run.`);
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. `
        + 'Their session files record no working directory.',
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
  // V-08 (cumulative totals, a resume appends to the same file): a resumed session's tokens arrive when it ends.
  if (result.noUsageSummary > 0) {
    console.log(
      `  ${plural(result.noUsageSummary, 'session')} ended without Copilot's usage summary (closed abruptly or still open elsewhere) — `
        + 'their activity was uploaded without token counts. If you resume one in Copilot, its tokens are added when it ends.',
    );
  }
  if (result.active > 0) {
    console.log(
      `  ${plural(result.active, 'session')} changed in the last 30 minutes — live capture has them; run /beezi-dev-sync later if one stays incomplete.`,
    );
  }
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored `
        + `and ${result.reportsSkipped} skipped by the server.`,
    );
  }
  if (result.timelines > 0) {
    console.log('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
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
  const argv = process.argv.slice(2);
  refuseFlags(argv);
  const { account, rest } = await parseAccountFlag(argv);
  const rows = account != null
    ? [(await getAccount(account)) || { key: account }]
    : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (rows.length === 0) fail('Beezi: this machine is not linked. Run /beezi-dev-login first.');
  if (rows.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <key> when several accounts are linked.');
  }

  // One run per account × routed workspace.
  for (const row of rows) {
    const override = parseTenantFlags(rest, row).tenantIds;
    if (!isMultiTenant(row)) {
      if (rows.length > 1) console.log(`\n— ${describeAccount(row)} —`);
      const { excludedSessionIds } = planHistoryRuns(row).runs[0];
      await syncOne(row.key, null, null, excludedSessionIds, excludedSessionIds == null ? null : describeAccount(row));
      continue;
    }
    // --tenant is an override: those workspaces get every past session, unrouted.
    if (override.length > 0) {
      for (const tenantId of override) {
        console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, tenantId)} —`);
        await syncOne(row.key, tenantId, null);
      }
      continue;
    }
    const plan = planHistoryRuns(row);
    if (plan.scanned === 0) {
      console.log(`\n✓ Beezi (${describeAccount(row)}): no Copilot sessions found on this machine.`);
      continue;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(`\n${summary}`);
    for (const run of plan.runs) {
      console.log(`\n— ${describeAccount(row)} · ${tenantLabel(row, run.tenantId)} —`);
      await syncOne(row.key, run.tenantId, run.sessionRoutes);
    }
  }
}

main().catch((error) => fail(friendlyMessage(error)));
