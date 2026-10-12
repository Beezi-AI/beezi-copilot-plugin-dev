// One persisted VS Code chat request's signals (tools, MCP, skills, failures, edits, BYOK, error) as counts, names and extensions only.
import path from 'path';
import { emptyOperations, keyOf } from './collectors/operations.mjs';
import { classifyError } from './collectors/errors.mjs';
import { redactText } from '../core/redact.mjs';
import { isPlain, str } from '../core/guards.mjs';

const TOOL_PART = 'toolInvocationSerialized';
const EDIT_PART = 'textEditGroup';
const COPILOT_VENDOR = 'copilot';
const TOOL_KEY_MAX = 100;
const ERROR_TEXT_MAX = 1000;
const UNKNOWN_PLUGIN = 'unknown';
const BUILTIN_PLUGIN = 'builtin';

// Copilot Chat's built-in tool ids per report category; any other internal or extension tool (runSubagent included) is 'other'.
const CATEGORY_BY_TOOL = Object.freeze({
  copilot_readFile: 'file', copilot_createFile: 'file', copilot_replaceString: 'file', copilot_multiReplaceString: 'file',
  copilot_insertEdit: 'file', copilot_applyPatch: 'file',
  copilot_findFiles: 'search', copilot_findTextInFiles: 'search', copilot_searchCodebase: 'search', copilot_listDirectory: 'search',
  tool_search: 'search',
  run_in_terminal: 'shell', get_terminal_output: 'shell',
  copilot_fetchWebPage: 'internet',
});

// The portal's failure classes this reader can tell apart; collectors/tool-failures.mjs holds the whole vocabulary.
const FAILURE = Object.freeze({ PERMISSION_DENIED: 'permission_denied', EXIT_NONZERO: 'exit_nonzero', OTHER: 'other' });
// VS Code's ToolConfirmKind.Denied; a legacy boolean false means the same.
const CONFIRM_DENIED = 0;

