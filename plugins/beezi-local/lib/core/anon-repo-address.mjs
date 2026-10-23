// Owns the repo, folder and branch inputs of anon values (Claude-form sanitize and canonical address).
import { ANON_KIND, anonValue, isAnonValue } from './anon-value.mjs';

const LOCAL_ORIGIN_RE = /^(?:file:|[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;
const LOCAL_PREFIX_RE = /^local:/i;
const LOCAL_PREFIX_LENGTH = 6;
const PASS_THROUGH_REMOTES = new Set(['local:copilot-chats', 'local:unknown', 'local:']);
const PASS_THROUGH_BRANCHES = new Set(['(unknown)', 'HEAD', '']);

export function anonSanitizeRemote(url) {
  if (typeof url !== 'string') return url;
  if (LOCAL_ORIGIN_RE.test(url)) {
    const name = url.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return name ? `local:${name}` : 'local:';
  }
  return url.replace(/\/\/[^@/]+@/, '//').replace(/[?#].*$/, '');
}

// host/path lowercased, one per repository across ssh/https/scp forms; a bare host/path is only lowercased; null for local: or empty.
export function anonRepoAddress(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (value === '' || /^local:/i.test(value)) return null;
  const clean = anonSanitizeRemote(value);
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
  // Azure's short form <org>/_git/<repo> names a repo in the project of the same name.
  if (host === 'dev.azure.com') rest = rest.replace(/^([^/]+)\/_git\/([^/]+?)(?:\.git)?\/*$/i, '$1/$2/$2');
  const joined = `${host}/${rest}`.replace(/\/_git\//g, '/');
  return joined.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

export function anonRemote(keyHex, remote) {
  if (typeof remote !== 'string' || isAnonValue(remote)) return remote;
  const sanitized = anonSanitizeRemote(remote.trim());
  if (PASS_THROUGH_REMOTES.has(sanitized)) return sanitized;
  if (LOCAL_PREFIX_RE.test(sanitized)) return anonValue(keyHex, ANON_KIND.FOLDER, sanitized.slice(LOCAL_PREFIX_LENGTH));
  const address = anonRepoAddress(sanitized);
  return address == null ? sanitized : anonValue(keyHex, ANON_KIND.REPO, address);
}

// The scope is the anon remote, so a raw and an already-hashed remote give the same branch; no remote scopes to ''.
export function anonBranch(keyHex, remote, branch) {
  if (typeof branch !== 'string' || isAnonValue(branch) || PASS_THROUGH_BRANCHES.has(branch)) return branch;
  const scope = typeof remote === 'string' ? anonRemote(keyHex, remote) : '';
  return anonValue(keyHex, ANON_KIND.BRANCH, scope + '\0' + branch);
}
