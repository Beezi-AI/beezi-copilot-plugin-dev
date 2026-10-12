// The machine-wide flag behind the usage-hold notice: Copilot's usage store changed shape, so per_call sessions hold until an update.
import fs from 'fs';
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { isPlain } from '../core/guards.mjs';

const flagFile = () => path.join(beeziHome(), 'usage-store-hold.json');

// Records the hold once per reason; never throws.
export function markUsageHold(reason, nowMs = Date.now()) {
  try {
    const current = readUsageHold();
    if (current == null || current.reason !== reason) writeJsonSecure(flagFile(), { reason, since: new Date(nowMs).toISOString() });
  } catch { /* the notice is best-effort */ }
}

// Drops the flag once a per_call read succeeds again; never throws.
export function clearUsageHold() {
  try { fs.unlinkSync(flagFile()); } catch { /* none set */ }
}

// → { reason, since } while per_call sessions are held on the store's shape, else null.
export function readUsageHold() {
  const v = readJson(flagFile(), null);
  return isPlain(v) && typeof v.reason === 'string' && typeof v.since === 'string' ? { reason: v.reason, since: v.since } : null;
}
