// Owns the Copilot CLI events.jsonl vocabulary and the pure parsing and lookups over parsed events.
import { isPlain, str } from '../../core/guards.mjs';

export const EVENT_TYPES = Object.freeze({
  SESSION_START: 'session.start',
  SESSION_RESUME: 'session.resume',
  SESSION_SHUTDOWN: 'session.shutdown',
  CONTEXT_CHANGED: 'session.context_changed',
  MODEL_CHANGE: 'session.model_change',
  AUTO_MODE_RESOLVED: 'session.auto_mode_resolved',
  USAGE_CHECKPOINT: 'session.usage_checkpoint',
  COMPACTION_START: 'session.compaction_start',
  COMPACTION_COMPLETE: 'session.compaction_complete',
  TURN_START: 'assistant.turn_start',
  TURN_END: 'assistant.turn_end',
  ASSISTANT_MESSAGE: 'assistant.message',
  TOOL_START: 'tool.execution_start',
  TOOL_COMPLETE: 'tool.execution_complete',
  PERMISSION_REQUESTED: 'permission.requested',
  PERMISSION_COMPLETED: 'permission.completed',
  USER_MESSAGE: 'user.message',
  USAGE_INFO: 'session.usage_info',
  TRUNCATION: 'session.truncation',
  PERMISSIONS_CHANGED: 'session.permissions_changed',
  SKILL_INVOKED: 'skill.invoked',
  SKILL_INVOKED_REF: 'skill.invoked_ref',
  ABORT: 'abort',
});

// Events whose data.tokenLimit is the context-window capacity the session ran under.
const CONTEXT_LIMIT_TYPES = [
  EVENT_TYPES.USAGE_INFO, EVENT_TYPES.TRUNCATION, EVENT_TYPES.COMPACTION_START, EVENT_TYPES.COMPACTION_COMPLETE,
];

export function contextLimitOf(e) {
  if (e == null || CONTEXT_LIMIT_TYPES.indexOf(e.type) === -1) return null;
  const v = dataOf(e).tokenLimit;
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}

// A skill the runtime invoked (first delivery or a repeat by reference); a context load is not an invocation.
export function isSkillInvocation(e) {
  if (e == null || (e.type !== EVENT_TYPES.SKILL_INVOKED && e.type !== EVENT_TYPES.SKILL_INVOKED_REF)) return false;
  return dataOf(e).trigger !== 'context-load';
}

// Sources of user.message records the runtime injects rather than a person types.
const INJECTED_SOURCE = /^(skill-|agent-|system|hook|schedule|autopilot)/i;

export function dataOf(e) {
  return e != null && e.data != null && typeof e.data === 'object' ? e.data : {};
}

export function isHumanPrompt(e) {
  if (e == null || e.type !== 'user.message' || (e.agentId != null && e.agentId !== '')) return false;
  const d = dataOf(e);
  if (d.isAutopilotContinuation === true) return false;
  if (typeof d.source === 'string' && INJECTED_SOURCE.test(d.source)) return false;
  return typeof d.content === 'string' && d.content.trim() !== '';
}

const BINARY_ASSET = 'session.binary_asset';
// Payloads no consumer reads; every other field, and every other event type, passes through whole.
const DROPPED_DATA = new Map([
  [EVENT_TYPES.ASSISTANT_MESSAGE, ['content', 'reasoningText', 'reasoningOpaque', 'reasoningBlocks', 'encryptedContent', 'toolRequests']],
  [EVENT_TYPES.USER_MESSAGE, ['attachments', 'transformedContent']],
  [BINARY_ASSET, ['data']],
]);
const DROPPED_RESULT = ['binaryResultsForLlm', 'content', 'contents'];
const DIFF_HUNK = /^@@ /m;

export function bytesOf(v) {
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf-8');
  if (v == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(v), 'utf-8'); } catch { return 0; }
}

// What the model read back, in bytes: content when a string, else contents when an array; else null.
function readBackBytes(result) {
  if (typeof result.content === 'string') return bytesOf(result.content);
  return Array.isArray(result.contents) ? bytesOf(result.contents) : null;
}

function withoutKeys(obj, drop) {
  const slim = {};
  for (const key of Object.keys(obj)) if (!drop(key)) slim[key] = obj[key];
  return slim;
}

export function isDiff(v) {
  return typeof v === 'string' && DIFF_HUNK.test(v);
}

// detailedContent is kept only as a unified diff, the one shape code-changes reads it in; content becomes contentBytes.
function projectResult(result) {
  const slim = withoutKeys(result, (key) => DROPPED_RESULT.indexOf(key) !== -1 || (key === 'detailedContent' && !isDiff(result.detailedContent)));
  const bytes = readBackBytes(result);
  if (bytes != null) slim.contentBytes = bytes;
  return slim;
}

export function projectEventData(type, data) {
  if (type === EVENT_TYPES.TOOL_COMPLETE) {
    return isPlain(data.result) ? Object.assign({}, data, { result: projectResult(data.result) }) : data;
  }
  const dropped = DROPPED_DATA.get(type);
  return dropped == null ? data : withoutKeys(data, (key) => dropped.indexOf(key) !== -1);
}

// One physical line to an Event, or null for blank, malformed or non-record lines.
export function parseEventLine(text, line) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/\r$/, '');
  if (!body.trim()) return null;
  let rec;
  try { rec = JSON.parse(body); } catch { return null; }
  if (rec == null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (typeof rec.type !== 'string' || rec.type === '') return null;
  const data = rec.data != null && typeof rec.data === 'object' && !Array.isArray(rec.data) ? rec.data : {};
  return {
    line,
    type: rec.type,
    id: str(rec.id),
    parentId: str(rec.parentId),
    timestamp: str(rec.timestamp),
    agentId: str(rec.agentId),
    data: projectEventData(rec.type, data),
  };
}

export function findShutdowns(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e.type === EVENT_TYPES.SESSION_SHUTDOWN);
}

export function sessionStartOf(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = 0; i < list.length; i++) if (list[i].type === EVENT_TYPES.SESSION_START) return list[i];
  return null;
}
