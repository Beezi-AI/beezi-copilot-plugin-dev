// Starts the history worker for accounts that owe a workspace the past sessions it consented to upload.
import { AccountStatus, listAccounts } from '../accounts/index-store.mjs';
import { scriptPath } from '../config/plugin-root.mjs';
import { spawnDetached } from '../platform/spawn.mjs';
import { historyDue, pendingHistoryOf } from '../workspace/pending-history.mjs';

export const HISTORY_WORKER_SCRIPT = scriptPath('history-worker.mjs');

async function linkedRows(deps) {
  const list = deps.listAccounts == null ? listAccounts : deps.listAccounts;
  return (await list()).filter((a) => a.status === AccountStatus.LINKED);
}

// After a yes to the offer: starts the worker when the account owes any workspace its history. Never throws.
export async function startHistoryWorker(key, deps = {}) {
  try {
    const row = (await linkedRows(deps)).find((a) => a.key === key);
    if (row == null || pendingHistoryOf(row).length === 0) return false;
    return spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', key]) === true;
  } catch {
    return false;
  }
}

// The retry path (SessionStart, the watcher): one worker per account whose pending history is due. Never throws.
export async function maybeStartPendingHistory(deps = {}) {
  const nowMs = deps.now == null ? Date.now() : deps.now();
  let started = 0;
  try {
    for (const row of await linkedRows(deps)) {
      if (historyDue(row, nowMs) && spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', row.key]) === true) started += 1;
    }
  } catch { /* best-effort: the next session start retries */ }
  return started;
}
