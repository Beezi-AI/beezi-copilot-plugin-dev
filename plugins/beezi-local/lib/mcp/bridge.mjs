import { getAccessToken as _getAccessToken, getAuthentication as _getAuthentication } from '../auth/token.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { isOriginMismatch } from '../platform/http.mjs';
import { getDefaultKey as _getDefaultKey, getAccount as _getAccount } from '../accounts/index-store.mjs';
import { apiBase, apiOrigin } from '../config/api.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { recordMcpStartupFailure } from '../auth/diagnostics.mjs';
import { maybeSpawnDiagnostics as _maybeSpawnDiagnostics } from '../telemetry/trigger.mjs';
import { resolveBridgeWorkspace } from './bridge-workspace.mjs';
import { createLoginPoll } from './login-poll.mjs';
import {
  announceToolsChanged, createDeadline, emit, errorResponse, markRealInit, post, reinitialize, selectScope, writeMessage,
} from './http-session.mjs';
import {
  REJECTED_MESSAGE, STATUS_FAILED_MESSAGE, UNLINKED_INSTRUCTIONS, UNREACHABLE_INSTRUCTIONS, UNREACHABLE_MESSAGE,
  originRefusedMessage, requestFailedMessage, serverErrorMessage, unavailableMessage,
} from './messages.mjs';
import {
  SERVER_INSTRUCTIONS, STATUS_TOOL, isInitialize, isInitializedNotice, refuseHidden, requestIds, splitStatusCalls, toolCallIds,
} from './tool-filter.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Copilot runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// /beezi-local-login credentials the commands and hooks use (refresh included).
// Server→client push (the standing GET stream) is not bridged: the Beezi
// tools are strictly request/response.

// Bounds a hung request, not normal tool latency (some tools take seconds). Measured from the
// last byte received rather than from the start, so a slow tool keeps its time as long as the
// stream is making progress.
const DEFAULT_TIMEOUT_MS = 120_000;
// The handshake gets a tighter budget than a tool call: an MCP client abandons a server that
// has not answered `initialize` within ~30s, so a reply that lands after that is worth nothing —
// the client is already gone and the server shows as forever "connecting".
const HANDSHAKE_TIMEOUT_MS = 20_000;
// While unlinked, the login poll looks for the credentials /beezi-local-login is about to store this often.
const WATCH_INTERVAL_MS = 15_000;

let warnedMcpUrl = false;

// The bearer token goes only here: BEEZI_MCP_URL when it is https (or http on loopback), else the API's own /mcp.
// A rejected override is logged once, by scheme and host only, and ignored.
export function mcpUrl() {
  const override = process.env.BEEZI_MCP_URL;
  if (override == null || override === '') return `${apiBase()}/mcp`;
  let parsed = null;
  try { parsed = new URL(override); } catch { /* rejected below */ }
  const loopback = parsed != null && ['localhost', '127.0.0.1', '[::1]'].indexOf(parsed.hostname) !== -1;
  if (parsed != null && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) return override;
  if (!warnedMcpUrl) {
    warnedMcpUrl = true;
    const where = parsed == null ? 'not a URL' : `${parsed.protocol}//${parsed.host}`;
    process.stderr.write(`[beezi-mcp] ignoring BEEZI_MCP_URL (${where}): it must be https, or http on localhost\n`);
  }
  return `${apiBase()}/mcp`;
}

// Without getAuthentication, a getAccessToken seam alone reads a token as ready and its absence as unlinked.
function resolveAuthentication(deps, getToken) {
  if (deps.getAuthentication != null) return deps.getAuthentication;
  if (deps.getAccessToken == null) return _getAuthentication;
  return async (d, o) => {
    const token = await Promise.resolve().then(() => getToken(d, o)).catch(() => null);
    return token
      ? { authState: AUTH_STATES.READY, accessToken: token }
      : { authState: AUTH_STATES.UNLINKED, accessToken: null };
  };
}

