import fs from 'fs';
import { parseEventLine } from './event-types.mjs';

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
