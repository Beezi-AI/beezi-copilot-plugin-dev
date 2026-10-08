import { EVENT_TYPES } from './copilot-events.mjs';
import { canonicalToolName, dataOf, inSegment, keyOf } from './operations.mjs';

const MAX_TOOL_KEY = 100;
// The class vocabulary is a contract with the portal's report whitelist.
const TOOL_FAILURE_CLASSES = Object.freeze({
  INTERRUPTED: 'interrupted',
  PERMISSION_DENIED: 'permission_denied',
  TIMEOUT: 'timeout',
  PRECONDITION: 'precondition',
  EXIT_NONZERO: 'exit_nonzero',
  OTHER: 'other',
});
const DENIED_KIND_PREFIX = 'denied';

// Tool name for a denied request that never started a tool call.
const KIND_TOOL = { shell: 'Bash', write: 'Edit', read: 'Read', url: 'WebFetch' };

function toolKey(name) {
  return keyOf(canonicalToolName(name)).slice(0, MAX_TOOL_KEY);
}

function textOf(complete) {
  const d = dataOf(complete);
  const err = d.error != null && typeof d.error === 'object' ? d.error : {};
  return `${typeof err.code === 'string' ? err.code : ''} ${typeof err.message === 'string' ? err.message : ''}`.toLowerCase();
}

function shellFailed(complete) {
  const sh = dataOf(complete).shellExecution;
  const code = sh != null && typeof sh === 'object' ? sh.exitCode : null;
  return typeof code === 'number' && isFinite(code) && code !== 0;
}

// One completed call to a class, or null when it succeeded. The message patterns are heuristics (V-47 open).
function classOf(complete) {
  const success = dataOf(complete).success;
  // Copilot's own success:true wins over a non-zero exit (grep/diff/test "no match").
  if (success === true || (success !== false && !shellFailed(complete))) return null;
  const text = textOf(complete);
  if (/\be?timed? ?out/.test(text)) return TOOL_FAILURE_CLASSES.TIMEOUT;
  // Copilot's approval-denial texts; plain OS EACCES/EPERM errors fall through to precondition below.
  if (/denied by (the )?(user|rules|hook|permission|content|pretooluse|sandbox)|denied by a deny rule|denied due to the following rules|denied while resolving pretooluse|user rejected this tool call|could not request permission|permission denied (by|and could not)/.test(text)) return TOOL_FAILURE_CLASSES.PERMISSION_DENIED;
  if (/cancel|abort|interrupt/.test(text)) return TOOL_FAILURE_CLASSES.INTERRUPTED;
  if (shellFailed(complete)) return TOOL_FAILURE_CLASSES.EXIT_NONZERO;
  if (/no such file|not found|does not exist|enoent|out of bounds|not a directory|\beacces\b|\beperm\b|operation not permitted|permission denied(,| \(os error)/.test(text)) return TOOL_FAILURE_CLASSES.PRECONDITION;
  return TOOL_FAILURE_CLASSES.OTHER;
}

function isDenial(e) {
  const result = dataOf(e).result;
  return result != null && typeof result === 'object' && typeof result.kind === 'string' && result.kind.indexOf(DENIED_KIND_PREFIX) === 0;
}

function toolOfRequest(request) {
  const r = request != null && typeof request === 'object' ? request : {};
  if (typeof r.toolName === 'string' && r.toolName !== '') return toolKey(r.toolName);
  return Object.prototype.hasOwnProperty.call(KIND_TOOL, r.kind) ? KIND_TOOL[r.kind] : keyOf(r.kind).slice(0, MAX_TOOL_KEY);
}

function entryOf(byTool, tool) {
  if (!Object.prototype.hasOwnProperty.call(byTool, tool)) byTool[tool] = { calls: 0, count: 0 };
  return byTool[tool];
}

function addFailure(entry, cls) {
  entry.count += 1;
  if (entry.by_class == null) entry.by_class = {};
  entry.by_class[cls] = (entry.by_class[cls] || 0) + 1;
}

// The whole-file indexes, built once per run: starts and denials may land in another window than their completion.
export function buildToolIndex(allEvents) {
  const all = Array.isArray(allEvents) ? allEvents : [];
  const requestById = new Map();
  const startedCalls = new Map();
  for (const e of all) {
    const d = dataOf(e);
    if (e.type === EVENT_TYPES.PERMISSION_REQUESTED && typeof d.requestId === 'string') requestById.set(d.requestId, d.permissionRequest);
    else if (e.type === EVENT_TYPES.TOOL_START && typeof d.toolCallId === 'string') startedCalls.set(d.toolCallId, d);
  }
  const denialCallId = (e) => {
    const d = dataOf(e);
    if (typeof d.toolCallId === 'string' && d.toolCallId !== '') return d.toolCallId;
    const req = requestById.get(d.requestId);
    return req != null && typeof req.toolCallId === 'string' ? req.toolCallId : null;
  };
  const deniedCalls = new Set();
  for (const e of all) {
    if (e.type !== EVENT_TYPES.PERMISSION_COMPLETED || !isDenial(e)) continue;
    const id = denialCallId(e);
    if (id != null) deniedCalls.add(id);
  }
  return { requestById, startedCalls, deniedCalls, denialCallId };
}

// Calls and failures are both counted in the window where the call completes, so count never exceeds calls.
export function collectToolFailures(events, segment, ctx) {
  const all = ctx != null && Array.isArray(ctx.allEvents) ? ctx.allEvents : (Array.isArray(events) ? events : []);
  const seg = (Array.isArray(events) ? events : []).filter((e) => inSegment(e, segment));
  const index = ctx != null && ctx.toolIndex != null ? ctx.toolIndex : buildToolIndex(all);
  const { requestById, startedCalls, deniedCalls, denialCallId } = index;

  const byTool = {};
  let count = 0;
  for (const e of seg) {
    if (e.type !== EVENT_TYPES.TOOL_COMPLETE) continue;
    const d = dataOf(e);
    // A denied call is counted once, by the denial loop below; a call the user ran themselves is not the agent's.
    if (typeof d.toolCallId !== 'string' || deniedCalls.has(d.toolCallId) || d.isUserRequested === true) continue;
    const start = startedCalls.get(d.toolCallId);
    if (start == null) continue;
    const entry = entryOf(byTool, toolKey(start.toolName));
    entry.calls += 1;
    const cls = classOf(e);
    if (cls == null) continue;
    addFailure(entry, cls);
    count += 1;
  }
  // A denial is one attempted call and one failure, in the window where the denial lands.
  for (const e of seg) {
    if (e.type !== EVENT_TYPES.PERMISSION_COMPLETED || !isDenial(e)) continue;
    const id = denialCallId(e);
    // Without a call id the denied completion cannot be skipped in loop 1, so counting it here would double it.
    if (id == null) continue;
    const start = startedCalls.get(id);
    const entry = entryOf(byTool, start != null ? toolKey(start.toolName) : toolOfRequest(requestById.get(dataOf(e).requestId)));
    entry.calls += 1;
    addFailure(entry, TOOL_FAILURE_CLASSES.PERMISSION_DENIED);
    count += 1;
  }
  return { failures: { count, by_tool: byTool } };
}
