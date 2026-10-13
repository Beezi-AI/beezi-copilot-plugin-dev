// Owns the replay of a VS Code chat session's text: a kind-0 snapshot plus kind-1/kind-2 patches per line.
import { isPlain } from '../../core/guards.mjs';

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
// Every promptTokens value a kind-1 patch wrote onto a request object, oldest first; a replaced request is a new key.
const promptTokensWritten = new WeakMap();

function isTokenValue(v) {
  return typeof v === 'number' && isFinite(v);
}

// k = ['requests', <i>, 'promptTokens']: one model call's prompt size written onto request i.
function isPromptTokensWrite(keys) {
  return keys.length === 3 && keys[0] === 'requests' && keys[2] === 'promptTokens';
}

// Appends a written value, seeding the list with the value the request held before its first patched write.
function notePromptTokens(request, value) {
  let seen = promptTokensWritten.get(request);
  if (seen == null) {
    seen = isTokenValue(request.promptTokens) ? [request.promptTokens] : [];
    promptTokensWritten.set(request, seen);
  }
  if (isTokenValue(value)) seen.push(value);
}

// Every promptTokens value a replayed request held, in file order; a never-patched request gives its own value, if any.
export function promptTokensSeenOf(request) {
  if (!isPlain(request)) return [];
  const seen = promptTokensWritten.get(request);
  if (seen != null) return seen.slice();
  return isTokenValue(request.promptTokens) ? [request.promptTokens] : [];
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
    if (isPromptTokensWrite(keys)) notePromptTokens(parent, entry.v);
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

// The session's full state rebuilt from the file text, or null. A torn final line is dropped; a bad earlier line is fatal,
// since later index splices would land on the wrong items. The older single-object .json form (`isWholeJson`) is its own snapshot.
export function replaySessionText(text, isWholeJson) {
  try {
    if (isWholeJson) {
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
