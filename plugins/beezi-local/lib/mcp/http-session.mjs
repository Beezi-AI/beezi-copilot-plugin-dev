// The bridge's session with the portal's Streamable-HTTP MCP endpoint, kept on the explicit bridge state object:
// request deadlines, POSTs, streaming responses to the client, the transparent re-initialize and the account/tenant scope.

import { resolveAbortController } from '../platform/compat-abort.mjs';
import { sseEvents } from './sse.mjs';
import { annotate, responseIds, withLocalInstructions, withLocalTools } from './tool-filter.mjs';
import { authHeaders } from '../platform/http.mjs';

const SESSION_HEADER = 'mcp-session-id';

export function writeMessage(bridge, obj) {
  bridge.write(JSON.stringify(obj));
}

export function errorResponse(bridge, id, message) {
  writeMessage(bridge, { jsonrpc: '2.0', id, error: { code: -32000, message } });
}

// Makes the client re-fetch the tool list.
export function announceToolsChanged(bridge) {
  writeMessage(bridge, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

// One deadline per exchange, covering the response body as well as the headers. Clearing it
// once the headers land — which is where the timeout used to end — leaves the stream read
// unguarded, and a socket the OS left half-open across a laptop sleep delivers headers and
// then nothing at all: no data, no close. That read never returns, so the request it belongs
// to never answers and, because `reinit` memoizes the promise, neither does anything queued
// behind it. `touch()` restarts the clock on every chunk, so progress buys more time.
export function createDeadline(ms) {
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  let timer = null;
  const arm = () => { timer = setTimeout(() => controller.abort(), ms); };
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  arm();
  return { signal: controller.signal, touch: () => { stop(); arm(); }, stop };
}

// The token goes only to its credential's pinned origin, and a redirect fails instead of carrying it on.
export async function post(bridge, msg, token, deadline) {
  return bridge.fetchImpl(bridge.url, {
    method: 'POST',
    headers: {
      ...authHeaders(token, bridge.url),
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(bridge.sessionId ? { [SESSION_HEADER]: bridge.sessionId } : {}),

    },
    body: JSON.stringify(msg),
    redirect: 'error',
    signal: deadline.signal,
  });
}

// Streams every JSON-RPC message of a response to stdout, re-serialized so
// each lands as one line. `silent` drains instead — used for the transparent
// re-initialize, whose response the client must not see twice. `note` annotates tools/call results; the ids of the
// responses written are added to `answered`.
export async function emit(bridge, res, { silent = false, deadline, note = null, initId, answered = null } = {}) {
  const newSession = res.headers.get(SESSION_HEADER);
  if (newSession) bridge.sessionId = newSession;
  if (res.status === 202 || res.status === 204) return;
  const relay = (text) => {
    if (silent) return;
    const obj = withLocalInstructions(withLocalTools(annotate(JSON.parse(text), note)), initId);
    writeMessage(bridge, obj);
    if (answered != null) responseIds(obj).forEach((id) => answered.add(id));
  };
  const contentType = res.headers.get('content-type');
  if ((contentType == null ? '' : contentType).includes('text/event-stream')) {
    for await (const data of sseEvents(res.body, deadline == null ? undefined : deadline.touch)) relay(data);
    return;
  }
  const text = await res.text();
  if (text) relay(text);
}

// The portal has now seen initialize for this bridge, so the login poll has nothing left to replay.
export function markRealInit(bridge) {
  bridge.realInitDone = true;
  bridge.onRealInit();
}

// The portal's MCP sessions are in-memory; an API restart between turns loses
// them (HTTP 404). Rebuild one transparently — replay initialize (response
// hidden) and the initialized notification — so the client never notices.
export function reinitialize(bridge, token) {
  if (bridge.reinit == null) {
    bridge.reinit = (async () => {
      const deadline = createDeadline(bridge.handshakeMs);
      try {
        bridge.sessionId = null;
        const res = await post(bridge, bridge.initializeMsg, token, deadline);
        if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
        await emit(bridge, res, { silent: true, deadline });
        const ack = await post(bridge, { jsonrpc: '2.0', method: 'notifications/initialized' }, token, deadline);
        await emit(bridge, ack, { deadline });
        markRealInit(bridge);
      } finally {
        deadline.stop();
      }
    })().finally(() => {
      bridge.reinit = null;
    });
  }
  return bridge.reinit;
}

// The portal keys the MCP session by account and by the X-Beezi-Tenant header, so either change starts a new one.
export function selectScope(bridge, account, tenantId) {
  if (bridge.sessionAccount !== account || bridge.sessionTenant !== tenantId) {
    if (bridge.sessionTenant !== undefined && bridge.sessionTenant !== tenantId) bridge.toolsChanged = true;
    bridge.sessionAccount = account;
    bridge.sessionTenant = tenantId;
    bridge.sessionId = null;
    bridge.realInitDone = false;
    bridge.reinit = null;
  }
}
