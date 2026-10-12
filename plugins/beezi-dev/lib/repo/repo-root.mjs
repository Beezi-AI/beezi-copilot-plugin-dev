import fs from 'fs';
import { matchKnownRoot, findRepoRootByWalk } from './repo-map.mjs';

// The isDirectory the pipeline hands capture/segments: a stat that never throws (a new or missing file is not a directory).
export function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
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
