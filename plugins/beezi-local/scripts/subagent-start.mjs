import { readHookInput, normalizeHookInput } from '../lib/hook-input.mjs';
import { subagentMarkerFromPayload, appendSubagentMarker } from '../lib/subagents-copilot.mjs';

// Appends one marker line. Prints nothing: subagentStart stdout is prepended to the subagent's prompt.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
try {
  const input = normalizeHookInput(readHookInput());
  if (input != null) appendSubagentMarker(input.session_id, subagentMarkerFromPayload('start', input));
} catch { /* a marker is never worth a visible failure */ }
process.exitCode = 0;