// A skill read is copilot_readFile of `<…>/skills/<name>/SKILL.md?vscodeLinkType=skill` (the query may be percent-encoded).
const SKILL_URI = /\/skills\/([^/?#]+)\/SKILL\.md\?[^#]*vscodeLinkType(?:=|%3D)skill/i;
// An installed plugin's skill sits at `<…>/installed-plugins|agent-plugins/…/<plugin>/skills/<name>/SKILL.md`.
const PLUGIN_SKILL_URI = /\/(?:installed-plugins|agent-plugins)\/(?:[^/?#]+\/)*?([^/?#]+)\/skills\/[^/?#]+\/SKILL\.md/i;

function partsOf(raw, kind) {
  return Array.isArray(raw.response) ? raw.response.filter((p) => isPlain(p) && p.kind === kind) : [];
}

function decoded(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// { name, plugin } of a skill read, else null; the URIs are the keys of the call's invocationMessage.uris.
function skillOf(call) {
  const message = isPlain(call.invocationMessage) ? call.invocationMessage : {};
  const uris = isPlain(message.uris) ? Object.keys(message.uris) : [];
  for (const uri of uris) {
    const m = SKILL_URI.exec(uri);
    if (m == null) continue;
    const owner = PLUGIN_SKILL_URI.exec(uri);
    return { name: decoded(m[1]), plugin: owner == null ? BUILTIN_PLUGIN : decoded(owner[1]) };
  }
  return null;
}

function sourceOf(call) {
  return isPlain(call.source) ? call.source : {};
}

function categoryOf(call) {
  if (sourceOf(call).type === 'mcp') return 'mcp';
  const id = call.toolId;
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_BY_TOOL, id) ? CATEGORY_BY_TOOL[id] : 'other';
}

function tally(map, key) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = { count: 0, est_tokens: 0 };
  map[key].count += 1;
}

function exitCodeOf(call) {
  const data = isPlain(call.toolSpecificData) ? call.toolSpecificData : {};
  const state = data.kind === 'terminal' && isPlain(data.terminalCommandState) ? data.terminalCommandState : {};
  return typeof state.exitCode === 'number' && isFinite(state.exitCode) ? state.exitCode : null;
}

// The call's failure class, or null when it succeeded: a denial, then a tool error, then a non-zero terminal exit.
function failureOf(call) {
  const confirmed = call.isConfirmed;
  if (confirmed === false || (isPlain(confirmed) && confirmed.type === CONFIRM_DENIED)) return FAILURE.PERMISSION_DENIED;
  if (call.resultError != null && call.resultError !== false && call.resultError !== '') return FAILURE.OTHER;
  const exit = exitCodeOf(call);
  return exit != null && exit !== 0 ? FAILURE.EXIT_NONZERO : null;
}

function addCall(failures, call) {
  const tool = keyOf(call.toolId).slice(0, TOOL_KEY_MAX);
  if (!Object.prototype.hasOwnProperty.call(failures.by_tool, tool)) failures.by_tool[tool] = { calls: 0, count: 0 };
  const entry = failures.by_tool[tool];
  entry.calls += 1;
  const cls = failureOf(call);
  if (cls == null) return;
  entry.count += 1;
  if (entry.by_class == null) entry.by_class = {};
  entry.by_class[cls] = (entry.by_class[cls] || 0) + 1;
  failures.count += 1;
}

// The CLI's operations shape (with failures) for one request; result sizes are not persisted, so est_tokens stays 0.
export function requestOperations(raw) {
  const ops = emptyOperations();
  const failures = { count: 0, by_tool: {} };
  for (const call of partsOf(raw, TOOL_PART)) {
    const skill = skillOf(call);
    const category = skill != null ? 'skill' : categoryOf(call);
    ops[category].count += 1;
    if (skill != null) {
      tally(ops.skill.by_skill, keyOf(skill.name));
      tally(ops.plugins, keyOf(skill.plugin));
    } else if (category === 'mcp') {
      const source = sourceOf(call);
      tally(ops.mcp.by_server, keyOf(str(source.serverLabel) || str(source.label)));
      tally(ops.plugins, UNKNOWN_PLUGIN);
    }
    addCall(failures, call);
  }
  ops.failures = failures;
  return ops;
}

function lineBreaks(text) {
  return text.split('\n').length - 1;
}

// Git-style lines per edit: a line-start to line-start range swapping whole lines touches only those, any other its end lines too.
function editLines(edit) {
  const range = isPlain(edit.range) ? edit.range : {};
  const text = typeof edit.text === 'string' ? edit.text : '';
  const span = Math.max(0, (range.endLineNumber | 0) - (range.startLineNumber | 0));
  const wholeLines = range.startColumn === 1 && range.endColumn === 1 && (text === '' || text.charAt(text.length - 1) === '\n');
  return wholeLines ? { removed: span, added: lineBreaks(text) } : { removed: span + 1, added: lineBreaks(text) + 1 };
}

function uriPathOf(uri) {
  return isPlain(uri) ? str(uri.path) : null;
}

// The CLI's code_changes shape from the request's applied edit groups (one entry per file, lines from the edit ranges).
export function requestCodeChanges(raw) {
  const files = new Map();
  let added = 0;
  let removed = 0;
  for (const group of partsOf(raw, EDIT_PART)) {
    const file = uriPathOf(group.uri);
    if (file == null) continue;
    files.set(file.toLowerCase(), file);
    for (const batch of Array.isArray(group.edits) ? group.edits : []) {
      for (const edit of Array.isArray(batch) ? batch : []) {
        if (!isPlain(edit)) continue;
        const lines = editLines(edit);
        added += lines.added;
        removed += lines.removed;
      }
    }
  }
  const byExtension = {};
  for (const file of files.values()) {
    const ext = path.posix.extname(file).toLowerCase() || '(none)';
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }
  return { files_changed: files.size, lines_added: added, lines_removed: removed, by_extension: byExtension };
}

// True when the request ran on a bring-your-own-key model: its "<vendor>/<id>" model id names a vendor other than Copilot.
export function isByokRequest(raw) {
  const id = str(raw.modelId);
  const slash = id == null ? -1 : id.indexOf('/');
  return slash > 0 && id.slice(0, slash).toLowerCase() !== COPILOT_VENDOR;
}

// A /sessions/errors row for a quota, rate-limit, billing or auth failure; null for a cancel, an expected or an unclassified error.
export function requestError(raw, occurredAtMs) {
  const result = isPlain(raw.result) ? raw.result : {};
  const details = isPlain(result.errorDetails) ? result.errorDetails : null;
  if (details == null || details.isExpectedError === true) return null;
  const message = str(details.message);
  const flag = details.isQuotaExceeded === true ? 'quota_exceeded' : (details.isRateLimited === true ? 'rate_limited' : null);
  const error = flag != null ? 'rate_limit' : classifyError(null, null, null, message);
  if (error === 'unknown') return null;
  return {
    error,
    errorDetails: flag,
    lastAssistantMessage: message == null ? null : redactText(message).slice(0, ERROR_TEXT_MAX),
    occurredAt: typeof occurredAtMs === 'number' && isFinite(occurredAtMs) ? new Date(occurredAtMs).toISOString() : null,
  };
}
