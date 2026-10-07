import path from 'path';
import { canonicalToolName, completionsById, dataOf, inSegment, parseArgs } from './operations.mjs';

const EDIT_FAMILY = { Edit: true, Write: true, MultiEdit: true, NotebookEdit: true };
const FILE_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

function lineCount(s) {
  if (typeof s !== 'string' || s === '') return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

function extOf(p) {
  const ext = path.extname(p || '').toLowerCase();
  return ext || '(none)';
}

function fileKey(p) {
  return String(p).split('\\').join('/').toLowerCase();
}

function firstString(values) {
  for (const v of values) if (typeof v === 'string' && v !== '') return v;
  return null;
}

function touch(acc, filePath) {
  if (!filePath) return;
  const key = fileKey(filePath);
  if (!acc.files.has(key)) acc.files.set(key, filePath);
}

// apply_patch envelope: *** Update/Add/Delete File headers, '+'/'-' body lines, ' ' context.
function parsePatch(patch, acc) {
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = FILE_HEADER_RE.exec(line);
    if (header) { touch(acc, header[2].trim()); continue; }
    const move = MOVE_RE.exec(line);
    if (move) { touch(acc, move[1].trim()); continue; }
    if (line.indexOf('*** ') === 0 || line.indexOf('@@') === 0) continue;
    if (line.charAt(0) === '+') acc.added += 1;
    else if (line.charAt(0) === '-') acc.removed += 1;
  }
}

// Counts only inside @@ hunks, so a ---/+++ preamble never counts.
function countUnifiedDiff(diff, acc) {
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.indexOf('@@') === 0) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.charAt(0) === '+') acc.added += 1;
    else if (line.charAt(0) === '-') acc.removed += 1;
  }
}

function patchText(raw) {
  if (typeof raw === 'string' && raw.indexOf('*** Begin Patch') !== -1) return raw;
  const a = parseArgs(raw);
  if (a == null) return null;
  const t = firstString([a.input, a.patch]);
  return t != null && t.indexOf('*** Begin Patch') !== -1 ? t : null;
}

function resultDiff(complete) {
  const r = complete == null ? null : dataOf(complete).result;
  const text = r != null && typeof r.detailedContent === 'string' ? r.detailedContent : null;
  return text != null && /^@@ /m.test(text) ? text : null;
}

function applyEdit(start, complete, acc) {
  const d = dataOf(start);
  const name = canonicalToolName(d.toolName);
  if (EDIT_FAMILY[name] !== true) return;
  if (complete != null && dataOf(complete).success === false) return;
  const patch = patchText(d.arguments);
  if (patch != null) { parsePatch(patch, acc); return; }
  const a = parseArgs(d.arguments) || {};
  const command = typeof a.command === 'string' ? a.command : null;
  // str_replace_editor multiplexes read-only commands.
  if (command === 'view' || command === 'undo_edit') return;
  const file = firstString([a.path, a.file_path, a.filePath, a.fileName, a.notebook_path]);
  if (file == null) return;
  touch(acc, file);
  const diff = resultDiff(complete);
  if (diff != null) { countUnifiedDiff(diff, acc); return; }
  const whole = firstString([a.file_text, a.fileText, a.content, a.new_source]);
  if (command === 'create' || (command == null && name === 'Write')) { acc.added += lineCount(whole); return; }
  if (command === 'insert') { acc.added += lineCount(firstString([a.new_str, a.new_string, a.newString])); return; }
  const edits = Array.isArray(a.edits) ? a.edits : [a];
  for (const e of edits) {
    if (e == null || typeof e !== 'object') continue;
    acc.removed += lineCount(firstString([e.old_str, e.old_string, e.oldString]));
    acc.added += lineCount(firstString([e.new_str, e.new_string, e.newString]));
  }
}

function toWire(paths, added, removed) {
  const byExtension = {};
  let files = 0;
  for (const p of paths) {
    files += 1;
    const ext = extOf(p);
    byExtension[ext] = (byExtension[ext] == null ? 0 : byExtension[ext]) + 1;
  }
  return { files_changed: files, lines_added: added, lines_removed: removed, by_extension: byExtension };
}

export function emptyCodeChanges() {
  return toWire([], 0, 0);
}

function tally(evs, completeById) {
  const acc = { files: new Map(), added: 0, removed: 0 };
  for (const e of evs) {
    if (e.type === 'tool.execution_start') applyEdit(e, completeById.get(dataOf(e).toolCallId), acc);
  }
  return toWire(acc.files.values(), acc.added, acc.removed);
}

function isEmpty(cc) {
  return cc.files_changed === 0 && cc.lines_added === 0 && cc.lines_removed === 0;
}

function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// Last main-thread shutdown before the given line; V-08 default: totals are cumulative across resume.
function previousShutdown(pool, shutdownLine) {
  let prev = null;
  for (const e of pool) {
    if (e.line >= shutdownLine) break;
    if (e.type === 'session.shutdown' && e.agentId == null) prev = e;
  }
  return prev;
}

// First line of the run a shutdown closes: after the previous shutdown, 1 when the window starts the file, else null.
function runStartLine(pool, prev) {
  if (prev != null) return prev.line + 1;
  return pool.length > 0 && pool[0].line === 1 ? 1 : null;
}

// The previous shutdown's lines are subtracted and its files dropped, since its totals are inside this one's.
function fromShutdown(cc, prevCc) {
  const prevKeys = new Set();
  const prevList = prevCc != null && Array.isArray(prevCc.filesModified) ? prevCc.filesModified : [];
  for (const p of prevList) if (typeof p === 'string' && p !== '') prevKeys.add(fileKey(p));
  const seen = new Map();
  const list = Array.isArray(cc.filesModified) ? cc.filesModified : [];
  for (const p of list) {
    if (typeof p !== 'string' || p === '') continue;
    const key = fileKey(p);
    if (!prevKeys.has(key) && !seen.has(key)) seen.set(key, p);
  }
  const added = Math.max(0, count(cc.linesAdded) - (prevCc == null ? 0 : count(prevCc.linesAdded)));
  const removed = Math.max(0, count(cc.linesRemoved) - (prevCc == null ? 0 : count(prevCc.linesRemoved)));
  return toWire(seen.values(), added, removed);
}

function reconcileWithShutdown(pool, segment, own, completeById) {
  if (segment == null || segment.agentId != null || !isEmpty(own)) return own;
  let shutdown = null;
  for (const e of pool) {
    if (e.type === 'session.shutdown' && e.agentId == null && inSegment(e, segment)) shutdown = e;
  }
  if (shutdown == null) return own;
  const cc = dataOf(shutdown).codeChanges;
  if (cc == null || typeof cc !== 'object') return own;
  const prev = previousShutdown(pool, shutdown.line);
  const start = runStartLine(pool, prev);
  if (start == null) return own;
  const run = pool.filter((e) => e.line >= start && e.line <= shutdown.line);
  if (!isEmpty(tally(run, completeById))) return own;
  const prevCc = prev == null ? null : dataOf(prev).codeChanges;
  const totals = fromShutdown(cc, prevCc != null && typeof prevCc === 'object' ? prevCc : null);
  return isEmpty(totals) ? own : totals;
}

export function collectCodeChanges(events, segment, ctx) {
  const list = Array.isArray(events) ? events : [];
  const pool = ctx != null && Array.isArray(ctx.allEvents) ? ctx.allEvents : list;
  const completeById = completionsById(pool);
  const own = tally(list.filter((e) => inSegment(e, segment)), completeById);
  return { code_changes: reconcileWithShutdown(pool, segment, own, completeById) };
}
