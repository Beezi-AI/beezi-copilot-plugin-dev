import { EVENT_TYPES, dataOf, sessionStartOf } from './event-types.mjs';
import { readWorkspaceYaml } from './session-name.mjs';

// vscode-agent-host keeps its own label: the portal reads `vscode` as VS Code Local chat.
const SURFACE_BY_CLIENT = { 'github/cli': 'cli', 'github/autopilot': 'app', 'vscode-agent-host': 'vscode-agent-host' };
const SYSTEM_MESSAGE = 'system.message';
const ORIGINATOR_MAX = 100;
const CLI_VERSION_MAX = 50;
const NONE = Object.freeze({ source: null, originator: null, cliVersion: null });

function clientNameOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

// The commit-trailer client of the first system.message before any resume: later trailers name the resuming client.
function trailerClient(events) {
  for (const e of events) {
    if (e == null) continue;
    if (e.type === EVENT_TYPES.SESSION_RESUME) return null;
    if (e.type !== SYSTEM_MESSAGE) continue;
    const meta = dataOf(e).metadata;
    const vars = meta != null && typeof meta === 'object' ? meta.variables : null;
    const trailer = vars != null && typeof vars === 'object' ? vars.gitCommitTrailer : null;
    const name = trailer != null && typeof trailer === 'object' ? clientNameOf(trailer.clientName) : null;
    if (name != null) return name;
  }
  return null;
}

// The creating runtime's copilotVersion; app runtimes before 1.1.27 write 0.0.0, which names no version.
function creatingVersion(events) {
  const v = dataOf(sessionStartOf(events)).copilotVersion;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return /^\d+\.\d+/.test(trimmed) && !/^0\.0\.0(?:$|[^\d])/.test(trimmed) ? trimmed.slice(0, CLI_VERSION_MAX) : null;
}

// The client that CREATED the session: first trailer clientName, else workspace.yaml client_name, else app when appSession.
// → { source, originator (raw client name), cliVersion }; deterministic from the file, so every segment and resume agrees.
export function creatingSurface(events, workspaceYaml, appSession = false) {
  const list = Array.isArray(events) ? events : [];
  const yaml = workspaceYaml != null && typeof workspaceYaml === 'object' ? workspaceYaml : {};
  const client = trailerClient(list) || clientNameOf(yaml.client_name);
  const known = client != null && Object.prototype.hasOwnProperty.call(SURFACE_BY_CLIENT, client);
  const source = known ? SURFACE_BY_CLIENT[client] : (client == null && appSession === true ? 'app' : null);
  return { source, originator: client == null ? null : client.slice(0, ORIGINATOR_MAX), cliVersion: creatingVersion(list) };
}

// creatingSurface over the session's own workspace.yaml; never throws.
export function sessionSurface(sessionId, transcriptPath, events, appSession = false) {
  try {
    return creatingSurface(events, readWorkspaceYaml(sessionId, transcriptPath), appSession);
  } catch {
    return NONE;
  }
}

// The `source` value alone, for callers not yet on sessionSurface.
export function clientSurfaceOf(sessionId, transcriptPath, events) {
  return sessionSurface(sessionId, transcriptPath, events).source;
}
