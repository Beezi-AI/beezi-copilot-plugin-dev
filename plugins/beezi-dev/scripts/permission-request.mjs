import { readHookInput, normalizeHookInput } from '../lib/hook-input.mjs';
import { permissionMarkerFromPayload, appendPermissionMarker } from '../lib/permission-markers.mjs';

// Records the instant Copilot is about to put a permission prompt on screen, so the session
// timeline can charge the wait that follows to the human instead of to the agent. An APPROVED
// prompt leaves no trace in events.jsonl to find later — this line is the only evidence.
//
// Deliberately the leanest hook in the plugin: two imports, no network, no telemetry wrapper. The
// permission dialog does not appear until this process exits, so every millisecond here is one the
// human spends looking at a frozen terminal. That is also why it does NOT go through runHook —
// that pulls in the telemetry stack and its file I/O for a hook whose whole job is one append.
//
// Prints nothing and always exits 0. Anything written to stdout would be read as a permission
// DECISION (`behavior` allow/deny), and a stray one would auto-approve or deny every prompt in the
// session — the failure mode is silent and total, so this file must never gain a console call.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
try {
  const input = normalizeHookInput(readHookInput());
  if (input != null) appendPermissionMarker(input.session_id, permissionMarkerFromPayload(input));
} catch { /* a marker is never worth a visible failure */ }
process.exitCode = 0;
