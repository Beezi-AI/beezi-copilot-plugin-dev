import { getAccessToken as _getAccessToken, getAuthentication as _getAuthentication } from './token.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { authHeaders } from './http.mjs';
import { getDefaultKey as _getDefaultKey, getAccount as _getAccount } from './accounts.mjs';
import { apiBase } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';
import { recordIssue } from './telemetry.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { recordMcpStartupFailure } from './telemetry-auth.mjs';
import { maybeSpawnDiagnostics as _maybeSpawnDiagnostics } from './diagnostics-trigger.mjs';
import {
  accountRowFor, findSessionWorkspaceByCwd, isMultiTenant, readSessionWorkspace, resolveReadTenant, tenantById,
} from './workspace.mjs';
import { resolveSessionId } from './sessions.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Copilot runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// /beezi-staging-login credentials the commands and hooks use (refresh included).
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
const SESSION_HEADER = 'mcp-session-id';
// V-15 is open (does the CLI re-fetch tools on list_changed?), so the messages that precede a login say how to load the tools.
const RESTART_HINT = ' Then run /restart (or start a new session) to load the Beezi tools.';
const NOT_LINKED_MESSAGE =
  `This machine is not linked to Beezi. Run /beezi-staging-login, or /beezi-staging-settings account to choose another linked account, then retry.${RESTART_HINT}`;
const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Run /beezi-staging-login to relink.";
// Not linked at all versus temporarily without a token are different answers, and telling a
// user with a perfectly good saved login to run /beezi-staging-login is what started the destructive
// loop in finding 6. Only `unlinked` gets the login sentence.
const RETRY_MESSAGE =
  'Beezi is renewing this machine\u2019s authorization. Your login is saved — retry in a moment.';
const REAUTH_MESSAGE =
  'Beezi\u2019s login server no longer accepts this machine\u2019s saved authorization. '
  + 'Run /beezi-staging-login to authorize it again, or /beezi-staging-settings account to choose another account.';
// While unlinked, poll for the credentials /beezi-staging-login is about to store. A failed initialize
// would mark this server "failed" for the whole session — stdio servers are never retried — so
// the handshake must succeed even with no token, and this poll turns the eventual login into
// live tools with no /mcp reconnect.
const WATCH_INTERVAL_MS = 15_000;
// Every message re-reads the session's read workspace; this bounds that to one read per burst.
const WORKSPACE_MEMO_MS = 2_000;

// Answered here, never forwarded: the portal knows nothing about this machine's hooks or watcher.
export const STATUS_TOOL = Object.freeze({
  name: 'beezi_status',
  title: 'Beezi status',
  description:
    'Report whether this machine is linked to Beezi, as which account, against which Beezi API, ' +
    'whether hooks and the session watcher are running, and whether a plugin update is available. ' +
    'Call it when the user asks about their Beezi link or why Beezi analytics look empty. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
});

// Ticket, estimation and repo-browsing tools the server still offers: dropped from every tools/list and refused locally.
const HIDDEN_TOOLS = [
  'create_ticket', 'start_ticket', 'estimate_task', 'get_drafting_instructions', 'get_ticket_template',
  'get_estimation', 'get_estimation_instructions', 'list_my_tickets', 'list_projects', 'list_repositories',
  'list_directory', 'read_file', 'search_code', 'search_files', 'resolve_project',
];
const HIDDEN_TOOL_MESSAGE = 'Ticket creation, estimation and repository browsing are not part of the Beezi Copilot plugin.';
// Replaces the server's initialize instructions, which still describe the hidden ticket tools.
const SERVER_INSTRUCTIONS =
  'Beezi analytics tools: get_local_flow_summary, query_local_flow_metric, get_local_flow_session, list_local_flow_scopes, '
  + 'get_analytics_instructions and get_my_usage_summary. Call get_analytics_instructions before producing a personal '
  + 'analytics summary. Follow structured status and nextAction values returned by tools.';

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

// Yields the data payload of each SSE event (multi-line `data:` fields joined
// per the SSE spec). The server closes the stream once every response for the
// POST has been sent, which ends the iteration.
async function* sseEvents(body, onProgress) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    if (onProgress) onProgress();
    buf += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