// The bridge's explicit state: injected I/O, the portal session (scope, session id, replayable initialize) and the queue.
function createBridgeState(deps) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  return {
    fetchImpl,
    url: deps.url == null ? mcpUrl() : deps.url,
    write: deps.write,
    logError: deps.logError == null ? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`)) : deps.logError,
    maybeSpawnDiagnostics: deps.maybeSpawnDiagnostics == null ? _maybeSpawnDiagnostics : deps.maybeSpawnDiagnostics,
    getToken,
    getAuthentication: resolveAuthentication(deps, getToken),
    getDefaultKey: deps.getDefaultKey || _getDefaultKey,
    getAccount: deps.getAccount || _getAccount,
    timeoutMs,
    // A probe session answers initialize here and reaches the portal only when a later request needs it.
    lazyHandshake: deps.lazyHandshake === true,
    handshakeMs: Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS),
    sessionAccount: undefined,
    sessionTenant: undefined,
    toolsChanged: false, // a tenant switch re-initialized the session; the client must re-fetch tools
    workspaceMemo: null,
    requestQueue: Promise.resolve(),
    sessionId: null,
    initializeMsg: null,
    reinit: null, // in-flight transparent re-initialize, shared by concurrent 404s
    realInitDone: false, // the portal has actually seen initialize for this bridge
    onRealInit: () => {},
  };
}

function spawnDiagnostics(bridge) {
  try { bridge.maybeSpawnDiagnostics(); } catch { /* never */ }
}

// Answers the handshake locally with an empty tool list; the next forwarded request replays the real one first.
function writeLocalHandshake(bridge, msg, instructions) {
  writeMessage(bridge, {
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      protocolVersion:
        msg.params != null && msg.params.protocolVersion != null
          ? msg.params.protocolVersion
          : '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'beezi', version: '0.0.0' },
      instructions,
    },
  });
}

// A local handshake plus the login poll, which replays the real one. Shared by the unlinked machine and by a handshake the
// portal could not serve.
function synthesizeHandshake(bridge, msg, instructions) {
  writeLocalHandshake(bridge, msg, instructions);
  bridge.loginPoll.start();
}

// An unlinked machine still gets a healthy server: the handshake succeeds locally, the tool
// list is empty, and only actual calls explain what to do. Erroring initialize instead
// strands the very login flow that fixes the link.
function handleUnlinked(bridge, msg, ids, authState) {
  if (isInitialize(msg)) {
    synthesizeHandshake(bridge, msg, authState === AUTH_STATES.UNLINKED ? UNLINKED_INSTRUCTIONS : unavailableMessage(authState));
    return;
  }
  if (!Array.isArray(msg) && msg.method === 'tools/list' && msg.id !== undefined) {
    writeMessage(bridge, { jsonrpc: '2.0', id: msg.id, result: { tools: [STATUS_TOOL] } });
    return;
  }
  ids.forEach((id) => errorResponse(bridge, id, unavailableMessage(authState)));
}

// Answers beezi_status here: the report is built in this process, which holds the stored login.
async function runStatusTool(bridge, id) {
  try {
    const { buildStatusReport } = await import('../ux/status-report.mjs');
    const lines = await buildStatusReport({ budgetMs: 8000 });
    writeMessage(bridge, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: lines.join('\n') }] } });
  } catch {
    writeMessage(bridge, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: STATUS_FAILED_MESSAGE }] } });
  }
}

// The account, its row and the read workspace this message goes to, with the session scoped to them; null when unreadable.
async function resolveScope(bridge, msg) {
  try {
    const account = await bridge.getDefaultKey();
    const row = account ? await bridge.getAccount(account) : null;
    const scope = resolveBridgeWorkspace(bridge, row, toolCallIds(msg).length > 0);
    selectScope(bridge, account, scope.tenantId);
    return { account, row, scope };
  } catch (_) {
    return null;
  }
}

// The bearer token for this message, or null once the message has been answered without one.
async function authenticate(bridge, msg, ids, { account, row, scope }) {
  const auth = await Promise.resolve()
    .then(() => bridge.getAuthentication({}, { account }))
    .catch(() => ({ authState: AUTH_STATES.UNAVAILABLE, accessToken: null }));
  if (auth.authState === AUTH_STATES.READY) {
    return pinnedTo({ key: account, token: auth.accessToken, clientId: auth.clientId || (row && row.clientId), tenantId: scope.tenantId }, auth);
  }
  // The bridge cannot start with real tools. Recorded with the reason the accessor gave, and
  // delivered without a token — this is exactly the failure a token could not report. Unlinked is a normal state.
  if (isInitialize(msg)) {
    if (auth.authState !== AUTH_STATES.UNLINKED) recordMcpStartupFailure(null, auth.reason);
    spawnDiagnostics(bridge);
  }
  handleUnlinked(bridge, msg, ids, auth.authState);
  return null;
}

// Linked after a synthetic handshake: the portal has never seen initialize, so replay it before
// forwarding anything else — the same rebuild the 404 path uses. → false once the message was failed.
async function replayHandshake(bridge, msg, ids, token) {
  if (bridge.realInitDone || isInitialize(msg) || !bridge.initializeMsg) return true;
  try {
    await reinitialize(bridge, token);
  } catch (error) {
    ids.forEach((id) => errorResponse(bridge, id, isOriginMismatch(error) ? originRefused(bridge) : UNREACHABLE_MESSAGE));
    return false;
  }
  if (bridge.toolsChanged) {
    bridge.toolsChanged = false;
    announceToolsChanged(bridge);
  }
  return true;
}

// POSTs the message, rebuilding a lost portal session (404) and renewing a dead token (401) once each.
async function postWithRetries(bridge, msg, token, deadline) {
  let res = await post(bridge, msg, token, deadline);
  if (res.status === 404 && bridge.initializeMsg && !isInitialize(msg)) {
    await reinitialize(bridge, token);
    res = await post(bridge, msg, token, deadline);
  }
  // A 401 is the server telling us the token is dead — better evidence than the expires_at
  // we estimated locally, which is a pure guess when the token response omits expires_in.
  // Renew once on its word and retry, so a short-lived token doesn't strand the whole
  // MCP server until the user re-links by hand.
  if (res.status === 401) {
    const refreshed = await bridge.getToken({}, { account: token.key, forceRefresh: true }).catch(() => null);
    if (refreshed && refreshed !== token.token) res = await post(bridge, msg, { ...token, token: refreshed }, deadline);
  }
  return res;
}

// A status the portal may answer differently in a moment: the login poll keeps replaying a handshake it refused this way.
const transientStatus = (status) => status >= 500 || status === 408 || status === 429;

// Streams a 2xx to the client, noting each id answered; any other status answers every request id with the reason.
async function replyTo(bridge, msg, ids, res, { deadline, note, answered }) {
  if (res.ok) {
    if (isInitialize(msg)) markRealInit(bridge);
    await emit(bridge, res, { deadline, note, answered, initId: isInitialize(msg) ? msg.id : undefined });
    return;
  }
  // 403 is authenticated-but-not-permitted: no token can change it, so it gets the server's own sentence, never the relink one.
  const message = res.status === 401 ? REJECTED_MESSAGE : await serverErrorMessage(res);
  // A failed handshake strands a stdio server for the session, so it is answered here and replayed before the next request.
  if (isInitialize(msg)) {
    if (transientStatus(res.status)) synthesizeHandshake(bridge, msg, message);
    else writeLocalHandshake(bridge, msg, message);
    return;
  }
  ids.forEach((id) => errorResponse(bridge, id, message));
}

// The answer to a token kept home: a BEEZI_MCP_URL outside the API origin, or a login pinned to another API.
function originRefused(bridge) {
  return originRefusedMessage(new URL(bridge.url).origin !== apiOrigin());
}

// Only a thrown error lands here — a timeout or a dead socket, never the portal's own answer. `ids` are the unanswered ones.
function answerThrown(bridge, msg, ids, error) {
  if (ids.length === 0) return;
  // A credential pinned to another API origin was never sent: not an outage, and the poll replays the handshake
  // once a new login lands.
  if (isOriginMismatch(error)) {
    if (isInitialize(msg)) synthesizeHandshake(bridge, msg, originRefused(bridge));
    else ids.forEach((id) => errorResponse(bridge, id, originRefused(bridge)));
    return;
  }
  // Failing the handshake strands the server for the rest of the session: the client marks it failed and stdio
  // servers are never retried. Answer it locally instead and let the login poll replay it once the portal is reachable.
  if (isInitialize(msg)) {
    recordIssue({ code: DIAGNOSTIC_CODES.MCP_HANDSHAKE_TIMEOUT, source: DIAGNOSTIC_SOURCES.MCP_BRIDGE, error });
    spawnDiagnostics(bridge);
    synthesizeHandshake(bridge, msg, UNREACHABLE_INSTRUCTIONS);
    return;
  }
  // Idle-deadline aborts are routine after a laptop sleep — benign-fallback noise, not a
  // defect, so this does not record it (unlike the handshake timeout above).
  ids.forEach((id) => errorResponse(bridge, id, requestFailedMessage(error)));
}

async function forward(bridge, msg, ids, token, scope) {
  const deadline = createDeadline(isInitialize(msg) ? bridge.handshakeMs : bridge.timeoutMs);
  const callIds = scope.tenantId == null ? [] : toolCallIds(msg);
  const note = callIds.length === 0 ? null : { ids: callIds, text: `Beezi: reading from ${scope.name}.` };
  // A stream that stalls after delivering some answers fails only the ids still waiting.
  const answered = new Set();
  try {
    const res = await postWithRetries(bridge, msg, token, deadline);
    await replyTo(bridge, msg, ids, res, { deadline, note, answered });
  } catch (error) {
    answerThrown(bridge, msg, ids.filter((id) => !answered.has(id)), error);
  } finally {
    deadline.stop();
  }
}

// What is left after the hidden tools and the local status tool are answered here; null when nothing is.
async function answerLocalCalls(bridge, original) {
  const { replies, rest } = refuseHidden(original);
  replies.forEach((reply) => writeMessage(bridge, reply));
  if (rest == null) return null;
  const { statusIds, rest: msg } = splitStatusCalls(rest);
  for (const id of statusIds) await runStatusTool(bridge, id);
  return msg;
}

// local calls → handshake bookkeeping → scope → auth → replay a synthetic handshake → forward and reply.
async function handleMessageNow(bridge, original) {
  const msg = await answerLocalCalls(bridge, original);
  if (msg == null) return;
  // Until the portal has seen initialize, the replay sends its own initialized notification.
  if (isInitializedNotice(msg) && !bridge.realInitDone) return;
  const ids = requestIds(msg);
  if (isInitialize(msg)) {
    bridge.initializeMsg = msg;
    bridge.sessionId = null;
    bridge.toolsChanged = false;
    if (bridge.lazyHandshake) {
      writeLocalHandshake(bridge, msg, SERVER_INSTRUCTIONS);
      return;
    }
  }
  const target = await resolveScope(bridge, msg);
  if (target == null) {
    handleUnlinked(bridge, msg, ids, AUTH_STATES.UNAVAILABLE);
    return;
  }
  const token = await authenticate(bridge, msg, ids, target);
  if (token == null) return;
  if (!(await replayHandshake(bridge, msg, ids, token))) return;
  await forward(bridge, msg, ids, token, target.scope);
}

export function createBridge(deps = {}) {
  const bridge = createBridgeState(deps);
  bridge.loginPoll = createLoginPoll(bridge, {
    getDefaultKey: bridge.getDefaultKey,
    getAuthentication: bridge.getAuthentication,
    getAccount: bridge.getAccount,
    setIntervalImpl: deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl,
    clearIntervalImpl: deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl,
    watchIntervalMs: deps.watchIntervalMs == null ? WATCH_INTERVAL_MS : deps.watchIntervalMs,
  });
  bridge.onRealInit = bridge.loginPoll.stop;

  function handleMessage(msg) {
    const pending = bridge.requestQueue.then(() => handleMessageNow(bridge, msg));
    bridge.requestQueue = pending.catch(() => {});
    return pending;
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      bridge.logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  return { handleLine, handleMessage };
}
