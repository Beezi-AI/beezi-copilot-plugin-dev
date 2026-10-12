// The workspace the MCP bridge reads from for an account row, memoized briefly on the bridge state.
import { accountRowFor, isMultiTenant, tenantById } from '../workspace/tenants.mjs';
import { findSessionWorkspaceByCwd, readSessionWorkspace } from '../workspace/session-routes.mjs';
import { resolveReadTenant } from '../workspace/targets.mjs';
import { resolveSessionId } from '../host/session-resolver.mjs';
import { loadSessionState } from '../state/session-state.mjs';
import { str } from '../core/guards.mjs';

// Every message re-reads the session's read workspace; this bounds that to one read per burst.
const WORKSPACE_MEMO_MS = 2_000;

// The folder the session recorded (its workspace state, else its session state); never this process's own cwd.
function recordedCwd(sessionId) {
  const workspace = readSessionWorkspace(sessionId);
  return str(workspace == null ? null : workspace.cwd) || str(loadSessionState(sessionId).cwd);
}

const DEFAULT_SOURCES = Object.freeze({
  resolveSession: () => resolveSessionId({ cwd: null }),
  readWorkspace: readSessionWorkspace,
  recordedCwd,
  findByCwd: findSessionWorkspaceByCwd,
});

// The session's workspace state: the resolved session's own, else the newest one recorded in the folder that session ran in.
function sessionWorkspace(sources) {
  const found = sources.resolveSession();
  if (found == null) return null;
  // An ambiguous answer never picks the workspace: the newest session recorded in its folder does.
  const own = found.ambiguous === true ? null : sources.readWorkspace(found.sessionId);
  if (own != null) return own;
  const cwd = sources.recordedCwd(found.sessionId);
  const byCwd = cwd == null ? null : sources.findByCwd(cwd);
  return byCwd == null ? null : byCwd.state;
}

// One or unknown workspaces go headerless; several always read from one (before SessionStart: New folders' default or the first).
// `sources` replaces the session lookups (tests).
export function computeBridgeWorkspace(row, sources = DEFAULT_SOURCES) {
  if (!isMultiTenant(row)) return { tenantId: null, name: null };
  const account = accountRowFor(row);
  const tenantId = resolveReadTenant(account, sessionWorkspace(sources)).tenantId;
  const tenant = tenantById(account, tenantId);
  return { tenantId, name: tenant != null && tenant.name ? tenant.name : tenantId };
}

// `fresh` skips the memo: a tools/call must see a `read` switch made a moment ago. The memo lives in `bridge.workspaceMemo`
// and is keyed by the whole row, so a changed New folders default or rule is seen at once.
export function resolveBridgeWorkspace(bridge, row, fresh = false) {
  const key = row == null ? null : JSON.stringify(row);
  const now = Date.now();
  const memo = bridge.workspaceMemo;
  if (!fresh && memo != null && memo.key === key && now - memo.at < WORKSPACE_MEMO_MS) {
    return memo.value;
  }
  const value = computeBridgeWorkspace(row);
  bridge.workspaceMemo = { key, at: now, value };
  return value;
}
