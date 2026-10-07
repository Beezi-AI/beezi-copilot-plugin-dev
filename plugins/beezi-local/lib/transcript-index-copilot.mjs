import fs from 'fs';
import path from 'path';
import { copilotSessionStateRoots } from './copilot-paths.mjs';
import { EVENT_TYPES, parseEventLine } from './copilot-events.mjs';
import { isUsableSessionId } from './session-state.mjs';

const TRANSCRIPT = 'events.jsonl';
const HEAD_BYTES = 64 * 1024;
const WORKSPACE_KEYS = ['id', 'cwd', 'name', 'summary', 'created', 'updated'];

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Top-level `key: value` scalars only; nested and block values read as null.
function readWorkspaceYaml(dir) {
  const out = { id: null, cwd: null, name: null, summary: null, created: null, updated: null };
  let text;
  try { text = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf-8'); } catch { return out; }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m || WORKSPACE_KEYS.indexOf(m[1]) === -1) continue;
    const value = m[2].trim();
    if (value === '' || value === '|' || value === '>' || /^[|>][+-]?$/.test(value)) continue;
    out[m[1]] = unquote(value);
  }
  return out;
}

// Stat-only description of <root>/<id>/events.jsonl, or null when it is not a file.
function describe(root, id) {
  const sessionDir = path.join(root, id);
  const transcriptPath = path.join(sessionDir, TRANSCRIPT);
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;
    return { sessionId: id, sessionDir, transcriptPath, mtimeMs: stat.mtimeMs, size: stat.size, root };
  } catch {
    return null;
  }
}

// Oldest first, as the base import order; ids that fail isUsableSessionId never reach a path.
export function listSessionFiles({ roots = copilotSessionStateRoots(), quietForMs = 0 } = {}) {
  const now = Date.now();
  const byId = new Map();
  for (const root of Array.isArray(roots) ? roots : []) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!isUsableSessionId(name)) continue;
      const entry = describe(root, name);
      if (entry == null) continue;
      const seen = byId.get(name);
      if (seen == null || entry.mtimeMs > seen.mtimeMs) byId.set(name, entry);
    }
  }
  const out = [];
  for (const entry of byId.values()) {
    if (quietForMs > 0 && now - entry.mtimeMs < quietForMs) continue;
    out.push(entry);
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Up to the first 64 KB, cut at the last newline when the read may have stopped mid-line.
function readHeadText(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.toString('utf-8', 0, n);
    return n === HEAD_BYTES ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

export function readSessionHead(transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
    const dir = path.dirname(transcriptPath);
    const text = readHeadText(transcriptPath);
    let start = null;
    if (text != null) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && start == null; i++) {
        const ev = parseEventLine(lines[i], i + 1);
        if (ev != null && ev.type === EVENT_TYPES.SESSION_START) start = ev;
      }
    }
    const context = start != null && start.data.context != null && typeof start.data.context === 'object' ? start.data.context : null;
    let cwd = context == null ? null : str(context.cwd);
    let workspace = null;
    if (cwd == null) {
      workspace = readWorkspaceYaml(dir);
      cwd = str(workspace.cwd);
    }
    if (start == null && cwd == null) return null;
    // The recorded id is used only when it is itself a usable segment; else the directory names the session.
    const recorded = start == null ? null : str(start.data.sessionId);
    const dirName = path.basename(dir);
    const sessionId = isUsableSessionId(recorded) ? recorded : (isUsableSessionId(dirName) ? dirName : null);
    if (sessionId == null) return null;
    const startedAt = start != null
      ? (str(start.data.startTime) == null ? start.timestamp : start.data.startTime)
      : (workspace == null ? null : str(workspace.created));
    return {
      sessionId,
      cwd,
      startedAt: startedAt == null ? null : startedAt,
      copilotVersion: start == null ? null : str(start.data.copilotVersion),
    };
  } catch {
    return null;
  }
}

// Stats <root>/<id>/events.jsonl in each root with no directory scan; the newest wins.
export function findSessionFile(sessionId) {
  try {
    if (!isUsableSessionId(sessionId)) return null;
    let best = null;
    for (const root of copilotSessionStateRoots()) {
      const entry = describe(root, sessionId);
      if (entry != null && (best == null || entry.mtimeMs > best.mtimeMs)) best = entry;
    }
    return best;
  } catch {
    return null;
  }
}
