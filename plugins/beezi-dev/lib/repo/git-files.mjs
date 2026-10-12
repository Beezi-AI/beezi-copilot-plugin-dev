// Git facts read from the repository's own files, never the git binary: git dir, common dir, main worktree, HEAD and reflog.
import fs from 'fs';
import path from 'path';
import { normPath } from '../core/fs-paths.mjs';

export const REPO_READ_MAX = 4 * 1024 * 1024;
const POINTER_MAX = 64 * 1024;
const REFLOG_LIMIT = 1000;

// A repo-controlled file: regular files only (a FIFO or device throws ENOTREG), at most `max` bytes from the head or the tail.
export function readRepoFile(file, { max = REPO_READ_MAX, tail = false } = {}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
  const length = Math.min(stat.size, max);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let read = 0;
    const start = tail ? stat.size - length : 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readSmall(file) {
  try { return readRepoFile(file, { max: POINTER_MAX }); } catch { return null; }
}

// The repo's git dir: `.git` itself, or the target of a worktree/submodule `.git` file's `gitdir:` line; null when absent.
export function gitDirOf(root) {
  if (typeof root !== 'string' || root === '') return null;
  const dotGit = path.join(root, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) return dotGit;
  const text = readSmall(dotGit);
  const m = text == null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(root, m[1]);
}

// A linked worktree's shared dir (its `commondir`), else the git dir itself.
export function commonDirOf(gitDir) {
  if (gitDir == null) return null;
  const rel = readSmall(path.join(gitDir, 'commondir'));
  if (rel == null || rel.trim() === '') return gitDir;
  return path.isAbsolute(rel.trim()) ? rel.trim() : path.resolve(gitDir, rel.trim());
}

// The config file holding the repo's remotes (shared by every worktree).
export function gitConfigPathOf(root) {
  const common = commonDirOf(gitDirOf(root));
  return common == null ? null : path.join(common, 'config');
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The main working tree of a linked worktree (commondir is a non-bare `<main>/.git`); null for a main checkout, submodule or bare repo.
export function mainWorktreeOf(root) {
  let isFileEntry;
  try { isFileEntry = fs.statSync(path.join(root, '.git')).isFile(); } catch { return null; }
  if (!isFileEntry) return null;
  const gitDir = gitDirOf(root);
  const common = commonDirOf(gitDir);
  if (common == null || common === gitDir || path.basename(common) !== '.git' || !isDir(common)) return null;
  const main = normPath(path.dirname(common));
  return main != null && main !== normPath(root) ? main : null;
}

// The checked-out branch from HEAD, `HEAD` when detached (as rev-parse --abbrev-ref prints it); null when unreadable.
export function headBranchFromFiles(root) {
  const gitDir = gitDirOf(root);
  const text = gitDir == null ? null : readSmall(path.join(gitDir, 'HEAD'));
  if (text == null) return null;
  const head = text.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  return /^[0-9a-f]{40,64}$/i.test(head) ? 'HEAD' : null;
}

const REFLOG_LINE = /^[0-9a-f]+ [0-9a-f]+ .*? (\d+) [+-]\d{4}\tcheckout: moving from (\S+) to (\S+)/;

// Checkout events from logs/HEAD in the last 1000 entries (git reflog -n 1000), ascending; [] when unreadable.
export function checkoutEventsFromFiles(root) {
  const gitDir = gitDirOf(root);
  let text;
  try { text = gitDir == null ? null : readRepoFile(path.join(gitDir, 'logs', 'HEAD'), { tail: true }); } catch { text = null; }
  if (text == null) return [];
  const lines = text.split('\n');
  const events = [];
  for (const raw of lines.slice(Math.max(0, lines.length - 1 - REFLOG_LIMIT))) {
    const m = REFLOG_LINE.exec(raw);
    if (m) events.push({ ms: Number(m[1]) * 1000, from: m[2], to: m[3] });
  }
  events.sort((a, b) => a.ms - b.ms);
  return events;
}
