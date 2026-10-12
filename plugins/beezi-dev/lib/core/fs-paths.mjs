// Owns the one normalized path form, path identity (samePath) and the case-folded, segment-boundary prefix test over it.

// NTFS/APFS default to case-insensitive; fold the lookup key there so C:/Repo and c:/repo collapse.
const PLATFORM = process.platform;
const IN_WSL = PLATFORM === 'linux' && typeof process.env.WSL_DISTRO_NAME === 'string' && process.env.WSL_DISTRO_NAME !== '';

// Forward slashes, no trailing slash. One representation for git output (already forward-slash),
// Node cwd (backslashes on Windows), and transcript file paths.
export function normPath(p) {
  if (typeof p !== 'string' || p === '') return null;
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

// The comparison key: \\wsl$ and \\wsl.localhost are one share; win32, darwin and WSL's DrvFs /mnt/<drive> fold case.
export function foldFor(p, { platform = PLATFORM, wsl = IN_WSL } = {}) {
  const s = p.replace(/^([\\/]{2})wsl\$(?=[\\/]|$)/i, '$1wsl.localhost');
  if (platform === 'win32' || platform === 'darwin') return s.toLowerCase();
  return wsl && /^\/mnt\/[a-z](?:\/|$)/i.test(s) ? s.toLowerCase() : s;
}

export function fold(p) {
  return foldFor(p);
}

// Whether two paths name the same place, compared the way this filesystem would.
export function samePath(a, b, opts) {
  const x = normPath(a);
  const y = normPath(b);
  return x != null && y != null && foldFor(x, opts) === foldFor(y, opts);
}

// Whether dir is root or lies under it, on segment boundaries, case-folded like matchKnownRoot.
export function pathHasPrefix(dir, root) {
  const d = normPath(dir);
  const r = normPath(root);
  if (!d || !r) return false;
  const fd = fold(d);
  const fr = fold(r);
  return fd === fr || fd.startsWith(fr + '/');
}

// vscode-remote://<authority>/<path> → { authority, kind, path, localPath }; localPath only when this process runs
// inside that remote (WSL distro, dev container, Codespace). The authority and path name the user: never send them.
export function vscodeRemoteFolder(uri, { env = process.env, platform = PLATFORM } = {}) {
  const m = typeof uri === 'string' ? /^vscode-remote:\/\/([^/?#]+)([^?#]*)/i.exec(uri) : null;
  if (!m) return null;
  let authority;
  let folder;
  try {
    authority = decodeURIComponent(m[1]);
    folder = decodeURIComponent(m[2] === '' ? '/' : m[2]);
  } catch {
    return null;
  }
  const plus = authority.indexOf('+');
  const kind = (plus === -1 ? authority : authority.slice(0, plus)).toLowerCase();
  const target = plus === -1 ? '' : authority.slice(plus + 1);
  return { authority, kind, path: folder, localPath: localPathInRemote(kind, target, folder, env || {}, platform) };
}

function localPathInRemote(kind, target, folder, env, platform) {
  if (platform !== 'linux') return null;
  if (kind === 'wsl') {
    const distro = typeof env.WSL_DISTRO_NAME === 'string' ? env.WSL_DISTRO_NAME : '';
    return distro !== '' && distro.toLowerCase() === target.toLowerCase() ? folder : null;
  }
  const inContainer = (env.REMOTE_CONTAINERS != null && env.REMOTE_CONTAINERS !== '') || (env.CODESPACES != null && env.CODESPACES !== '');
  return inContainer && (kind === 'dev-container' || kind === 'attached-container' || kind === 'codespaces') ? folder : null;
}

// file:///C:/x → C:/x, file:///home/x → /home/x; null for any other scheme.
export function fileUriToPath(uri) {
  const m = typeof uri === 'string' ? /^file:\/\/([^/]*)(\/[^?#]*)/i.exec(uri) : null;
  if (!m) return null;
  let p;
  try { p = decodeURIComponent(m[2]); } catch { return null; }
  if (/^\/[A-Za-z]:/.test(p)) return p.slice(1);
  return m[1] === '' || m[1].toLowerCase() === 'localhost' ? p : `//${m[1]}${p}`;
}

function isAbsolutePath(p) {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
}

// base + relative, with `.` and `..` segments resolved, in normPath form.
function joinPath(base, rel) {
  const parts = normPath(`${base}/${rel}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && out.length > 1) out.pop();
    else if (part !== '..') out.push(part);
  }
  return out.join('/') || '/';
}

// JSONC (comments, trailing commas) to JSON, string-aware.
function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 64))) {
      continue;
    } else {
      out += c;
    }
  }
  return out;
}

// The folders of a multi-root `.code-workspace` file: local paths in normPath form, relative ones against the file's
// own folder, vscode-remote URIs kept as URIs; [] when the text does not parse.
export function codeWorkspaceFolders(text, workspaceFile) {
  let parsed;
  try { parsed = JSON.parse(stripJsonc(String(text).replace(/^\uFEFF/, ''))); } catch { return []; }
  const folders = parsed != null && Array.isArray(parsed.folders) ? parsed.folders : [];
  const file = normPath(String(workspaceFile));
  const base = file == null ? '/' : file.replace(/\/[^/]*$/, '') || '/';
  const out = [];
  for (const f of folders) {
    if (f == null || typeof f !== 'object') continue;
    let p = null;
    if (typeof f.path === 'string' && f.path !== '') p = isAbsolutePath(f.path) ? normPath(f.path) : joinPath(base, f.path);
    else if (typeof f.uri === 'string') p = /^vscode-remote:/i.test(f.uri) ? f.uri : normPath(fileUriToPath(f.uri));
    if (p != null) out.push(p);
  }
  return out;
}

// The folder holding the most edited files, the first folder on a tie or when no edit falls in any; null for none.
export function pickWorkspaceFolder(folders, editedPaths) {
  const list = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string' && f !== '') : [];
  if (list.length === 0) return null;
  const edits = Array.isArray(editedPaths) ? editedPaths : [];
  let best = list[0];
  let bestCount = 0;
  for (const folder of list) {
    const count = edits.filter((p) => pathHasPrefix(p, folder)).length;
    if (count > bestCount) {
      best = folder;
      bestCount = count;
    }
  }
  return best;
}
