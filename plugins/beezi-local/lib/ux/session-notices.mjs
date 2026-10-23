// The SessionStart notice texts and the account labels that prefix them.
import { hasBeenAsked, hasCorrelationBeenAsked, isTelemetryGranted } from '../telemetry/consent.mjs';
import { TrackingMode } from '../state/tracking.mjs';
import { isMultiTenant } from '../workspace/tenants.mjs';

export const AUTH_TEMPORARILY_UNAVAILABLE_NOTICE = 'Beezi: authentication is temporarily unavailable.';
export const LINK_REJECTED_NOTICE = '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi-local-login to authorize it again.';
export const PLAN_UNKNOWN_NOTICE = 'Beezi: your Copilot plan is unknown. Tell Beezi in /beezi-local-settings.';
export const STATUSLINE_DETACHED_NOTICE = 'Beezi: your status line no longer runs Beezi\'s wrapper. Turn it back on with /beezi-local-settings statusline on.';
export const SYNC_NUDGE = 'Beezi: run /beezi-local-sync any time to upload your past sessions.';

// The consent ask, or null once it was answered or shown. It is not stamped as asked here: it is stamped only by a
// channel that is known to show it to the user, so the user keeps being asked until they answer.
export function consentPrompt() {
  if (hasBeenAsked()) return null;
  return 'Beezi can send crash reports about the plugin itself — versions, OS, which plugin file '
    + 'failed, and whether it was signed in. Never your code, prompts, or file paths. It helps us '
    + 'fix bugs we would otherwise never see. Recommended: /beezi-local-settings telemetry correlate — the same '
    + 'reports plus a random installation ID, so support can find yours and tell you when it is '
    + 'fixed. Prefer to stay anonymous? /beezi-local-settings telemetry on sends the reports without that ID. '
    + '/beezi-local-settings telemetry off declines everything.';
}

// Offered once to a machine that already sends anonymous diagnostics; same no-stamp rule as consentPrompt.
export function correlationOffer() {
  if (!isTelemetryGranted() || hasCorrelationBeenAsked()) return null;
  return 'Beezi diagnostics are on. Optionally, a random installation ID can associate a failure '
    + 'with the last Beezi account linked on this machine, so support can find your report. It is '
    + 'off unless you turn it on: run /beezi-local-settings telemetry correlate to allow it, or ignore this — '
    + 'anonymous reporting continues either way.';
}

// A notice line with its leading "Beezi:" replaced by the account's label.
export function labelled(line, label) {
  return line.replace('Beezi:', `${label}:`);
}

// "Beezi", or "Beezi (<name>)" when several accounts are linked. A multi-workspace account's tenantName is the
// web-side workspace, so it is named by email.
export function accountLabel(session, several) {
  return several ? `Beezi (${(isMultiTenant(session) ? null : session.tenantName) || session.email || session.key})` : 'Beezi';
}

// Tells an Audit or dark workspace what it is, pointing an Audit one at /beezi-local-sync while its past-sessions offer is open;
// null for a live workspace (its /beezi-local-sync line is SYNC_NUDGE, ranked below the result notices).
export function trackingPolicyNotice(tracking, offerOpen) {
  const mode = tracking == null || tracking.trackingMode == null ? null : tracking.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY) {
    return offerOpen
      ? 'Beezi: audit mode — new sessions are not tracked. Run /beezi-local-sync to upload your past sessions, or upgrade your workspace plan to track new sessions.'
      : 'Beezi: audit mode — new sessions are not tracked. Upgrade your workspace plan to start tracking them.';
  }
  if (mode === TrackingMode.DISABLED) return 'Beezi: analytics are off for this workspace.';
  return null;
}
