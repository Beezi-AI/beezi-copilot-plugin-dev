import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { runStatusline } from '../lib/statusline/passthrough.mjs';
import { badgeEnabled } from '../lib/state/statusline-badge.mjs';

// Beezi status line: a pass-through wrapper that records a local snapshot, then renders the user's own line
// (logic and its ordering rules in lib/statusline/passthrough.mjs).
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const raw = readHookStdin();

// The opt-in badge, called by runStatusline after the capture and the line; its text module loads only when it is on.
async function badgeFor(payload) {
  try {
    if (!badgeEnabled()) return null;
    const { statuslineBadge } = await import('../lib/ux/statusline-badge-text.mjs');
    return await statuslineBadge(payload);
  } catch {
    return null;
  }
}

runStatusline(raw, { badge: () => badgeFor(raw) });
