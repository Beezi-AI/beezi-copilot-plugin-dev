import fs from 'fs';
import path from 'path';
import { matchKnownRoot, findRepoRootByWalk } from './repo-map.mjs';

// Match a `cd`/`pushd` (optionally `cd /d`) at a command boundary; capture the target,
// quoted or bare. Global so we can take the LAST match in a compound command.
const CD_RE = /(?:^|&&|;|\|)\s*(?:cd|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g;

// Normalize any OS path to forward slashes so signals from different sources
// (transcript file paths, cd targets, session cwd) share one representation —
// keeps repoRootOf cache keys stable and output deterministic across platforms.
function norm(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

function lastCdTarget(command, cwd) {
  if (typeof command !== 'string') return null;
  let target = null;
  let m;
  CD_RE.lastIndex = 0;
  while ((m = CD_RE.exec(command)) !== null) {
    let t = m[1];
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    target = t;
  }
  if (!target || target === '-' || target === '~') return null; // unresolvable targets
  target = norm(target);
  // win32.isAbsolute treats both POSIX ("/repo") and drive ("C:/repo") roots as absolute.
  if (path.win32.isAbsolute(target)) return target;
  return cwd ? path.posix.join(norm(cwd), target) : null;
}

// Argument keys are matched, not tool names, so a renamed or unknown built-in still attributes; V-32 narrows these.
const FILE_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'file', 'notebook_path', 'target_file'];
const DIR_KEYS = ['cwd', 'workdir', 'working_directory', 'directory', 'dir'];

// `arguments` is an object, or a JSON string holding one.
function argsOf(data) {
  let a = data == null ? null : data.arguments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  return a != null && typeof a === 'object' && !Array.isArray(a) ? a : null;
}

// Absolute forward-slash path, joining a relative one onto the stream's cwd; `~` paths are ignored.
function absolute(p, cwd) {
  if (typeof p !== 'string' || p === '' || p[0] === '~') return null;
  const n = norm(p);
  if (path.win32.isAbsolute(n)) return n;
  return cwd ? path.posix.join(norm(cwd), n) : null;
}

function dirOfFile(p) {
  try { if (fs.statSync(p).isDirectory()) return p; } catch { /* new or missing file */ }
  return path.posix.dirname(p);
}

// The directory a tool.execution_start implies (last candidate wins), or null; the caller carries the previous one forward.
export function pathSignalOf(event, cwd) {
  if (event == null || event.type !== 'tool.execution_start') return null;
  const args = argsOf(event.data);
  let dir = null;
  if (args) {
    for (const k of FILE_KEYS) { const p = absolute(args[k], cwd); if (p) dir = dirOfFile(p); }
    for (const k of DIR_KEYS) { const p = absolute(args[k], cwd); if (p) dir = p; }
  }
  const info = event.data == null ? null : event.data.shellToolInfo;
  const possible = info != null && Array.isArray(info.possiblePaths) ? info.possiblePaths : [];
  for (const p of possible) { const abs = absolute(p, null); if (abs) { dir = dirOfFile(abs); break; } }
  if (args && typeof args.command === 'string') {
    const cdDir = lastCdTarget(args.command, cwd);
    if (cdDir) dir = cdDir;
  }
  return dir;
}

// git repo root for `dir`, memoized in `cache`. Resolution order: `git rev-parse --show-toplevel`
// (authoritative — handles subdirs/worktrees/submodules), then the persisted known-root map
// (longest-prefix), then a filesystem walk-up. The last two rescue git false-nulls (git not on
// PATH, 5s timeout, Windows dubious-ownership) where the dir genuinely is inside a repo.
// Returns null when `dir` is falsy or no layer resolves a root.
export function resolveRepoRoot(gitImpl, dir, cache, map = null) {
  if (!dir) return null;
  if (cache && cache.has(dir)) return cache.get(dir);
  let root = null;
  try {
    const out = gitImpl(['rev-parse', '--show-toplevel'], dir).trim();
    root = out === '' ? null : out;
  } catch {
    root = null;
  }
  if (root === null && map) root = matchKnownRoot(dir, map);
  if (root === null) root = findRepoRootByWalk(dir);
  if (cache) cache.set(dir, root);
  return root;
}
