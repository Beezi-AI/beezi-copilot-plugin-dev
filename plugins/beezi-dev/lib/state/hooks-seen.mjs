// The hooks-seen record: when each hook last fired on this machine.
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { isPlain } from '../core/guards.mjs';

const hooksSeenFile = () => path.join(beeziHome(), 'hooks-seen.json');

// { <event>: <iso> } of the hooks that fired on this machine; read by the status report. Best effort, one small atomic write.
export function recordHookSeen(event, { now = Date.now() } = {}) {
  try {
    const seen = readHooksSeen();
    seen[event] = new Date(now).toISOString();
    writeJsonSecure(hooksSeenFile(), seen);
  } catch { /* a hook never fails over bookkeeping */ }
}

export function readHooksSeen() {
  const raw = readJson(hooksSeenFile(), null);
  const out = {};
  if (!isPlain(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'string' && Number.isFinite(Date.parse(raw[key]))) out[key] = raw[key];
  }
  return out;
}
