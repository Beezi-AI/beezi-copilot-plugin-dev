import {
  grantConsent, denyConsent, grantCorrelation, denyCorrelation,
  isTelemetryGranted, isCorrelationGranted,
} from '../lib/telemetry-consent.mjs';
import { purgeAllDiagnostics, purgeCorrelatedDiagnostics } from '../lib/telemetry-flush.mjs';
import { checkInteractive } from '../lib/mode-guard.mjs';

const CORRELATION_ON = 'An installation ID is attached, so a report can be matched to the last '
  + 'Beezi account linked here.';
const CORRELATION_OFF = 'Reports are anonymous — no installation ID is attached.';

const MODES = ['on', 'off', 'correlate', 'anonymous'];

export function setTelemetry(mode) {
  // A consent answer produced by autopilot is not consent. Showing the current setting is never refused.
  if (MODES.indexOf(mode) !== -1) {
    const verdict = checkInteractive({ purpose: 'changing crash-report consent' });
    if (verdict.ok === false) return `✗ ${verdict.message}`;
  }
  if (mode === 'on') {
    grantConsent();
    return `Beezi diagnostics are ON. Crash reports about the plugin will be sent — never your code or prompts. ${isCorrelationGranted() ? CORRELATION_ON : CORRELATION_OFF} Recommended: /beezi-staging-settings telemetry correlate attaches one so support can find your report.`;
  }
  if (mode === 'off') {
    denyConsent();
    // Anything already recorded, and the correlation identity, must not survive the answer.
    purgeAllDiagnostics();
    return 'Beezi diagnostics are OFF. Pending reports and the installation ID were deleted.';
  }
  if (mode === 'correlate') {
    grantCorrelation();
    return `Beezi diagnostics are ON with account correlation. ${CORRELATION_ON} Use /beezi-staging-settings telemetry anonymous to turn correlation off again.`;
  }
  if (mode === 'anonymous') {
    denyCorrelation();
    // Reports already stamped with the ID go; the anonymous ones stay and keep being sent.
    purgeCorrelatedDiagnostics();
    return `Beezi diagnostics stay ON, without account correlation. ${CORRELATION_OFF} Pending correlated reports were deleted.`;
  }
  if (!isTelemetryGranted()) {
    return 'Beezi diagnostics are OFF. Use /beezi-staging-settings telemetry on|off|correlate|anonymous to change.';
  }
  return `Beezi diagnostics are ON. ${isCorrelationGranted() ? CORRELATION_ON : CORRELATION_OFF} Use /beezi-staging-settings telemetry on|off|correlate|anonymous to change.`;
}

if (process.argv[1] && process.argv[1].endsWith('telemetry.mjs')) {
  process.stdout.write(`${setTelemetry(process.argv[2])}\n`);
}
