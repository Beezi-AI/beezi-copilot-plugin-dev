// Buckets each Copilot tool call in a segment into seven categories and estimates its result size (result bytes / 4).
import { EVENT_TYPES, bytesOf, dataOf, isSkillInvocation } from '../../sources/cli/event-types.mjs';

// Claude tool name per Copilot runtime name (hooks reference, PascalCase table) plus shell-session tools.
const CLAUDE_NAME = {
  bash: 'Bash', powershell: 'Bash', PowerShell: 'Bash',
  list_bash: 'Bash', read_bash: 'Bash', write_bash: 'Bash', stop_bash: 'Bash',
  list_powershell: 'Bash', read_powershell: 'Bash', write_powershell: 'Bash', stop_powershell: 'Bash',
  view: 'Read', create: 'Write', edit: 'Edit', str_replace_editor: 'Edit', apply_patch: 'Edit',
  grep: 'Grep', rg: 'Grep', glob: 'Glob',
  web_fetch: 'WebFetch', web_search: 'WebSearch',
  ask_user: 'AskUserQuestion', update_todo: 'TodoWrite',
  task: 'Task', Agent: 'Task', skill: 'Skill',
  exit_plan_mode: 'ExitPlanMode',
};

const FILE_TOOLS = { Read: true, Write: true, Edit: true, MultiEdit: true, NotebookEdit: true };
const SEARCH_TOOLS = { Grep: true, Glob: true, ToolSearch: true };
const INTERNET_TOOLS = { WebFetch: true, WebSearch: true };
const SHELL_TOOLS = { Bash: true };
const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other'];

export function canonicalToolName(name) {
  if (typeof name !== 'string' || name === '') return null;
  return Object.prototype.hasOwnProperty.call(CLAUDE_NAME, name) ? CLAUDE_NAME[name] : name;
}

export function keyOf(value) {
  return typeof value === 'string' && value !== '' && value !== '__proto__' ? value : 'unknown';
}

