import fs from 'fs';
import path from 'path';
import { stateDir } from '../config/paths.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { touchPrivate } from '../platform/fs-store.mjs';

// A long agent turn fires no Stop and often no git command for an hour, so nothing checkpoints:
// token segments, the timeline, usage snapshots and statusline rows all wait for the turn to
// end. The pulse rides PostToolUse for EVERY tool and bounds that wait: almost every firing is
// a single stat() and exit; only when the last pulse is older than the interval does it pay for
// a full turn-end-grade checkpoint.
export const PULSE_INTERVAL_MS = 15 * 60 * 1000;
export const PULSE_BUDGET_MS = 8000;

const markerFile = (sessionId, name) => path.join(stateDir(), `${sessionId}.${name}`);
const nowOf = (deps) => (deps.now == null ? Date.now : deps.now);

// True when the marker is missing or at least intervalMs old, by one stat().
function markerExpired(marker, intervalMs, now) {
  try {
    return now() - fs.statSync(marker).mtimeMs >= intervalMs;
  } catch {
    return true;
  }
}

// Claim the interval by touching the marker BEFORE the work runs: parallel tool
// completions racing here at most double-run (segments upsert by segmentId, snapshots dedupe
// server-side), and work that dies waits out the interval instead of retrying per tool.
// An intervalMs of 0 always claims (re-arms the marker).
export function claimInterval(sessionId, name, intervalMs, deps = {}) {
  if (!isUsableSessionId(sessionId)) return false;
  const now = nowOf(deps);
  const marker = markerFile(sessionId, name);
  if (!markerExpired(marker, intervalMs, now)) return false;
  // An unclaimable marker (unwritable disk) skips the work rather than running it on every tool call.
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    touchPrivate(marker, new Date(now()));
  } catch {
    return false;
  }
  return true;
}

const pulseIntervalOf = (deps) => (deps.intervalMs == null ? PULSE_INTERVAL_MS : deps.intervalMs);

export function claimPulse(sessionId, deps = {}) {
  return claimInterval(sessionId, 'pulse', pulseIntervalOf(deps), deps);
}

// The hook script's gate before it loads the runner: whether claimPulse could claim now. Touches nothing.
export function pulseDue(sessionId, deps = {}) {
  return isUsableSessionId(sessionId) && markerExpired(markerFile(sessionId, 'pulse'), pulseIntervalOf(deps), nowOf(deps));
}

// Returns { ran } — ran is true when this firing performed the checkpoint. `force` (PreCompact) skips the
// interval test and re-arms the marker; the pulse substitutes for a Stop that is not coming, so a regular
// one ships the timeline, subagents and quota snapshot a turn end would.
export async function maybeRunPulse(input, { force = false, budgetMs = PULSE_BUDGET_MS, ...deps } = {}) {
  if (input == null || !input.session_id || !input.transcript_path) return { ran: false };
  if (force) claimInterval(input.session_id, 'pulse', 0, deps);
  else if (!claimPulse(input.session_id, deps)) return { ran: false };
  // Heavy import only after a successful claim, so the gated path stays at node startup.
  const runCheckpoint =
    deps.runCheckpoint == null ? (await import('./cli-checkpoint.mjs')).runCheckpoint : deps.runCheckpoint;
  const result = await runCheckpoint({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    trigger: force ? 'precompact' : 'pulse',
    budgetMs,
    withTimeline: !force,
    withQuota: !force,
  });
  return { ran: true, result };
}
