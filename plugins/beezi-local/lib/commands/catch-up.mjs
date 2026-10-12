// catch-up-worker.mjs: checkpoints the sessions left behind their file or owing a shutdown, one machine-wide run at a time.
import { catchUpSessions as _catchUpSessions } from '../pipeline/housekeeping.mjs';
import { runCheckpoint as _runCheckpoint } from '../pipeline/cli-checkpoint.mjs';
import { acquireLock as _acquireLock, releaseLock as _releaseLock } from '../platform/single-instance-lock.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';

export const CATCH_UP_LOCK = 'catch-up';

// argv[0] is the starting session's id, skipped because its own hooks handle it. → true when this run held the lock.
export async function runCatchUp(argv, deps = {}) {
  const acquireLock = deps.acquireLock == null ? _acquireLock : deps.acquireLock;
  const releaseLock = deps.releaseLock == null ? _releaseLock : deps.releaseLock;
  const catchUpSessions = deps.catchUpSessions == null ? _catchUpSessions : deps.catchUpSessions;
  const runCheckpoint = deps.runCheckpoint == null ? _runCheckpoint : deps.runCheckpoint;
  if (!acquireLock(CATCH_UP_LOCK)) return false;
  try {
    const own = argv[0];
    await catchUpSessions({ runCheckpoint, excludeSessionId: isUsableSessionId(own) ? own : null });
  } finally {
    releaseLock(CATCH_UP_LOCK);
  }
  return true;
}
