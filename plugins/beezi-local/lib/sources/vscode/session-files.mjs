// Owns where VS Code Local-agent chat session files live: listing, lookup by id, and the install and workspace of a file.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { vscodeInstalls, vscodeRemoteUserDirs, vscodeWorkspaceStorageDir, vscodeEmptyWindowSessionsDir, vscodeChatSessionsDir } from '../../config/copilot-paths.mjs';
import { vscodeRemoteFolder, codeWorkspaceFolders, pickWorkspaceFolder } from '../../core/fs-paths.mjs';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { isPlain } from '../../core/guards.mjs';

export const SESSION_FILE = /^(.+)\.(jsonl|json)$/;
// A .code-workspace is a small settings file; a larger one is not read.
const CODE_WORKSPACE_MAX = 1024 * 1024;
const NO_PLACE = Object.freeze({ folder: null, workspaceFile: null });
const REMOTE_URI = /^vscode-remote:/i;

function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// The desktop installs first, then the VS Code Server user dirs of a remote host, whose product is unknown.
function chatInstalls() {
  const installs = vscodeInstalls();
  const known = new Set(installs.map((install) => install.userDir));
  const remote = vscodeRemoteUserDirs().filter((userDir) => !known.has(userDir)).map((userDir) => ({ product: null, userDir }));
  return installs.concat(remote);
}

// A file: URI as a native path; a vscode-remote:// URI only when this process runs inside that remote; else null.
function localPathOf(uri) {
  if (typeof uri !== 'string') return null;
  if (/^file:\/\//i.test(uri)) {
    try { return fileURLToPath(uri); } catch { return null; }
  }
  const remote = vscodeRemoteFolder(uri);
  return remote == null ? null : remote.localPath;
}

function readSmallFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= CODE_WORKSPACE_MAX ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

// The folders of a multi-root .code-workspace this process can reach; remote ones map through localPathOf.
function codeWorkspaceLocalFolders(workspaceFile) {
  const text = readSmallFile(workspaceFile);
  if (text == null) return [];
  return codeWorkspaceFolders(text, workspaceFile)
    .map((folder) => (REMOTE_URI.test(folder) ? localPathOf(folder) : folder))
    .filter((folder) => folder != null);
}

// { folder, workspaceFile } from <hash>/workspace.json; a multi-root workspace takes the folder holding the most edited paths.
function workspaceOf(hashDir, editedPaths) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf8')); } catch { return NO_PLACE; }
  if (!isPlain(raw)) return NO_PLACE;
  const folder = localPathOf(raw.folder);
  const workspaceFile = localPathOf(raw.workspace);
  if (folder != null || workspaceFile == null) return { folder, workspaceFile };
  return { folder: pickWorkspaceFolder(codeWorkspaceLocalFolders(workspaceFile), editedPaths), workspaceFile };
}

// The install whose User dir holds the file, then the workspace for workspaceStorage/<hash>/chatSessions/<file>.
// editedPaths (the session's edited files) pick the folder of a multi-root workspace.
export function sessionFileLocation(file, editedPaths = []) {
  const abs = path.resolve(file);
  let product = null;
  for (const install of chatInstalls()) {
    if (abs.indexOf(install.userDir + path.sep) === 0) { product = install.product; break; }
  }
  const sessionsDir = path.dirname(abs);
  const hashDir = path.dirname(sessionsDir);
  const where = sessionsDir === vscodeChatSessionsDir(hashDir) ? workspaceOf(hashDir, editedPaths) : NO_PLACE;
  return { product, folder: where.folder, workspaceFile: where.workspaceFile };
}

// Session files of one directory as { sessionId, file, mtimeMs, size }; .jsonl wins over a same-id .json.
function sessionFilesIn(dir) {
  const byId = new Map();
  for (const name of readDir(dir)) {
    const m = SESSION_FILE.exec(name);
    if (m == null || !isUsableSessionId(m[1])) continue;
    const prior = byId.get(m[1]);
    if (prior != null && prior.ext === 'jsonl') continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    byId.set(m[1], { ext: m[2], entry: { sessionId: m[1], file, mtimeMs: stat.mtimeMs, size: stat.size } });
  }
  return Array.from(byId.values()).map((x) => x.entry);
}

// Every Local-agent chat session file across the VS Code installs, with its folder when it has one (a multi-root
// workspace's first, since nothing here replays the file). Never throws.
export function listVscodeSessions() {
  const out = [];
  try {
    for (const install of chatInstalls()) {
      const storage = vscodeWorkspaceStorageDir(install.userDir);
      for (const hash of readDir(storage)) {
        const hashDir = path.join(storage, hash);
        const files = sessionFilesIn(vscodeChatSessionsDir(hashDir));
        if (files.length === 0) continue;
        const where = workspaceOf(hashDir, []);
        for (const f of files) out.push({ ...f, folder: where.folder, workspaceFile: where.workspaceFile, product: install.product });
      }
      for (const f of sessionFilesIn(vscodeEmptyWindowSessionsDir(install.userDir))) {
        out.push({ ...f, folder: null, workspaceFile: null, product: install.product });
      }
    }
  } catch { /* what was listed so far */ }
  // One id in two folders (a chat moved out of an empty window): the newest file wins, as in the CLI listing.
  const byId = new Map();
  for (const entry of out) {
    const seen = byId.get(entry.sessionId);
    if (seen == null || entry.mtimeMs > seen.mtimeMs) byId.set(entry.sessionId, entry);
  }
  return Array.from(byId.values());
}

// <dir>/<id>.jsonl, else <dir>/<id>.json, when it is a file; null otherwise.
function sessionFileIn(dir, sessionId) {
  for (const ext of ['jsonl', 'json']) {
    const file = path.join(dir, `${sessionId}.${ext}`);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return null;
}

// The chat session file for one id, or null. A hint (VS Code's hook transcript_path, <hash>/<ext>/transcripts/<id>.jsonl)
// names the workspace to try first, and only when that workspace sits directly under an install's workspaceStorage. Never throws.
export function findVscodeSessionFile(sessionId, hint = null) {
  try {
    if (!isUsableSessionId(sessionId)) return null;
    const installs = chatInstalls();
    if (typeof hint === 'string' && hint !== '' && path.basename(path.dirname(hint)) === 'transcripts') {
      const hashDir = path.dirname(path.dirname(path.dirname(path.resolve(hint))));
      // win32 paths compare case-insensitively: VS Code's hint carries a lowercase drive letter.
      const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
      if (installs.some((x) => fold(path.dirname(hashDir)) === fold(vscodeWorkspaceStorageDir(x.userDir)))) {
        const found = sessionFileIn(vscodeChatSessionsDir(hashDir), sessionId);
        if (found != null) return found;
      }
    }
    // Every copy is considered and the newest wins, the same rule as listVscodeSessions.
    let best = null;
    let bestMs = -Infinity;
    const consider = (file) => {
      if (file == null) return;
      try {
        const ms = fs.statSync(file).mtimeMs;
        if (ms > bestMs) { best = file; bestMs = ms; }
      } catch { /* vanished */ }
    };
    for (const install of installs) {
      consider(sessionFileIn(vscodeEmptyWindowSessionsDir(install.userDir), sessionId));
      const storage = vscodeWorkspaceStorageDir(install.userDir);
      for (const hash of readDir(storage)) consider(sessionFileIn(vscodeChatSessionsDir(path.join(storage, hash)), sessionId));
    }
    return best;
  } catch {
    return null;
  }
}
