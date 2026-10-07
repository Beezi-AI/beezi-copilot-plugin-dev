import path from 'path';
import { fileURLToPath } from 'url';
import { readHookInput, normalizeHookInput, recordHookSeen, hasSessionFile, isVscodeHookPayload, vscodeSessionFileFor } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { spawnDetached } from '../lib/background-spawn.mjs';
import { isUsableSessionId } from '../lib/session-state.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// SessionEnd: a detached shutdown-worker that bills the late shutdown, then the final checkpoint. Prints nothing.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null || !hasSessionFile(input)) process.exit(0);
recordHookSeen('SessionEnd');
const vscode = isVscodeHookPayload(input);
const vscodeFile = vscode ? vscodeSessionFileFor(input) : null;
runHook(DIAGNOSTIC_SOURCES.REPORT, async () => {
  // A VS Code Local-agent session writes no late session.shutdown, so no shutdown-worker: one final VS Code checkpoint.
  if (vscode) {
    const vsc = await importHookModule('./vscode-checkpoint.mjs');
    if (vsc != null) await vsc.runVscodeCheckpoint({ sessionId: input.session_id, file: vscodeFile, transcriptPath: input.transcript_path, cwd: input.cwd, trigger: 'session-end', budgetMs: 10000, settleWaitMs: 3000 });
    return;
  }
  // Spawned first so a hook killed at its timeout still leaves the worker; the session lock serializes the two.
  if (isUsableSessionId(input.session_id)) {
    spawnDetached(path.join(path.dirname(fileURLToPath(import.meta.url)), 'shutdown-worker.mjs'), {}, [input.session_id]);
  }
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod == null) return;
  await mod.runCheckpoint({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    trigger: 'session-end',
    budgetMs: 10000,
    withTimeline: true,
    withQuota: true,
  });
});
