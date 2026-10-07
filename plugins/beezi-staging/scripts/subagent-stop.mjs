import { readHookInput, normalizeHookInput } from '../lib/hook-input.mjs';
import { subagentMarkerFromPayload, appendSubagentMarker } from '../lib/subagents-copilot.mjs';

// Appends one marker line, which carries no text of the subagent's answer. Prints nothing: a `decision:"block"` here would force the subagent to continue.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
try {
  const input = normalizeHookInput(readHookInput());
  if (input != null) appendSubagentMarker(input.session_id, subagentMarkerFromPayload('stop', input));
} catch { /* a marker is never worth a visible failure */ }
process.exitCode = 0;
