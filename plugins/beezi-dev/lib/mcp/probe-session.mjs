// The Copilot app's probe sessions: it opens them at every launch with cwd `/` or under
// <copilot home>/canvas-catalog-probe, and each starts this MCP server. They get no watcher and no eager portal handshake.
import path from 'path';
import { copilotHome, copilotSessionFile } from '../config/copilot-paths.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { normPath, pathHasPrefix } from '../core/fs-paths.mjs';
import { readSessionHead } from '../sources/cli/session-files.mjs';

const PROBE_DIR = 'canvas-catalog-probe';

export function isProbeCwd(cwd, home) {
  const dir = normPath(cwd);
  return dir === '/' || (dir != null && pathHasPrefix(dir, path.join(home, PROBE_DIR)));
}

// The folder of the session that spawned this server: the session id is exact at spawn time, though it may go stale later.
function spawningSessionCwd(env, readHead) {
  const id = env.COPILOT_AGENT_SESSION_ID;
  if (!isUsableSessionId(id)) return null;
  const head = readHead(copilotSessionFile(id));
  return head == null ? null : head.cwd;
}

// This process's own cwd or its spawning session's folder is a probe's. Never throws.
export function isProbeSession({ env = process.env, cwd = null, home = copilotHome(), readHead = readSessionHead } = {}) {
  try {
    const own = cwd == null ? process.cwd() : cwd;
    return isProbeCwd(own, home) || isProbeCwd(spawningSessionCwd(env, readHead), home);
  } catch {
    return false;
  }
}
