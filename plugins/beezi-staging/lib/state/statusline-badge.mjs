// Owns the machine's Beezi badge switch for the CLI status line.
import { statuslineBadgeFile } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';

// Off until turned on. Kept tiny: the status line reads it on every render.
export function badgeEnabled() {
  const raw = readJson(statuslineBadgeFile(), null);
  return raw != null && raw.enabled === true;
}

export function setBadgeEnabled(on) {
  writeJsonSecure(statuslineBadgeFile(), { version: 1, enabled: on === true });
}
