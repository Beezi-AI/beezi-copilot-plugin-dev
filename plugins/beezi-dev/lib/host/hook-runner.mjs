import { recordIssue as _recordIssue, setCurrentSource } from '../telemetry/recorder.mjs';
import { exitClean as _exitClean } from '../platform/exit.mjs';
import { DIAGNOSTIC_CODES } from '../contract/diagnostic-codes.mjs';
import { maybeSpawnDiagnostics as _maybeSpawnDiagnostics } from '../telemetry/trigger.mjs';

// Loads a hook's implementation module AFTER the recorder is live, so a module that throws on
// import — a syntax error, a missing dependency, a half-written file after an upgrade — is
// recorded from a runtime that still works. A static import at the top of the hook script would
// take the whole process down before anything could observe it.
//
// The caller resolves `url` against its own module URL, so the path follows the caller through a folder move.
export async function importHookModule(url, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  try {
    return await (deps.importImpl == null ? import(url) : deps.importImpl(url));
  } catch (error) {
    try {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_IMPORT_FAILED, error });
    } catch { /* never */ }
    return null;
  }
}

// Wraps a hook body. Today every script ends `.catch(() => {}).finally(() => exitClean(0))`,
// which is exactly where a crash disappears. Same exit behaviour, one extra step: the failure
// is recorded first. Never rethrows — a hook that fails must still exit 0.
export async function runHook(source, fn, deps = {}) {
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const exitClean = deps.exitClean == null ? _exitClean : deps.exitClean;
  const onResult = deps.onResult == null ? () => {} : deps.onResult;
  const maybeSpawnDiagnostics = deps.maybeSpawnDiagnostics == null
    ? _maybeSpawnDiagnostics : deps.maybeSpawnDiagnostics;

  const onRejection = (reason) => {
    try {
      recordIssue({
        code: DIAGNOSTIC_CODES.HOOK_UNHANDLED_REJECTION,
        source,
        error: reason instanceof Error ? reason : new Error('unhandled'),
      });
    } catch { /* never */ }
  };
  process.on('unhandledRejection', onRejection);
  // Published for call sites (fs-store, token) that don't know their own source — they fall
  // back to whatever hook is currently in flight instead of guessing.
  setCurrentSource(source);

  // Startup: whatever an earlier hook left undelivered goes out now, with no token involved.
  try { maybeSpawnDiagnostics(); } catch { /* never */ }

  try {
    onResult(await fn());
  } catch (error) {
    try {
      recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source, error });
    } catch { /* never */ }
  } finally {
    // Completion: the crash this hook just recorded is deliverable immediately, unless the
    // startup attempt already claimed the window.
    try { maybeSpawnDiagnostics(); } catch { /* never */ }
    // Not cleared here: a write failure's report is fired-and-forgotten via a lazy import that
    // can resolve after this hook has already finished, and it still needs to see this hook's
    // source. Each hook is its own short-lived process, so nothing after this ever reads it.
    process.removeListener('unhandledRejection', onRejection);
    await exitClean(0);
  }
}
