// The history run's shared git cache: memoized git calls and the repo roots already resolved.
import { git as defaultGit } from '../repo/git.mjs';
import { memoizeGit } from '../repo/git-memo.mjs';
import { fastRepoRoot } from '../repo/repo-root-fast.mjs';

// One git memo and repo-root shortcut for a whole history run, shared by every session and every workspace pass in it.
export function createRunCache(deps = {}) {
  const git = memoizeGit(deps.gitImpl == null ? defaultGit : deps.gitImpl);
  const gitRoots = new Map();
  return { git, gitRoots, fastRoot: (dir) => fastRepoRoot(git, dir, gitRoots) };
}
