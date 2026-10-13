// When a history run may seal the one-time pull.
import { SYNC_MODE } from '../contract/history.mjs';

// Seal only when a re-run could not improve the outcome; per-item errors and unreadable-twice or oversize files never block it, or the seal would deadlock.
export function shouldFinalize(result, options = {}) {
  if (!result.ok) return false;
  // /beezi-staging-sync is repeatable by definition; sealing the one-time pull from it would lock the user out of the command they just ran.
  if (options.mode === SYNC_MODE) return false;
  if (options.dryRun === true) return false;
  if (options.sinceMs != null) return false;
  if (result.halt !== null) return false;
  if (result.reportsFailed > 0) return false;
  if (result.unattributed > 0) return false;
  if (result.permanentRejections > 0) return false;
  // Only the FIRST unreadable failure holds the seal: a permission error reads like transient I/O, so gating on every one would block it forever.
  if (result.retriableUnreadable > 0) return false;
  // Repos still waiting for a rule may yet be routed here, so the one-time pull stays open for them.
  if (result.routeDeferred > 0) return false;
  // A session left for a later run has not been uploaded, and the seal is one-time.
  if (result.deferred > 0) return false;
  return true;
}
