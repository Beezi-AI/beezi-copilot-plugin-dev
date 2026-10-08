import { EVENT_TYPES } from './copilot-events.mjs';
import { readWorkspaceYaml } from './session-name.mjs';

const SURFACE_BY_CLIENT = { 'github/cli': 'cli', 'github/autopilot': 'app' };

// client_name names the client that created the workspace and no event names the current one, so a resumed session has no reliable surface.
export function clientSurfaceOf(sessionId, transcriptPath, events) {
  try {
    if ((Array.isArray(events) ? events : []).some((e) => e.type === EVENT_TYPES.SESSION_RESUME)) return null;
    const yaml = readWorkspaceYaml(sessionId, transcriptPath);
    const name = typeof yaml.client_name === 'string' ? yaml.client_name.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(SURFACE_BY_CLIENT, name) ? SURFACE_BY_CLIENT[name] : null;
  } catch {
    return null;
  }
}