export function tsMs(e) {
  const ms = e != null && typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function inSegment(e, segment) {
  if (e == null || segment == null) return false;
  if (!(e.line >= segment.fromLine && e.line <= segment.toLine)) return false;
  const a = e.agentId == null ? null : e.agentId;
  const b = segment.agentId == null ? null : segment.agentId;
  return a === b;
}

export function parseArgs(raw) {
  if (raw != null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    return v != null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function categoryOf(d) {
  if (typeof d.mcpServerName === 'string' && d.mcpServerName !== '') return 'mcp';
  const name = canonicalToolName(d.toolName);
  if (name == null) return 'other';
  if (name.indexOf('mcp__') === 0) return 'mcp';
  if (name === 'Skill') return 'skill';
  if (FILE_TOOLS[name] === true) return 'file';
  if (SEARCH_TOOLS[name] === true) return 'search';
  if (INTERNET_TOOLS[name] === true) return 'internet';
  if (SHELL_TOOLS[name] === true) return 'shell';
  return 'other';
}

function mcpServerOf(d) {
  if (typeof d.mcpServerName === 'string' && d.mcpServerName !== '') return keyOf(d.mcpServerName);
  if (typeof d.mcpConfigServerName === 'string' && d.mcpConfigServerName !== '') return keyOf(d.mcpConfigServerName);
  const rest = String(d.toolName).slice('mcp__'.length);
  const i = rest.indexOf('__');
  return keyOf(i === -1 ? rest : rest.slice(0, i));
}

// A plugin-contributed server's owner from the installed plugins' mcp.json map { serverKey: pluginName }.
function mcpPluginOf(d, pluginByServer) {
  if (d.mcpConfigSource === 'builtin') return 'builtin';
  const key = d.mcpConfigServerName;
  if (d.mcpConfigSource === 'plugin' && typeof key === 'string' && Object.prototype.hasOwnProperty.call(pluginByServer, key)) {
    return keyOf(pluginByServer[key]);
  }
  return 'unknown';
}

// Wall-clock ms from a call's start to its completion when both are stamped in order, else null.
function callDurationMs(start, complete) {
  const a = tsMs(start);
  const b = complete == null ? null : tsMs(complete);
  return a != null && b != null && b >= a ? b - a : null;
}

// MCP latency on its server entry: the total over the calls it was measured on, and how many those were.
function addLatency(entry, ms) {
  if (ms == null) return;
  entry.duration_ms = (entry.duration_ms == null ? 0 : entry.duration_ms) + ms;
  entry.duration_calls = (entry.duration_calls == null ? 0 : entry.duration_calls) + 1;
}

// 'superpowers:tdd' or 'superpowers/tdd' → 'superpowers'; a bare id is 'builtin'.
function skillPluginOf(skillId) {
  if (skillId === 'unknown') return 'unknown';
  const i = skillId.search(/[:/]/);
  return i <= 0 ? 'builtin' : keyOf(skillId.slice(0, i));
}

// What the model read back: the result's measured content (projectEventData), else the error text.
function resultBytes(complete) {
  if (complete == null) return 0;
  const d = dataOf(complete);
  const r = d.result != null && typeof d.result === 'object' ? d.result : null;
  if (r != null && typeof r.contentBytes === 'number') return r.contentBytes;
  if (d.error != null && typeof d.error.message === 'string') return bytesOf(d.error.message);
  return 0;
}

function tally(map, key, est) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = { count: 0, est_tokens: 0 };
  map[key].count += 1;
  map[key].est_tokens += est;
  return map[key];
}

// A first delivery carries the content; a repeat by reference (skill.invoked_ref) carries only its length.
function skillEstTokens(d) {
  if (d.content != null) return Math.round(bytesOf(d.content) / 4);
  return typeof d.contentLength === 'number' && isFinite(d.contentLength) && d.contentLength > 0 ? Math.round(d.contentLength / 4) : 0;
}

export function completionsById(events) {
  const map = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const d = dataOf(e);
    if (e.type === EVENT_TYPES.TOOL_COMPLETE && typeof d.toolCallId === 'string') map.set(d.toolCallId, e);
  }
  return map;
}

export function emptyOperations() {
  const totals = {};
  for (const cat of CATEGORIES) totals[cat] = { count: 0, est_tokens: 0 };
  totals.mcp.by_server = {};
  totals.skill.by_skill = {};
  totals.plugins = {};
  return totals;
}

// ctx.mcpPluginByServer: { serverKey: pluginName } from the installed plugins, else every plugin server is unknown.
export function collectOperations(events, segment, ctx) {
  const seg = (Array.isArray(events) ? events : []).filter((e) => inSegment(e, segment));
  const pluginByServer = ctx != null && ctx.mcpPluginByServer != null && typeof ctx.mcpPluginByServer === 'object' ? ctx.mcpPluginByServer : {};
  // ctx.completeById is the run-wide index; a bare call indexes the whole file itself.
  const completeById = ctx != null && ctx.completeById instanceof Map ? ctx.completeById : completionsById(ctx != null && Array.isArray(ctx.allEvents) ? ctx.allEvents : seg);
  const totals = emptyOperations();
  const plugins = totals.plugins;
  const skills = seg.filter(isSkillInvocation);

  for (const e of seg) {
    if (e.type !== EVENT_TYPES.TOOL_START) continue;
    const d = dataOf(e);
    const complete = completeById.get(d.toolCallId);
    if (complete != null && dataOf(complete).isUserRequested === true) continue;
    const category = categoryOf(d);
    // A runtime that records invocations (first or by reference) records every one, tool-made ones included.
    if (category === 'skill' && skills.length > 0) continue;
    const est = Math.round(resultBytes(complete) / 4);
    totals[category].count += 1;
    totals[category].est_tokens += est;
    if (category === 'mcp') {
      addLatency(tally(totals.mcp.by_server, mcpServerOf(d), est), callDurationMs(e, complete));
      tally(plugins, mcpPluginOf(d, pluginByServer), est);
    } else if (category === 'skill') {
      const args = parseArgs(d.arguments);
      const id = keyOf(args == null ? null : (typeof args.skill === 'string' ? args.skill : args.name));
      tally(totals.skill.by_skill, id, est);
      tally(plugins, skillPluginOf(id), est);
    }
  }

  for (const e of skills) {
    const d = dataOf(e);
    const est = skillEstTokens(d);
    totals.skill.count += 1;
    totals.skill.est_tokens += est;
    tally(totals.skill.by_skill, keyOf(d.name), est);
    tally(plugins, typeof d.pluginName === 'string' && d.pluginName !== '' ? keyOf(d.pluginName) : 'builtin', est);
  }

  return { operations: totals, plugins };
}
