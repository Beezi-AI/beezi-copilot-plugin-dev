// Environment flag parsing: one definition per flag, read from the env object the caller passes.

export const WATCHER_ENV_VAR = 'BEEZI_COPILOT_WATCHER';

// The values that turn the session watcher off (trimmed, any case).
export const WATCHER_OFF_VALUES = Object.freeze(['0', 'false', 'no', 'off', 'disabled']);

// False only for an explicit off value (trimmed, any case).
export function isWatcherEnabled(env) {
  const raw = env == null ? undefined : env[WATCHER_ENV_VAR];
  if (typeof raw !== 'string') return true;
  return WATCHER_OFF_VALUES.indexOf(raw.trim().toLowerCase()) === -1;
}
