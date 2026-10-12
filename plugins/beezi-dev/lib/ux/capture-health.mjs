// Status and SessionStart text for what can stop or thin out capture: delivery health, credential storage, VS Code org
// policy, cloud and remote app sessions, per-call token detail and the usage-store hold. Pure: callers read the facts.
import { BACKENDS } from '../credentials/backends/process.mjs';

const BACKEND_LABELS = Object.freeze({
  [BACKENDS.KEYCHAIN]: 'macOS Keychain',
  [BACKENDS.SECRET_SERVICE]: 'system keyring (Secret Service)',
  [BACKENDS.CREDENTIAL_MANAGER]: 'Windows Credential Manager',
  [BACKENDS.DPAPI_FILE]: 'a file encrypted for your Windows account',
  [BACKENDS.FILE]: 'a file only your user account can read',
});

// "45 s", "12 min", "3 h", "2 d".
export function durationText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The plain next step when only a new sign-in releases an account's held reports.
export const REAUTH_TEXT = 'Sign in again with /beezi-dev-login';

function errorText(summary) {
  if (summary.reauthRequired === true) return null;
  if (summary.lastError == null) return null;
  return summary.lastHttpStatus == null ? summary.lastError : `${summary.lastError} (HTTP ${summary.lastHttpStatus})`;
}

// One account's delivery line for /beezi-dev-status, or null while nothing waits and nothing failed.
export function deliveryText(summary, now) {
  if (summary == null) return null;
  const { queue } = summary;
  const parts = [];
  if (queue.pending > 0) {
    parts.push(`${plural(queue.pending, 'report', 'reports')} waiting${queue.oldestAgeMs == null ? '' : `, oldest ${durationText(queue.oldestAgeMs)}`}`);
  }
  if (queue.rejected > 0) parts.push(`${plural(queue.rejected, 'report', 'reports')} refused by Beezi`);
  if (summary.backoffUntil != null) parts.push(`retrying in ${durationText(summary.backoffUntil - now)}`);
  const error = errorText(summary);
  if (error != null) parts.push(`last error: ${error}`);
  if (summary.reauthRequired === true) parts.push(REAUTH_TEXT);
  return parts.length === 0 ? null : parts.join(' · ');
}

// The SessionStart line for an account whose delivery is degraded, or null.
export function deliveryNotice(summary) {
  if (summary == null || !summary.degraded) return null;
  if (summary.reauthRequired === true) return `Beezi: analytics reports from this machine are held until you sign in again. ${REAUTH_TEXT}.`;
  return 'Beezi: some analytics reports from this machine are not uploading. Run /beezi-dev-status for details.';
}

// Where an account's sign-in is stored, or null when nothing is stored yet.
export function credentialText(storage) {
  if (storage == null) return null;
  const label = BACKEND_LABELS[storage.backend] || storage.backend;
  return storage.plaintext ? `${label}, not encrypted — no system secret store was usable` : label;
}

// VS Code's org policy line, or null when it blocks nothing Beezi needs.
export function policyText(policy) {
  if (policy == null || (!policy.hooksDisabled && !policy.mcpDisabled)) return null;
  const off = policy.hooksDisabled && policy.mcpDisabled ? 'hooks and MCP servers' : (policy.hooksDisabled ? 'hooks' : 'MCP servers');
  return `your organization turned off ${off} for VS Code Local chat, so those sessions are captured only while the Copilot CLI or app runs, or by /beezi-dev-sync. Sessions on the Copilot (Agent Host) harness are still captured live.`;
}

// The Copilot app's cloud and remote sessions, which leave no local record; null when there are none.
export function nonLocalText(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return `${plural(sessions.length, 'cloud or remote session is', 'cloud or remote sessions are')} not tracked: they leave no record on this machine`;
}

// The line for a Node without node:sqlite (session totals only), or null when per-call detail works or was not checked.
export function accuracyText(perCall) {
  return perCall === false
    ? 'session totals only — per-call detail needs Node.js 22.13 or later on the PATH Copilot uses'
    : null;
}

// The usage-store hold line, or null when none is set.
export function usageHoldText(hold) {
  if (hold == null) return null;
  return 'on hold: this Copilot version changed its usage database, so token detail waits for a Beezi update';
}

export const USAGE_HOLD_NOTICE = 'Beezi: this Copilot version changed its usage database, so token detail is on hold until Beezi is updated.';
