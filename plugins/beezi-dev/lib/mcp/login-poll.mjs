// While the handshake was answered locally, polls for the credentials /beezi-dev-login is about to store and replays the real one.
// A failed initialize would mark this server "failed" for the whole session — stdio servers are never retried — so the
// handshake must succeed even with no token, and this poll turns the eventual login into live tools with no /mcp reconnect.
import { pinnedTo } from '../auth/recipients.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { resolveBridgeWorkspace } from './bridge-workspace.mjs';
import { announceToolsChanged, reinitialize, selectScope } from './http-session.mjs';

// deps: { getDefaultKey, getAuthentication, getAccount, setIntervalImpl, clearIntervalImpl, watchIntervalMs }. → { start, stop },
// both idempotent.
export function createLoginPoll(bridge, deps) {
  let handle = null;

  function stop() {
    if (handle) {
      deps.clearIntervalImpl(handle);
      handle = null;
    }
  }

  // One poll, queued behind the client's messages: a ready credential makes it pick the scope and replay the handshake.
  async function pollOnce() {
    const account = await deps.getDefaultKey();
    const auth = await Promise.resolve().then(() => deps.getAuthentication({}, { account })).catch(() => null);
    if (auth == null || auth.authState !== AUTH_STATES.READY || !auth.accessToken) return;
    const row = account ? await deps.getAccount(account) : null;
    const tenantId = resolveBridgeWorkspace(bridge, row).tenantId;
    selectScope(bridge, account, tenantId);
    const token = pinnedTo({ key: account, token: auth.accessToken, clientId: (row && row.clientId), tenantId }, auth);
    try {
      await reinitialize(bridge, token);
      // The client accepted an empty tool list during the synthetic handshake; this makes
      // it re-fetch, so the Beezi tools appear the moment the login lands.
      bridge.toolsChanged = false;
      announceToolsChanged(bridge);
    } catch { /* portal unreachable — keep watching */ }
  }

  function start() {
    if (handle) return;
    handle = deps.setIntervalImpl(async () => {
      bridge.requestQueue = bridge.requestQueue.then(pollOnce).catch(() => {});
      return bridge.requestQueue;
    }, deps.watchIntervalMs);
    if (handle != null && typeof handle.unref === 'function') handle.unref();
  }

  return { start, stop };
}
