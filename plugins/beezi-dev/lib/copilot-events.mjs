import fs from 'fs';

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
});

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
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
    data,
  };
}

export function readEvents(filePath, { fromLine = 0 } = {}) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch {
    return { events: [], lastCompleteLine: 0, partialTail: false, unreadable: true };
  }
  // Captured before trimming: the trailing newline is the only torn-record signal.
  const endsWithNewline = /\n$/.test(content);
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');
  let lastCompleteLine = raw.length;
  let partialTail = false;
  if (!endsWithNewline && raw.length > 0 && raw[raw.length - 1].trim() !== '') {
    try { JSON.parse(raw[raw.length - 1].replace(/\r$/, '')); } catch {
      lastCompleteLine = raw.length - 1;
      partialTail = true;
    }
  }
  const events = [];
  for (let i = Math.max(0, fromLine); i < lastCompleteLine; i++) {
    const event = parseEventLine(raw[i], i + 1);
    if (event) events.push(event);
  }
  return { events, lastCompleteLine, partialTail, unreadable: false };
}

export function findShutdowns(events) {
  return (Array.isArray(events) ? events : []).filter((e) => e.type === EVENT_TYPES.SESSION_SHUTDOWN);
}

export function sessionStartOf(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = 0; i < list.length; i++) if (list[i].type === EVENT_TYPES.SESSION_START) return list[i];
  return null;
}
