// SessionEnd: the pending-shutdown flag, the shutdown worker when one is needed, then the session's final checkpoint.
import { spawnDetached } from '../platform/spawn.mjs';
import { scriptPath } from '../config/plugin-root.mjs';
import { saveSessionState } from '../state/session-state.mjs';
import { sessionSurface } from '../sources/cli/client-surface.mjs';
import { shutdownWorkerLive } from './shutdown-guard.mjs';

const AGENT_HOST = 'vscode-agent-host';

// Agent Host writes its shutdown only when VS Code disposes the session, hours later, so the watcher and the catch-up bill it;
// a live worker already waits and restarts its wait on this SessionEnd.
export function needsShutdownWorker(surface, workerLive) {
  return surface !== AGENT_HOST && !workerLive;
}

async function endVscode(input, run) {
  const runVscode = run.runVscodeCheckpoint == null ? (await import('./vscode-checkpoint.mjs')).runVscodeCheckpoint : run.runVscodeCheckpoint;
  // A VS Code Local-agent session writes no late session.shutdown, so no worker: one final checkpoint.
  await runVscode({
    sessionId: input.session_id, file: run.vscodeFile == null ? null : run.vscodeFile, transcriptPath: input.transcript_path, cwd: input.cwd,
    trigger: 'session-end', budgetMs: run.budgetMs, settleWaitMs: run.settleWaitMs,
  });
}

// input: the normalized hook input. run: { vscode, vscodeFile, budgetMs, settleWaitMs (VS Code only) } from the hook script,
// plus the seams spawn, runCheckpoint and runVscodeCheckpoint.
export async function runSessionEnd(input, run) {
  if (run.vscode === true) return endVscode(input, run);
  const sessionId = input.session_id;
  // Recorded first: a worker that dies with the host still leaves the late shutdown to the catch-up and the watcher.
  saveSessionState(sessionId, { pendingShutdown: true });
  // Spawned before the engine loads, so a hook killed at its timeout still leaves the worker; the session lock serializes the two.
  if (needsShutdownWorker(sessionSurface(sessionId, input.transcript_path, []).source, shutdownWorkerLive(sessionId))) {
    (run.spawn == null ? spawnDetached : run.spawn)(scriptPath('shutdown-worker.mjs'), {}, [sessionId]);
  }
  const runCheckpoint = run.runCheckpoint == null ? (await import('./cli-checkpoint.mjs')).runCheckpoint : run.runCheckpoint;
  await runCheckpoint({
    sessionId, transcriptPath: input.transcript_path, cwd: input.cwd, trigger: 'session-end', budgetMs: run.budgetMs, withTimeline: true, withQuota: true,
  });
}
