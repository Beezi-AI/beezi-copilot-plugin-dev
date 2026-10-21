// A run's cached repo lookups (root, reflog branch, HEAD, remote), the repo map they learn into, and the local stand-in remote.
import path from 'path';
import { copilotChatsDir } from '../config/copilot-paths.mjs';
import { currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-root.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { pathHasPrefix } from '../core/fs-paths.mjs';
import { checkoutEventsFromFiles, headBranchFromFiles, mainWorktreeOf } from './git-files.mjs';

// Last resort when nothing names the work (no cwd anywhere, or a filesystem root): every main work still reports, so the cursor advances.
export const UNKNOWN_REMOTE = 'local:unknown';
export const APP_CHATS_REMOTE = 'local:copilot-chats';

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
export function localRemote(dir) {
  if (!dir) return null;
  // The app runs each chat in its own folder under the chats dir; all of them report as one place.
  if (pathHasPrefix(dir, copilotChatsDir())) return APP_CHATS_REMOTE;
  // A linked worktree names its main repo, so one no-origin repo stays one place.
  let main = null;
  try { main = mainWorktreeOf(dir); } catch { main = null; }
  const name = path.basename(main == null ? dir : main);
  return name ? `local:${name}` : null;
}

// The branch timeline and HEAD from the repo's files; null fields when they can't be read.
function branchesFromFiles(root) {
  let timeline = null;
  let headBranch = null;
  try { timeline = buildBranchTimeline(checkoutEventsFromFiles(root)); } catch { /* unreadable */ }
  try { headBranch = headBranchFromFiles(root); } catch { /* unreadable */ }
  return { timeline, headBranch };
}

// win32 reads the files first (each git.exe start costs 50-300 ms); elsewhere git first, the files only where git fails.
function readBranches(gitImpl, root, platform) {
  if (platform === 'win32') {
    const files = branchesFromFiles(root);
    if (files.headBranch != null) return files;
  }
  let timeline = null;
  let headBranch = null;
  try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
  try { headBranch = currentBranch(root, gitImpl) || null; } catch { /* git failed */ }
  if (timeline == null || headBranch == null) {
    const files = branchesFromFiles(root);
    if (timeline == null) timeline = files.timeline;
    if (headBranch == null) headBranch = files.headBranch;
  }
  return { timeline, headBranch };
}

// beforeGit() runs ahead of every uncached git lookup (a long audit keeps its session lock fresh there).
// A history run passes its run-wide `fastRoot` so repo roots resolve through the exact shortcut.
// → { repoRootOf(dir), branchAt(root, ms), headBranchOf(root), resolveRemote(root), persist() }.
export function createRepoContext(gitImpl, beforeGit, { platform = process.platform, fastRoot = null } = {}) {
  const map = loadRepoMap();
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();
  let dirty = false;
  const repoRootOf = (dir) => {
    beforeGit();
    return resolveRepoRoot(gitImpl, dir, rootCache, map, fastRoot);
  };
  const branchEntry = (root) => {
    let entry = timelineCache.get(root);
    if (!entry) {
      beforeGit();
      // HEAD is always resolved too: it is the last fallback for a line the reflog and the session's own context cannot place.
      const found = readBranches(gitImpl, root, platform);
      entry = { timeline: found.timeline, headBranch: found.headBranch == null ? '(unknown)' : found.headBranch };
      timelineCache.set(root, entry);
    }
    return entry;
  };
  // Reflog only; buildSegments falls back to the session's own branch, then to headBranchOf.
  const branchAt = (root, ms) => {
    if (!root) return '(unknown)';
    const entry = branchEntry(root);
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : '(unknown)';
  };
  const headBranchOf = (root) => (root ? branchEntry(root).headBranch : '(unknown)');
  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    if (!r) r = knownOrigin(root, map);
    if (r) { upsertRoot(map, root, r); dirty = true; }
    remoteCache.set(root, r);
    return r;
  };
  // Saves the map only when a lookup taught it an origin.
  const persist = () => {
    if (!dirty) return;
    try { saveRepoMap(map); } catch { /* best-effort */ }
  };
  return { repoRootOf, branchAt, headBranchOf, resolveRemote, persist };
}
