import path from 'path';
import { dataOf, isDiff } from '../../sources/cli/event-types.mjs';
import { canonicalToolName, completionsById, inSegment, parseArgs } from './operations.mjs';
import { patchText, readPatch } from './apply-patch.mjs';

const EDIT_FAMILY = { Edit: true, Write: true, MultiEdit: true, NotebookEdit: true };
const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

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

function addLines(acc, counted) {
  acc.added += counted.added;
  acc.removed += counted.removed;
}

// The old and new line counts a hunk header announces (1 when omitted); a header without them runs to the end.
function hunkSize(line) {
  const m = HUNK_RE.exec(line);
  if (m == null) return { old: Infinity, new: Infinity };
  return { old: m[1] == null ? 1 : Number(m[1]), new: m[2] == null ? 1 : Number(m[2]) };
}

// Counts only inside @@ hunks and only as many lines as each header announces, so no file header ever counts.
function countUnifiedDiff(diff) {
  const out = { added: 0, removed: 0 };
  let left = { old: 0, new: 0 };
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.indexOf('@@') === 0) { left = hunkSize(line); continue; }
    if (left.old <= 0 && left.new <= 0) continue;
    const c = line.charAt(0);
    if (c === '+') { out.added += 1; left.new -= 1; }
    else if (c === '-') { out.removed += 1; left.old -= 1; }
    else if (c === ' ' || line === '') { left.old -= 1; left.new -= 1; }
  }
  return out;
}

function isCount(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0;
}

// Copilot's own per-call line counts (toolTelemetry.metrics), preferred over any parsing when both are present.
function telemetryLines(complete) {
  const t = complete == null ? null : dataOf(complete).toolTelemetry;
  const m = t != null && typeof t === 'object' && t.metrics != null && typeof t.metrics === 'object' ? t.metrics : null;
  if (m == null || !isCount(m.linesAdded) || !isCount(m.linesRemoved)) return null;
  return { added: Math.round(m.linesAdded), removed: Math.round(m.linesRemoved) };
}

function resultDiff(complete) {
  const r = complete == null ? null : dataOf(complete).result;
  const text = r != null ? r.detailedContent : null;
  return isDiff(text) ? text : null;
}

function applyEdit(start, complete, acc) {
  const d = dataOf(start);
  const name = canonicalToolName(d.toolName);
  if (EDIT_FAMILY[name] !== true) return;
  if (complete != null && dataOf(complete).success === false) return;
  const counted = telemetryLines(complete);
  const patch = patchText(d.arguments);
  if (patch != null) {
    const read = readPatch(patch);
    for (const file of read.files) touch(acc, file);
    addLines(acc, counted != null ? counted : read);
    return;
  }
  const a = parseArgs(d.arguments) || {};
  const command = typeof a.command === 'string' ? a.command : null;
  // str_replace_editor multiplexes read-only commands.
  if (command === 'view' || command === 'undo_edit') return;
  const file = firstString([a.path, a.file_path, a.filePath, a.fileName, a.notebook_path]);
  if (file == null) return;
  touch(acc, file);
  if (counted != null) { addLines(acc, counted); return; }
  const diff = resultDiff(complete);
  if (diff != null) { addLines(acc, countUnifiedDiff(diff)); return; }
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

// Last own main-thread shutdown before the given line (a fork's copied ones are its parent's); totals are
// cumulative across resume.
function previousShutdown(pool, shutdownLine, forkLine) {
  let prev = null;
  for (const e of pool) {
    if (e.line >= shutdownLine) break;
    if (e.type === 'session.shutdown' && e.agentId == null && e.line > forkLine) prev = e;
  }
  return prev;
}

// First line of the run a shutdown closes: after the previous shutdown, else the session's own first line when the pool
// reaches it, else null.
function runStartLine(pool, prev, forkLine) {
  if (prev != null) return prev.line + 1;
  return pool.length > 0 && pool[0].line <= forkLine + 1 ? forkLine + 1 : null;
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

function reconcileWithShutdown(pool, segment, own, completeById, forkLine) {
  if (segment == null || segment.agentId != null || !isEmpty(own)) return own;
  let shutdown = null;
  for (const e of pool) {
    if (e.type === 'session.shutdown' && e.agentId == null && inSegment(e, segment)) shutdown = e;
  }
  if (shutdown == null) return own;
  const cc = dataOf(shutdown).codeChanges;
  if (cc == null || typeof cc !== 'object') return own;
  const prev = previousShutdown(pool, shutdown.line, forkLine);
  const start = runStartLine(pool, prev, forkLine);
  if (start == null) return own;
  const run = pool.filter((e) => e.line >= start && e.line <= shutdown.line);
  if (!isEmpty(tally(run, completeById))) return own;
  const prevCc = prev == null ? null : dataOf(prev).codeChanges;
  const totals = fromShutdown(cc, prevCc != null && typeof prevCc === 'object' ? prevCc : null);
  return isEmpty(totals) ? own : totals;
}

// ctx: { allEvents (the whole file, else the given events), forkLine (the last line a fork copied, else 0) }.
export function collectCodeChanges(events, segment, ctx) {
  const list = Array.isArray(events) ? events : [];
  const pool = ctx != null && Array.isArray(ctx.allEvents) ? ctx.allEvents : list;
  const forkLine = ctx != null && Number.isInteger(ctx.forkLine) && ctx.forkLine > 0 ? ctx.forkLine : 0;
  const completeById = completionsById(pool);
  const own = tally(list.filter((e) => inSegment(e, segment)), completeById);
  return { code_changes: reconcileWithShutdown(pool, segment, own, completeById, forkLine) };
}
