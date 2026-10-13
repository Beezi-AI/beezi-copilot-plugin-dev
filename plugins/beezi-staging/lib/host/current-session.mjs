// The Copilot session a command runs in, from the host session resolver.
import { resolveSessionId } from './session-resolver.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';

// Null when the session is missing, ambiguous or not a usable id; never throws.
export function currentSessionId(cwd = process.cwd()) {
  try {
    const found = resolveSessionId({ env: process.env, cwd });
    if (found == null || found.ambiguous === true) return null;
    return isUsableSessionId(found.sessionId) ? found.sessionId : null;
  } catch {
    return null;
  }
}