export function createBridge(deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const maybeSpawnDiagnostics = deps.maybeSpawnDiagnostics == null ? _maybeSpawnDiagnostics : deps.maybeSpawnDiagnostics;
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const getAuthentication = deps.getAuthentication != null
    ? deps.getAuthentication
    : (deps.getAccessToken == null
      ? _getAuthentication
      : async (d, o) => {
        const token = await Promise.resolve().then(() => getToken(d, o)).catch(() => null);
        return token
          ? { authState: AUTH_STATES.READY, accessToken: token }
          : { authState: AUTH_STATES.UNLINKED, accessToken: null };
      });
  const url = deps.url == null ? mcpUrl() : deps.url;
  const write = deps.write;
  const logError = deps.logError == null ? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`)) : deps.logError;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const handshakeMs = Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS);

  const getDefaultKey = deps.getDefaultKey || _getDefaultKey;
  const getAccount = deps.getAccount || _getAccount;
  let sessionAccount;
  let sessionTenant;
  let toolsChanged = false; // a tenant switch re-initialized the session; the client must re-fetch tools
  let workspaceMemo = null;
  let requestQueue = Promise.resolve();
  let sessionId = null;
  let initializeMsg = null;
  let reinit = null; // in-flight transparent re-initialize, shared by concurrent 404s
  let realInitDone = false; // the portal has actually seen initialize for this bridge
  let watcher = null;
  const setIntervalImpl = deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl;
  const clearIntervalImpl = deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl;
  const watchIntervalMs = deps.watchIntervalMs == null ? WATCH_INTERVAL_MS : deps.watchIntervalMs;

  const isInitialize = (msg) => !Array.isArray(msg) && msg.method === 'initialize';

  // The MCP process has no hook input: the session comes from the resolver, else the newest one recorded in this directory.
  // One or unknown workspaces go headerless; several always read from one (before SessionStart: New folders' default or the first).
  function computeBridgeWorkspace(row) {
    if (!isMultiTenant(row)) return { tenantId: null, name: null };
    const cwd = process.cwd();
    const found = resolveSessionId({ cwd });
    // An ambiguous answer never picks the workspace: the newest session recorded here does.
    let state = found != null && found.ambiguous !== true ? readSessionWorkspace(found.sessionId) : null;
    if (state == null) {
      const byCwd = findSessionWorkspaceByCwd(cwd);
      state = byCwd == null ? null : byCwd.state;
    }
    const account = accountRowFor(row);
    const tenantId = resolveReadTenant(account, state).tenantId;
    const tenant = tenantById(account, tenantId);
    return { tenantId, name: tenant != null && tenant.name ? tenant.name : tenantId };
  }

  // `fresh` skips the memo: a tools/call must see a `read` switch made a moment ago.
  function resolveBridgeWorkspace(row, fresh = false) {
    const key = row == null ? null : row.key;
    const now = Date.now();
    if (!fresh && workspaceMemo != null && workspaceMemo.key === key && now - workspaceMemo.at < WORKSPACE_MEMO_MS) {
      return workspaceMemo.value;
    }
    const value = computeBridgeWorkspace(row);
    workspaceMemo = { key, at: now, value };
    return value;
  }

  // Ids of the tools/call requests in the message; their results name the workspace read from.
  function toolCallIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.method === 'tools/call')
      .map((m) => m.id);
  }

  // Appends the note to a tools/call result (single or batch); anything else passes through.
  function annotate(obj, note) {
    if (note == null) return obj;
    if (Array.isArray(obj)) return obj.map((o) => annotate(o, note));
    if (obj == null || note.ids.indexOf(obj.id) === -1 || obj.result == null || !Array.isArray(obj.result.content)) return obj;
    return { ...obj, result: { ...obj.result, content: obj.result.content.concat([{ type: 'text', text: note.text }]) } };
  }

  // Every tools/list result, upstream or synthetic, drops the hidden tools and also lists the local status tool.
  function withLocalTools(obj) {
    if (Array.isArray(obj)) return obj.map(withLocalTools);
    if (obj == null || obj.result == null || !Array.isArray(obj.result.tools)) return obj;
    const tools = obj.result.tools.filter((t) => t == null || HIDDEN_TOOLS.indexOf(t.name) === -1);
    if (tools.some((t) => t != null && t.name === STATUS_TOOL.name)) return { ...obj, result: { ...obj.result, tools } };
    return { ...obj, result: { ...obj.result, tools: tools.concat([STATUS_TOOL]) } };
  }

  // Swaps the plugin's own text into the forwarded initialize result whose id is `initId`.
  function withLocalInstructions(obj, initId) {
    if (initId === undefined || obj == null || Array.isArray(obj) || obj.id !== initId) return obj;
    if (obj.result == null || typeof obj.result.instructions !== 'string') return obj;
    return { ...obj, result: { ...obj.result, instructions: SERVER_INSTRUCTIONS } };
  }

  const callName = (m) => (m != null && m.method === 'tools/call' && m.params != null ? m.params.name : null);

  // Ids of the requests in the message (single or legacy batch); responses and
  // notifications carry none and get no synthesized error.
  function requestIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.method !== undefined)
      .map((m) => m.id);
  }

  function writeMessage(obj) {
    write(JSON.stringify(obj));
  }

  function errorResponse(id, message) {
    writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  // One deadline per exchange, covering the response body as well as the headers. Clearing it
  // once the headers land — which is where the timeout used to end — leaves the stream read
  // unguarded, and a socket the OS left half-open across a laptop sleep delivers headers and
  // then nothing at all: no data, no close. That read never returns, so the request it belongs
  // to never answers and, because `reinit` memoizes the promise, neither does anything queued
  // behind it. `touch()` restarts the clock on every chunk, so progress buys more time.
  function createDeadline(ms) {
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

  async function post(msg, token, deadline) {
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),

      },
      body: JSON.stringify(msg),
      signal: deadline.signal,
    });
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so
  // each lands as one line. `silent` drains instead — used for the transparent
  // re-initialize, whose response the client must not see twice. `note` annotates tools/call results.
  async function emit(res, { silent = false, deadline, note = null, initId } = {}) {
    const newSession = res.headers.get(SESSION_HEADER);
    if (newSession) sessionId = newSession;
    if (res.status === 202 || res.status === 204) return;
    const contentType = res.headers.get('content-type');
    if ((contentType == null ? '' : contentType).includes('text/event-stream')) {
      for await (const data of sseEvents(res.body, deadline == null ? undefined : deadline.touch)) {
        if (!silent) writeMessage(withLocalInstructions(withLocalTools(annotate(JSON.parse(data), note)), initId));
      }
      return;
    }
    const text = await res.text();
    if (text && !silent) writeMessage(withLocalInstructions(withLocalTools(annotate(JSON.parse(text), note)), initId));
  }

  // The portal's MCP sessions are in-memory; an API restart between turns loses
  // them (HTTP 404). Rebuild one transparently — replay initialize (response
  // hidden) and the initialized notification — so the client never notices.
  function reinitialize(token) {
    if (reinit == null) {
      reinit = (async () => {
        const deadline = createDeadline(handshakeMs);
        try {
          sessionId = null;
          const res = await post(initializeMsg, token, deadline);
          if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
          await emit(res, { silent: true, deadline });
          const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, deadline);
          await emit(ack, { deadline });
          realInitDone = true;
          stopWatcher();
        } finally {
          deadline.stop();
        }
      })().finally(() => {
        reinit = null;
      });
    }
    return reinit;
  }

  function stopWatcher() {
    if (watcher) {
      clearIntervalImpl(watcher);
      watcher = null;
    }
  }

  function startWatcher() {
    if (watcher) return;
    watcher = setIntervalImpl(async () => {
      requestQueue = requestQueue.then(async () => {
      const account = await getDefaultKey();
      const accessToken = await getToken({}, { account }).catch(() => null);
      if (!accessToken) return;
      const row = account ? await getAccount(account) : null;
      const tenantId = resolveBridgeWorkspace(row).tenantId;
      selectScope(account, tenantId);
      const token = { key: account, token: accessToken, clientId: (row && row.clientId), tenantId };
      try {
        await reinitialize(token);
        // The client accepted an empty tool list during the synthetic handshake; this makes
        // it re-fetch, so the Beezi tools appear the moment the login lands.
        toolsChanged = false;
        writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      } catch { /* portal unreachable — keep watching */ }
      }).catch(() => {});
      return requestQueue;
    }, watchIntervalMs);
    if (watcher != null && typeof watcher.unref === 'function') watcher.unref();
  }

  // An unlinked machine still gets a healthy server: the handshake succeeds locally, the tool
  // list is empty, and only actual calls explain what to do. Erroring initialize instead
  // strands the very login flow that fixes the link.
  // Answers the handshake locally, with an empty tool list, and leaves the watcher to replay the
  // real one. Shared by the unlinked machine and by a handshake the portal could not serve.
  function synthesizeHandshake(msg, instructions) {
    writeMessage({
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
    startWatcher();
  }

  function handleUnlinked(msg, ids, authState) {
    if (isInitialize(msg)) {
      synthesizeHandshake(msg, authState === AUTH_STATES.UNLINKED
        ? `Beezi tools activate after /beezi-staging-login links this machine.${RESTART_HINT}`
        : unavailableMessage(authState));
      return;
    }
    if (!Array.isArray(msg) && msg.method === 'tools/list' && msg.id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: [STATUS_TOOL] } });
      return;
    }
    ids.forEach((id) => errorResponse(id, unavailableMessage(authState)));
  }

  function unavailableMessage(authState) {
    if (authState === AUTH_STATES.REAUTH_REQUIRED) return REAUTH_MESSAGE;
    if (authState === AUTH_STATES.REFRESHING || authState === AUTH_STATES.UNAVAILABLE) return RETRY_MESSAGE;
    return NOT_LINKED_MESSAGE;
  }

  async function serverErrorMessage(res) {
    try {
      const body = await res.json();
      // JSON-RPC errors nest under `error`; the portal's HTTP errors put the sentence at the
      // top level with `error` holding only the status name ("Forbidden"). Read both, so a
      // plan or permission refusal reaches the user in the server's own words.
      const err = body == null ? undefined : body.error;
      const errMessage = err == null ? undefined : err.message;
      const message = errMessage == null
        ? (body != null && typeof body.message === 'string' ? body.message : null)
        : errMessage;
      if (message) return `Beezi MCP error: ${message}`;
    } catch {
      /* non-JSON body */
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
  }

  // The portal keys the MCP session by account and by the X-Beezi-Tenant header, so either change starts a new one.
  function selectScope(account, tenantId) {
    if (sessionAccount !== account || sessionTenant !== tenantId) {
      if (sessionTenant !== undefined && sessionTenant !== tenantId) toolsChanged = true;
      sessionAccount = account;
      sessionTenant = tenantId;
      sessionId = null;
      realInitDone = false;
      reinit = null;
    }
  }

  function handleMessage(msg) {
    const pending = requestQueue.then(() => handleMessageNow(msg));
    requestQueue = pending.catch(() => {});
    return pending;
  }

  // Answers beezi_status here: the report is built in this process, which holds the stored login.
  async function runStatusTool(id) {
    try {
      const { buildStatusReport } = await import('./status-report.mjs');
      const lines = await buildStatusReport({ budgetMs: 8000 });
      writeMessage({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: lines.join('\n') }] } });
    } catch {
      writeMessage({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Beezi could not build the status report.' }] } });
    }
  }

  // Answers calls to the hidden tools locally, never forwarded; returns what is left to forward, or null.
  function refuseHidden(msg) {
    const list = Array.isArray(msg) ? msg : [msg];
    const hidden = list.filter((m) => HIDDEN_TOOLS.indexOf(callName(m)) !== -1);
    if (hidden.length === 0) return msg;
    hidden.filter((m) => m.id !== undefined)
      .forEach((m) => writeMessage({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: HIDDEN_TOOL_MESSAGE }] } }));
    const rest = list.filter((m) => hidden.indexOf(m) === -1);
    if (rest.length === 0) return null;
    return Array.isArray(msg) ? rest : rest[0];
  }

  async function handleMessageNow(original) {
    const msg = refuseHidden(original);
    if (msg == null) return;
    if (!Array.isArray(msg) && msg.id !== undefined && callName(msg) === STATUS_TOOL.name) {
      await runStatusTool(msg.id);
      return;
    }
    const ids = requestIds(msg);
    if (isInitialize(msg)) {
      initializeMsg = msg;
      sessionId = null;
      toolsChanged = false;
    }
    let account, row, scope;
    try {
      account = await getDefaultKey();
      row = account ? await getAccount(account) : null;
      scope = resolveBridgeWorkspace(row, toolCallIds(msg).length > 0);
      selectScope(account, scope.tenantId);
    } catch (_) {
      handleUnlinked(msg, ids, AUTH_STATES.UNAVAILABLE);
      return;
    }
    const auth = await Promise.resolve()
      .then(() => getAuthentication({}, { account }))
      .catch(() => ({ authState: AUTH_STATES.UNAVAILABLE, accessToken: null }));
    let token = auth.authState === AUTH_STATES.READY
      ? { key: account, token: auth.accessToken, clientId: auth.clientId || (row && row.clientId), tenantId: scope.tenantId }
      : null;
    if (!token) {
      // The bridge cannot start with real tools. Recorded with the reason the accessor gave, and
      // delivered without a token — this is exactly the failure a token could not report.
      if (isInitialize(msg)) {
        recordMcpStartupFailure(null, auth.reason);
        try { maybeSpawnDiagnostics(); } catch { /* never */ }
      }
      handleUnlinked(msg, ids, auth.authState);
      return;
    }
    // Linked after a synthetic handshake: the portal has never seen initialize, so replay it
    // before forwarding anything else — the same rebuild the 404 path uses.
    if (!realInitDone && !isInitialize(msg) && initializeMsg) {
      try {
        await reinitialize(token);
      } catch {
        ids.forEach((id) => errorResponse(id, 'Beezi MCP request failed: the Beezi server is unreachable.'));
        return;
      }
      if (toolsChanged) {
        toolsChanged = false;
        writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      }
    }
    const deadline = createDeadline(isInitialize(msg) ? handshakeMs : timeoutMs);
    const callIds = scope.tenantId == null ? [] : toolCallIds(msg);
    const note = callIds.length === 0 ? null : { ids: callIds, text: `Beezi: reading from ${scope.name}.` };
    try {
      let res = await post(msg, token, deadline);
      if (res.status === 404 && initializeMsg && !isInitialize(msg)) {
        await reinitialize(token);
        res = await post(msg, token, deadline);
      }
      // A 401 is the server telling us the token is dead — better evidence than the expires_at
      // we estimated locally, which is a pure guess when the token response omits expires_in.
      // Renew once on its word and retry, so a short-lived token doesn't strand the whole
      // MCP server until the user re-links by hand.
      if (res.status === 401) {
        const refreshed = await getToken({}, { account, forceRefresh: true }).catch(() => null);
        if (refreshed && refreshed !== token.token) {
          token = { ...token, token: refreshed };
          res = await post(msg, token, deadline);
        }
      }
      if (res.ok) {
        if (isInitialize(msg)) {
          realInitDone = true;
          stopWatcher();
        }
        await emit(res, { deadline, note, initId: isInitialize(msg) ? msg.id : undefined });
        return;
      }
      if (res.status === 401) {
        ids.forEach((id) => errorResponse(id, REJECTED_MESSAGE));
        return;
      }
      // 403 is authenticated-but-not-permitted: the account lacks access to this feature, and
      // no token can change that. Sending the user to /beezi-staging-login (as a shared 401/403 branch
      // did) is advice that cannot work, so report what the server actually said.
      if (res.status === 403) {
        const forbidden = await serverErrorMessage(res);
        ids.forEach((id) => errorResponse(id, forbidden));
        return;
      }
      const message = await serverErrorMessage(res);
      ids.forEach((id) => errorResponse(id, message));
    } catch (error) {
      // Only a thrown error lands here — a timeout or a dead socket, never the portal's own
      // answer (an HTTP status leaves the try block on its own path). Failing the handshake on
      // one of those strands the server for the rest of the session: the client marks it failed
      // and stdio servers are never retried. Answer it locally instead and let the watcher
      // replay the real handshake once the portal is reachable again.
      if (isInitialize(msg)) {
        recordIssue({ code: DIAGNOSTIC_CODES.MCP_HANDSHAKE_TIMEOUT, source: DIAGNOSTIC_SOURCES.MCP_BRIDGE, error });
        try { maybeSpawnDiagnostics(); } catch { /* never */ }
        synthesizeHandshake(msg, 'Beezi tools activate once the Beezi server is reachable.');
        return;
      }
      // Idle-deadline aborts are routine after a laptop sleep — benign-fallback noise, not a
      // defect, so this does not record it (unlike the handshake timeout above).
      ids.forEach((id) =>
        errorResponse(id, `Beezi MCP request failed: ${error == null || error.message == null ? String(error) : error.message}`),
      );
    } finally {
      deadline.stop();
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  return { handleLine, handleMessage };
}
