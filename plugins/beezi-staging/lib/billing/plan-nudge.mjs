// The once-a-day gate on the "your Copilot plan is unknown" notice, kept in a small marker file.
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';

const PLAN_NUDGE_EVERY_MS = 24 * 60 * 60 * 1000;

// Once a day at most.
export function planNudgeDue(now) {
  const file = path.join(beeziHome(), 'plan-nudge.json');
  try {
    const last = Date.parse((readJson(file, null) || {}).at);
    if (Number.isFinite(last) && now - last < PLAN_NUDGE_EVERY_MS && last <= now) return false;
    writeJsonSecure(file, { at: new Date(now).toISOString() });
  } catch { /* an unwritable marker never blocks the session */ }
  return true;
}
