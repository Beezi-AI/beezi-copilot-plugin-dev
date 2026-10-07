import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { vscodeInstalls, vscodeWorkspaceStorageDir, vscodeEmptyWindowSessionsDir, vscodeChatSessionsDir } from './copilot-paths.mjs';
import { isUsableSessionId } from './session-state.mjs';

// VS Code's built-in Copilot Chat ("Local" agent) sessions: a kind-0 snapshot plus kind-1/kind-2 patches per line.

const SESSION_FILE = /^(.+)\.(jsonl|json)$/;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const MODEL_PREFIX = /^copilot\//i;

function isPlain(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function finiteMs(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}

function count(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function nonNeg(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
}

function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// file: URI to a local path; remote and virtual schemes give null.
function localPathOf(uri) {
  if (typeof uri !== 'string' || !/^file:\/\//i.test(uri)) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

// { folder, workspaceFile } from <hash>/workspace.json; a .code-workspace never guesses a folder.
function workspaceOf(hashDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf8'));
    if (!isPlain(raw)) return { folder: null, workspaceFile: null };
    return { folder: localPathOf(raw.folder), workspaceFile: localPathOf(raw.workspace) };
  } catch {
    return { folder: null, workspaceFile: null };
  }
}

// The install whose User dir holds the file, then the workspace for workspaceStorage/<hash>/chatSessions/<file>.
function locate(file) {
  const abs = path.resolve(file);
  let product = null;
  for (const install of vscodeInstalls()) {
    if (abs.indexOf(install.userDir + path.sep) === 0) { product = install.product; break; }
  }
  const sessionsDir = path.dirname(abs);
  const hashDir = path.dirname(sessionsDir);
  const where = sessionsDir === vscodeChatSessionsDir(hashDir) ? workspaceOf(hashDir) : { folder: null, workspaceFile: null };
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

// Every Local-agent chat session file across Code and Code - Insiders, with its folder when it has one. Never throws.
export function listVscodeSessions() {
  const out = [];
  try {
    for (const install of vscodeInstalls()) {
      const storage = vscodeWorkspaceStorageDir(install.userDir);
      for (const hash of readDir(storage)) {
        const hashDir = path.join(storage, hash);
        const files = sessionFilesIn(vscodeChatSessionsDir(hashDir));
        if (files.length === 0) continue;
        const where = workspaceOf(hashDir);
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
    const installs = vscodeInstalls();
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

function usableKey(seg) {
  if (typeof seg === 'number') return Number.isInteger(seg) && seg >= 0;
  return typeof seg === 'string' && FORBIDDEN_KEYS.indexOf(seg) === -1;
}

// The container a path names, or undefined when any step is missing or unsafe; never creates containers.
function walk(root, keys) {
  let node = root;
  for (const seg of keys) {
    if (!usableKey(seg) || node == null || typeof node !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

// kind 1 sets the leaf on an existing parent; kind 2 truncates the array to i (when given) then pushes v.
// Returns the possibly replaced root; an unappliable patch is skipped.
function applyPatch(root, entry) {
  const keys = entry.k;
  if (!Array.isArray(keys)) return root;
  if (entry.kind === 1) {
    if (keys.length === 0) return isPlain(entry.v) ? entry.v : root;
    const leaf = keys[keys.length - 1];
    const parent = walk(root, keys.slice(0, -1));
    if (!usableKey(leaf) || parent == null || typeof parent !== 'object') return root;
    if (Array.isArray(parent) && typeof leaf !== 'number') return root;
    parent[leaf] = entry.v;
    return root;
  }
  if (entry.kind === 2) {
    const arr = walk(root, keys);
    if (!Array.isArray(arr) || !Array.isArray(entry.v)) return root;
    if (entry.i !== undefined) {
      if (!Number.isInteger(entry.i) || entry.i < 0 || entry.i > arr.length) return root;
      arr.length = entry.i;
    }
    for (const item of entry.v) arr.push(item);
    return root;
  }
  return root;
}

// The session's full state rebuilt from the file, or null. A torn final line is dropped; a bad earlier line is fatal,
// since later index splices would land on the wrong items. The older single-object .json form is its own snapshot.
export function replayVscodeSession(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (/\.json$/i.test(file)) {
      const whole = JSON.parse(text);
      return isPlain(whole) && Array.isArray(whole.requests) ? whole : null;
    }
    const lines = text.split('\n');
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') last--;
    let root = null;
    for (let n = 0; n <= last; n++) {
      if (lines[n].trim() === '') continue;
      let entry;
      try { entry = JSON.parse(lines[n]); } catch {
        if (n === last) break;
        return null;
      }
      if (!isPlain(entry)) return null;
      if (root == null) {
        if (entry.kind !== 0 || !isPlain(entry.v)) return null;
        root = entry.v;
        continue;
      }
      root = applyPatch(root, entry);
    }
    return isPlain(root) && Array.isArray(root.requests) ? root : null;
  } catch {
    return null;
  }
}

// A billed model name: never the "auto" router and never with the "copilot/" vendor prefix.
function modelName(v) {
  const s = str(v);
  if (s == null) return null;
  const bare = s.replace(MODEL_PREFIX, '');
  return bare === '' || bare.toLowerCase() === 'auto' ? null : bare;
}

function multiplierOf(details) {
  const m = typeof details === 'string' ? /•\s*(\d+(?:\.\d+)?)x\s*$/.exec(details) : null;
  return m == null ? null : nonNeg(Number(m[1]));
}

function requestOf(raw, index) {
  const r = isPlain(raw) ? raw : {};
  const result = isPlain(r.result) ? r.result : {};
  const meta = isPlain(result.metadata) ? result.metadata : {};
  const rounds = Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds.filter(isPlain) : null;
  const lastRound = rounds != null && rounds.length > 0 ? rounds[rounds.length - 1] : null;
  const state = isPlain(r.modelState) ? r.modelState : {};
  const agent = isPlain(r.agent) ? r.agent : {};
  const message = isPlain(r.message) ? r.message : {};
  const completedAtMs = finiteMs(state.completedAt);
  const roundModel = lastRound == null ? null : modelName(lastRound.modelId);
  const promptTokens = count(r.promptTokens);
  return {
    index,
    requestId: str(r.requestId),
    startedAtMs: finiteMs(r.timestamp),
    completedAtMs,
    // Terminal, success or not: modelState 1 is done, 3 is failed or cancelled; both carry completedAt.
    completed: completedAtMs != null,
    state: typeof state.value === 'number' ? state.value : null,
    hasMessage: typeof message.text === 'string' && message.text.trim() !== '',
    model: modelName(meta.resolvedModel) || roundModel || modelName(r.modelId),
    roundModel,
    outputTokens: count(r.completionTokens),
    promptTokens: promptTokens != null ? promptTokens : count(meta.promptTokens),
    credits: nonNeg(r.copilotCredits),
    // The premium-request multiplier from a trailing "• 1x" in result.details; anchored so "• 0.3 credits" never matches.
    multiplier: multiplierOf(result.details),
    // Written in the same save as the final usage, after it: its presence means the counters are final.
    elapsedMs: nonNeg(r.elapsedMs),
    calls: rounds == null ? null : rounds.length,
    extensionVersion: str(agent.extensionVersion),
    agentId: str(agent.id),
    roundTimesMs: rounds == null ? [] : rounds.map((x) => finiteMs(x.timestamp)).filter((t) => t != null),
  };
}

// The account label VS Code stored with the selected model ("auth.accountLabel"), or null.
function accountLabelOf(root) {
  const input = isPlain(root.inputState) ? root.inputState : {};
  const selected = isPlain(input.selectedModel) ? input.selectedModel : {};
  const meta = isPlain(selected.metadata) ? selected.metadata : {};
  const auth = isPlain(meta.auth) ? meta.auth : {};
  return str(auth.accountLabel);
}

// One Local-agent session, usage per request; null for an unusable file. Never throws.
export function readVscodeSession(file) {
  try {
    if (typeof file !== 'string' || file === '') return null;
    const root = replayVscodeSession(file);
    if (root == null) return null;
    const m = SESSION_FILE.exec(path.basename(file));
    const sessionId = str(root.sessionId) || (m == null ? null : m[1]);
    if (!isUsableSessionId(sessionId)) return null;
    const where = locate(file);
    return {
      sessionId,
      file: path.resolve(file),
      product: where.product,
      title: str(root.customTitle),
      createdAtMs: finiteMs(root.creationDate),
      folder: where.folder,
      workspaceFile: where.workspaceFile,
      accountLabel: accountLabelOf(root),
      requests: root.requests.map(requestOf),
    };
  } catch {
    return null;
  }
}

// True when at least one request carries a user message.
export function hasVscodeActivity(session) {
  return session != null && Array.isArray(session.requests) && session.requests.some((r) => r != null && r.hasMessage === true);
}
