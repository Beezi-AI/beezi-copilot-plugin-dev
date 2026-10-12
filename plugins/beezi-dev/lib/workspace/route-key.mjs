// The place key a rule for a directory would use (repo remote, folder or outside), cached per routing pass.
import os from 'os';
import { normPath, pathHasPrefix } from '../core/fs-paths.mjs';
import { loadRepoMap, resolveRepoForRouting } from '../repo/repo-map.mjs';
import { canonicalRemote } from '../repo/git.mjs';
import { copilotChatsDir } from '../config/copilot-paths.mjs';
import { outsideKey } from './rule-model.mjs';
import { displayPath } from '../core/text.mjs';

// One repo map load and one key per directory for a whole pass.
export function createRouteContext({ loadRepoMapImpl = loadRepoMap } = {}) {
  let map = null;
  return {
    map() {
      if (map == null) {
        try { map = loadRepoMapImpl(); } catch { map = null; }
        if (map == null) map = { version: 1, roots: {} };
      }
      return map;
    },
    keyCache: new Map(),
  };
}

function homePath() {
  return normPath(os.homedir());
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

// `/`, a drive root, home or a folder above it would catch every session by prefix, temp dirs hold throwaway sessions, and the Copilot app's per-chat folders are no project: these key as `outside`.
export function isUnsafeKeyPath(p) {
  const n = normPath(p);
  if (n == null || n === '/' || /^[a-z]:\/?$/i.test(n)) return true;
  const temps = TEMP_ROOTS.concat([normPath(os.tmpdir())]);
  if (temps.some((t) => t != null && pathHasPrefix(n, t))) return true;
  if (pathHasPrefix(n, copilotChatsDir())) return true;
  const home = homePath();
  // Home inside it: home itself or an ancestor such as /Users.
  return home != null && pathHasPrefix(home, n);
}

// The routing repo facts of a directory ({ root, remote, mainRoot }), resolved once per pass.
function repoFor(d, ctx) {
  if (ctx.repoCache == null) ctx.repoCache = new Map();
  if (!ctx.repoCache.has(d)) ctx.repoCache.set(d, resolveRepoForRouting(d, ctx.map()));
  return ctx.repoCache.get(d);
}

// The directory as seen from its repo's main working tree when it sits in a linked worktree, else null.
export function mainTreePath(dir, ctx) {
  const d = normPath(dir);
  if (d == null || isUnsafeKeyPath(d)) return null;
  const found = repoFor(d, ctx == null ? createRouteContext() : ctx);
  const root = normPath(found.root);
  if (root == null || found.mainRoot == null || !pathHasPrefix(d, root)) return null;
  return `${found.mainRoot}${d.slice(root.length)}`;
}

// The key a rule for this directory would use: its repo's canonical remote, else its repo root or the folder itself; home (or above), /, temp and app chats are `outside`; null only without a directory.
export function routeKeyForDir(dir, ctx) {
  const d = normPath(dir);
  if (d == null) return null;
  if (isUnsafeKeyPath(d)) return outsideKey();
  const context = ctx == null ? createRouteContext() : ctx;
  if (context.keyCache.has(d)) return context.keyCache.get(d);
  const found = repoFor(d, context);
  // A repo rooted at home (dotfiles) would key every session under it, so it counts as no repo.
  const inRepo = found.root != null && !isUnsafeKeyPath(found.root);
  const canon = inRepo ? canonicalRemote(found.remote) : null;
  let key;
  if (canon != null) {
    key = { kind: 'repo', match: canon, label: canon };
  } else {
    // A linked worktree keys as its main repo folder, so one rule covers every worktree.
    const main = inRepo && found.mainRoot != null && !isUnsafeKeyPath(found.mainRoot) ? found.mainRoot : null;
    const folder = main != null ? main : (inRepo ? normPath(found.root) : d);
    key = { kind: 'folder', match: folder, label: displayPath(folder, homePath()) };
  }
  context.keyCache.set(d, key);
  return key;
}
