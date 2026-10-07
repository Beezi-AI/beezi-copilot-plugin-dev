import { readHookInput, normalizeHookInput, hasSessionFile, isVscodeHookPayload } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// ErrorOccurred: hands a failed model call to the checkpoint, which owns delivery, targets and retries of
// undelivered errors. Never posts directly and never writes pendingErrors. Prints nothing.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null || !hasSessionFile(input)) process.exit(0);
// A VS Code Local-agent session is never read as a Copilot CLI transcript, and its errors are not captured.
if (isVscodeHookPayload(input)) process.exit(0);
runHook(DIAGNOSTIC_SOURCES.ERROR_OCCURRED, async () => {
  const events = await importHookModule('./error-events.mjs');
  const failure = events == null ? null : events.errorFromHookPayload(input);
  if (failure == null) return;
  const mod = await importHookModule('./checkpoint.mjs');
  if (mod == null) return;
  await mod.runCheckpoint({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    trigger: 'error',
    budgetMs: 5000,
    withTimeline: true,
    withQuota: false,
    hookErrors: [failure],
  });
});
