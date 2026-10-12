// Owns the apply_patch envelope: where it sits in a call's arguments, its file headers and its +/- body lines.
import { parseArgs } from './operations.mjs';

const BEGIN = '*** Begin Patch';
const FILE_HEADER_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

function envelope(t) {
  return typeof t === 'string' && t.indexOf(BEGIN) !== -1 ? t : null;
}

// The envelope text: the arguments' input or patch field, else the bare argument string. JSON arguments are decoded first,
// since a patch inside a JSON string keeps its newlines escaped.
export function patchText(raw) {
  const a = parseArgs(raw);
  if (a == null) return envelope(raw);
  return envelope(typeof a.input === 'string' && a.input !== '' ? a.input : a.patch);
}

// → { files (header order, moves included), added, removed }; headers, markers and context lines are not counted.
export function readPatch(text) {
  const out = { files: [], added: 0, removed: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = FILE_HEADER_RE.exec(line) || MOVE_RE.exec(line);
    if (header) { out.files.push(header[1].trim()); continue; }
    if (line.indexOf('*** ') === 0 || line.indexOf('@@') === 0) continue;
    if (line.charAt(0) === '+') out.added += 1;
    else if (line.charAt(0) === '-') out.removed += 1;
  }
  return out;
}
