import { parseEventLine } from './event-types.mjs';
import { scanLines } from '../../platform/log-scan.mjs';

// A last line still being written: unterminated, not blank, and not JSON (or too long to decode).
function isTorn(text, info) {
  if (!info.last || info.endsWithNewline) return false;
  if (text == null) return true;
  if (text.trim() === '') return false;
  try { JSON.parse(text.replace(/\r$/, '')); } catch { return true; }
  return false;
}

export function readEvents(filePath, { fromLine = 0 } = {}) {
  const events = [];
  let partialTail = false;
  let scan;
  try {
    scan = scanLines(filePath, (text, lineNo, info) => {
      if (isTorn(text, info)) {
        partialTail = true;
        return;
      }
      if (lineNo <= fromLine) return;
      const event = parseEventLine(text, lineNo);
      if (event) events.push(event);
    }, { fromLine: Math.max(0, fromLine) });
  } catch {
    return { events: [], lastCompleteLine: 0, partialTail: false, unreadable: true };
  }
  return { events, lastCompleteLine: partialTail ? scan.lineCount - 1 : scan.lineCount, partialTail, unreadable: false };
}
