import fs from 'fs';
import path from 'path';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { redactText } from '../../core/redact.mjs';
import { findSessionFile } from './session-files.mjs';
import { dataOf, isHumanPrompt } from './event-types.mjs';

const MAX = 200;
const HEAD_MAX_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const LEADING_BLOCK = /^\s*<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
// Line breaks and tabs stay: they bound path redaction, then collapse with the other whitespace.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const APP_TITLE_SOURCES = ['agent', 'user'];

function stripWrappers(raw) {
  let t = raw;
  for (let i = 0; i < 20; i++) {
    const m = LEADING_BLOCK.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t;
}

function clean(raw) {
  if (typeof raw !== 'string') return '';
  const plain = stripWrappers(raw).replace(ANSI_ESCAPE, '').replace(CONTROL, ' ');
  return redactText(plain).replace(/\s+/g, ' ').replace(/(?:…[\s,;]*){2,}/g, '… ').trim();
}

// Cut at MAX UTF-16 units without leaving half of a surrogate pair.
function cut(text) {
  const head = text.slice(0, MAX);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

export function sanitizeSessionName(raw) {
  const name = cut(clean(raw)).trim();
  if (!name || /^</.test(name) || /^#{1,6}\s/.test(name)) return null;
  return /[\p{L}\p{N}]/u.test(name.replace(/…/g, '')) ? name : null;
}

function unquoteDouble(s) {
  const end = s.lastIndexOf('"');
  const body = end > 0 ? s.slice(0, end + 1) : s + '"';
  try { return String(JSON.parse(body)); } catch { return body.slice(1, -1); }
}

function unquoteSingle(s) {
  const end = s.lastIndexOf("'");
  return (end > 0 ? s.slice(1, end) : s.slice(1)).replace(/''/g, "'");
}

// The caller's transcript path, else the index lookup across every session root; null for an unusable id.
function sessionFiles(sessionId, transcriptPath) {
  if (!isUsableSessionId(sessionId)) return null;
  if (typeof transcriptPath === 'string' && transcriptPath !== '') {
    return { dir: path.dirname(transcriptPath), file: transcriptPath };
  }
  const found = findSessionFile(sessionId);
  return found == null ? null : { dir: found.sessionDir, file: found.transcriptPath };
}

export function readWorkspaceYaml(sessionId, transcriptPath) {
  return readYamlIn(sessionFiles(sessionId, transcriptPath));
}

function readYamlIn(where) {
  if (where == null) return {};
  let raw;
  try { raw = fs.readFileSync(path.join(where.dir, 'workspace.yaml'), 'utf-8'); } catch { return {}; }
  const lines = raw.split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2] == null ? '' : m[2].trim();
    const more = [];
    while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
    let value;
    if (/^[|>][+-]?$/.test(rest)) value = more.join(rest.charAt(0) === '|' ? '\n' : ' ');
    else if (rest.charAt(0) === '"') value = unquoteDouble([rest].concat(more).join(' '));
    else if (rest.charAt(0) === "'") value = unquoteSingle([rest].concat(more).join(' '));
    else value = [rest.replace(/\s+#.*$/, '')].concat(more).join(' ');
    if (value !== '' && value !== '~' && value !== 'null' && m[1] !== '__proto__') out[m[1]] = value;
  }
  return out;
}

// Streams whole JSON lines from the first 2 MB; a line longer than 1 MB is dropped, not buffered.
function* headRecords(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8');
    let carry = '';
    let read = 0;
    while (read < HEAD_MAX_BYTES) {
      let n;
      try { n = fs.readSync(fd, buf, 0, Math.min(CHUNK_BYTES, HEAD_MAX_BYTES - read), read); } catch { return; }
      if (n <= 0) break;
      read += n;
      const lines = (carry + decoder.decode(buf.subarray(0, n), { stream: true })).split('\n');
      carry = lines.pop();
      if (carry.length > MAX_LINE_BYTES) carry = '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec = null;
        try { rec = JSON.parse(line); } catch { /* torn or truncated line */ }
        if (rec != null) yield rec;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function firstPromptName(records) {
  for (const e of records) {
    if (!isHumanPrompt(e)) continue;
    const name = sanitizeSessionName(dataOf(e).content);
    if (name != null) return name;
  }
  return null;
}

function isPlaceholder(name, ws, sessionId) {
  if (typeof name !== 'string') return true;
  const base = typeof ws.cwd === 'string' ? path.basename(ws.cwd.replace(/[\\/]+$/, '')) : null;
  return name === sessionId || name === ws.id || (base != null && name === base);
}

// The app's own title when its agent or user set it; appFacts is app-db's { title, titleSource } or null.
function appTitle(appFacts) {
  if (appFacts == null || typeof appFacts !== 'object' || APP_TITLE_SOURCES.indexOf(appFacts.titleSource) === -1) return null;
  return sanitizeSessionName(appFacts.title);
}

export function resolveSessionName(sessionId, events, transcriptPath, appFacts = null) {
  const where = sessionFiles(sessionId, transcriptPath);
  if (where == null && !isUsableSessionId(sessionId)) return null;
  const titled = appTitle(appFacts);
  if (titled != null) return titled;
  const ws = readYamlIn(where);
  const named = isPlaceholder(ws.name, ws, sessionId) ? null : sanitizeSessionName(ws.name);
  if (named != null) return named;
  const summary = sanitizeSessionName(ws.summary);
  if (summary != null) return summary;
  const list = Array.isArray(events) ? events : [];
  if (list.length > 0 && list[0].line === 1) return firstPromptName(list);
  return where == null ? null : firstPromptName(headRecords(where.file));
}
