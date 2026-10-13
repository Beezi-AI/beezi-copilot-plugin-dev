// Pure JSON-RPC transforms of the bridge: hidden tools, the local status tool, the plugin's instructions and request ids.
import { HIDDEN_TOOL_MESSAGE } from './messages.mjs';

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
// Replaces the server's initialize instructions, which still describe the hidden ticket tools.
export const SERVER_INSTRUCTIONS =
  'Beezi analytics tools: get_local_flow_summary, query_local_flow_metric, get_local_flow_session, list_local_flow_scopes, '
  + 'get_analytics_instructions and get_my_usage_summary. Call get_analytics_instructions before producing a personal '
  + 'analytics summary. Follow structured status and nextAction values returned by tools.';

export const isInitialize = (msg) => !Array.isArray(msg) && msg.method === 'initialize';

// The client's single `notifications/initialized`, which a replayed handshake sends upstream itself.
export const isInitializedNotice = (msg) => !Array.isArray(msg) && msg.method === 'notifications/initialized' && msg.id === undefined;

export const callName = (m) => (m != null && m.method === 'tools/call' && m.params != null ? m.params.name : null);

const isStatusRequest = (m) => m != null && m.id !== undefined && callName(m) === STATUS_TOOL.name;

// Splits the messages `take` matches off a single or batch message: `rest` keeps the message shape, or is null when empty.
function splitOff(msg, take) {
  const list = Array.isArray(msg) ? msg : [msg];
  const taken = list.filter(take);
  if (taken.length === 0) return { taken, rest: msg };
  const rest = list.filter((m) => taken.indexOf(m) === -1);
  if (rest.length === 0) return { taken, rest: null };
  return { taken, rest: Array.isArray(msg) ? rest : rest[0] };
}

// Splits the local status tool's requests off the message, single or inside a batch: their ids, and what is left to forward.
export function splitStatusCalls(msg) {
  const { taken, rest } = splitOff(msg, isStatusRequest);
  return { statusIds: taken.map((m) => m.id), rest };
}

// Ids of the responses in a message the bridge writes (single or batch): a response carries an id and no method.
export function responseIds(obj) {
  return (Array.isArray(obj) ? obj : [obj])
    .filter((m) => m != null && m.id !== undefined && m.method === undefined)
    .map((m) => m.id);
}

// Ids of the tools/call requests in the message; their results name the workspace read from.
export function toolCallIds(msg) {
  return (Array.isArray(msg) ? msg : [msg])
    .filter((m) => m && m.id !== undefined && m.method === 'tools/call')
    .map((m) => m.id);
}

// Ids of the requests in the message (single or legacy batch); responses and
// notifications carry none and get no synthesized error.
export function requestIds(msg) {
  return (Array.isArray(msg) ? msg : [msg])
    .filter((m) => m && m.id !== undefined && m.method !== undefined)
    .map((m) => m.id);
}

// Appends the note to a tools/call result (single or batch); anything else passes through.
export function annotate(obj, note) {
  if (note == null) return obj;
  if (Array.isArray(obj)) return obj.map((o) => annotate(o, note));
  if (obj == null || note.ids.indexOf(obj.id) === -1 || obj.result == null || !Array.isArray(obj.result.content)) return obj;
  return { ...obj, result: { ...obj.result, content: obj.result.content.concat([{ type: 'text', text: note.text }]) } };
}

// Every tools/list result, upstream or synthetic, drops the hidden tools and also lists the local status tool.
export function withLocalTools(obj) {
  if (Array.isArray(obj)) return obj.map(withLocalTools);
  if (obj == null || obj.result == null || !Array.isArray(obj.result.tools)) return obj;
  const tools = obj.result.tools.filter((t) => t == null || HIDDEN_TOOLS.indexOf(t.name) === -1);
  if (tools.some((t) => t != null && t.name === STATUS_TOOL.name)) return { ...obj, result: { ...obj.result, tools } };
  return { ...obj, result: { ...obj.result, tools: tools.concat([STATUS_TOOL]) } };
}

// Swaps the plugin's own text into the forwarded initialize result whose id is `initId`.
export function withLocalInstructions(obj, initId) {
  if (initId === undefined || obj == null || Array.isArray(obj) || obj.id !== initId) return obj;
  if (obj.result == null || typeof obj.result.instructions !== 'string') return obj;
  return { ...obj, result: { ...obj.result, instructions: SERVER_INSTRUCTIONS } };
}

// Splits calls to the hidden tools off the message: `replies` answer them (requests only), `rest` is what is left to forward, or null.
export function refuseHidden(msg) {
  const { taken, rest } = splitOff(msg, (m) => HIDDEN_TOOLS.indexOf(callName(m)) !== -1);
  const replies = taken.filter((m) => m.id !== undefined)
    .map((m) => ({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: HIDDEN_TOOL_MESSAGE }] } }));
  return { replies, rest };
}
