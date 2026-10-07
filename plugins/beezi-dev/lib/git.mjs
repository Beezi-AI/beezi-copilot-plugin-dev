import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// A branch is tracked only when it carries a `.../task-<id>` segment. The capture group
// yields the `task-<id>` token (see taskFromBranch).
export const TASK_BRANCH_RE = /\/(task-[a-zA-Z0-9_-]+)/;

let gitBinary;

// Searches absolute PATH entries only, never the cwd; on win32 only PATHEXT's .exe/.com, since .bat/.cmd need a shell.
function resolveGit() {
  const win = process.platform === 'win32';
  const exts = win
    ? String(process.env.PATHEXT || '.COM;.EXE').split(';').map((e) => e.toLowerCase()).filter((e) => e === '.exe' || e === '.com')
    : [''];
  for (const raw of String(process.env.PATH || '').split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (dir === '' || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, `git${ext}`);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch { /* next */ }
    }
  }
  // An unset or empty PATH leaves execvp its default system path; otherwise relative entries would resolve against the spawn cwd.
  return !win && String(process.env.PATH || '') === '' ? 'git' : null;
}

export function git(args, cwd) {
  if (gitBinary === undefined) gitBinary = resolveGit();
  if (gitBinary == null) throw Object.assign(new Error('git not found on PATH'), { code: 'ENOENT' });
  const dir = cwd == null ? process.cwd() : path.resolve(cwd);
  // The repo goes in -C and the spawn runs from the target's filesystem root, which always exists and other users cannot write.
  return execFileSync(gitBinary, ['-C', dir, ...args], {
    cwd: path.parse(dir).root,
    windowsHide: true,
    encoding: 'utf-8',
    // Bound the spawn so a hung git can't burn the whole 10s hook budget.
    timeout: 5000,
    killSignal: 'SIGKILL',
    // Keep git's stderr off the user's terminal: every caller try/catches and reads a
    // failure as "no signal", so a probe outside a repo is normal, not something to report.
    stdio: ['ignore', 'pipe', 'ignore'],
    // Pin the C locale so parsed output (e.g. reflog "checkout: moving from…") stays
    // English regardless of the user's git language settings.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

// A local-path origin carries the OS username; only the folder name may travel, with the same
// `local:` prefix checkpoint.mjs's localRemote() uses so it never canonicalises onto a real server.
// scp-style ssh (`host:path`, `user@host:path`) is NOT local: its colon follows a host of 2+ chars.
// No `new URL()`: `remote` is the server-side repo key, and URL normalisation would fork it.
const LOCAL_ORIGIN_RE = /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;

export function sanitizeRemote(url) {
  if (typeof url !== 'string') return url;
  if (LOCAL_ORIGIN_RE.test(url)) {
    const name = url.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return name ? `local:${name}` : 'local:';
  }
  return url.replace(/\/\/[^@/]+@/, '//').replace(/[?#].*$/, '');
}

// One key per repository across ssh/https/scp forms: host/path, lowercased; null for local: or empty.
export function canonicalRemote(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (value === '' || /^local:/i.test(value)) return null;
  const clean = sanitizeRemote(value);
  // sanitizeRemote turns a local-path origin into `local:<name>`, which must never become a repo key.
  if (/^local:/i.test(clean)) return null;
  let host;
  let rest;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]*)(?::\d*)?(\/.*)?$/i.exec(clean);
  const scp = /^[a-z]:[\\/]/i.test(clean) || clean.indexOf('://') !== -1 ? null : /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(clean);
  if (scheme && scheme[1] !== '') {
    host = scheme[1];
    rest = scheme[2] == null ? '' : scheme[2];
  } else if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    return clean.toLowerCase();
  }
  host = host.toLowerCase().replace(/^www\./, '');
  // SSH-over-443 hosts serve the same repos as the main host.
  if (host === 'ssh.github.com') host = 'github.com';
  else if (host === 'altssh.gitlab.com') host = 'gitlab.com';
  rest = rest.replace(/^\/+/, '');
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    host = 'dev.azure.com';
    rest = rest.replace(/^v3\//i, '');
  } else if (/^[^.]+\.visualstudio\.com$/.test(host)) {
    rest = `${host.slice(0, host.indexOf('.'))}/${rest.replace(/^DefaultCollection\//i, '')}`;
    host = 'dev.azure.com';
  }
  // Azure's short form `<org>/_git/<repo>` names a repo in the project of the same name.
  if (host === 'dev.azure.com') rest = rest.replace(/^([^/]+)\/_git\/([^/]+?)(?:\.git)?\/*$/i, '$1/$2/$2');
  const joined = `${host}/${rest}`.replace(/\/_git\//g, '/');
  return joined.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

// Resolve a repo's origin remote with embedded credentials stripped, or null on any
// failure (not a repo, no origin, git error). Never throws.
export function resolveOriginRemote(gitImpl, dir) {
  try { return sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], dir)); }
  catch { return null; }
}

export function currentBranch(cwd, gitImpl = git) {
  return gitImpl(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// The `task-<id>` token for a task branch, or null when the branch doesn't fit.
export function taskFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(branch == null ? '' : branch);
  return match ? match[1] : null;
}
