import fs from 'fs';
import os from 'os';
import path from 'path';

// The running process's env, platform and home; every multi-location helper below takes one so tests can pass another host.
function currentHost() {
  return { env: process.env, platform: process.platform, home: os.homedir() };
}

// The one OS path flavour for a host, so a win32 host is joined with backslashes on any machine.
const pathFor = (host) => (host.platform === 'win32' ? path.win32 : path.posix);

// COPILOT_HOME, else ~/.copilot; resolved so every helper below returns an absolute path.
export function copilotHome() {
  const override = process.env.COPILOT_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.copilot');
}

// Every Copilot home a surface may write to: COPILOT_HOME when absolute, then ~/.copilot, which GUI surfaces use.
export function copilotHomes(host = currentHost()) {
  const p = pathFor(host);
  const override = host.env.COPILOT_HOME;
  const homes = override && p.isAbsolute(override) ? [p.resolve(override)] : [];
  return uniquePaths([...homes, p.join(host.home, '.copilot')]);
}

// Order-preserving dedupe by realpath, falling back to the lexical path for directories that do not exist.
function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((p) => {
    let key = p;
    try { key = fs.realpathSync(p); } catch { /* absent: lexical key */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function copilotSessionStateDir() {
  return path.join(copilotHome(), 'session-state');
}

// Every directory that may hold session-state/<id>/; the CLI's own first.
export function copilotSessionStateRoots() {
  return [copilotSessionStateDir()];
}

export function copilotSessionDir(sessionId) {
  return path.join(copilotSessionStateDir(), String(sessionId));
}

export function copilotSessionFile(sessionId) {
  return path.join(copilotSessionDir(sessionId), 'events.jsonl');
}

// The usage store of one Copilot home (copilotHome() by default), so a session found under another home reads its own.
export function copilotSessionStoreDb(home = copilotHome()) {
  return path.join(home, 'session-store.db');
}

// The Copilot app's own database (sessions, accounts, providers): the CLI looks for it at COPILOT_HOME or ~/.copilot.
export function copilotAppDbFile() {
  return path.join(copilotHome(), 'data.db');
}

export function copilotConfigFile() {
  return path.join(copilotHome(), 'config.json');
}

export function copilotSettingsFile() {
  return path.join(copilotHome(), 'settings.json');
}

export function copilotInstalledPluginsDir() {
  return path.join(copilotHome(), 'installed-plugins');
}

// The Copilot app runs each chat in its own folder under here (chats/<date>/<name>).
export function copilotChatsDir() {
  return path.join(copilotHome(), 'chats');
}

// Copilot process logs (process-<startMs>-<pid>.log, github-app.<pid>.log); read-only.
export function copilotLogsDir() {
  return path.join(copilotHome(), 'logs');
}

// The runtime's cache dir, as the CLI derives it: Library/Caches on macOS, LOCALAPPDATA on Windows, XDG_CACHE_HOME elsewhere.
function copilotCacheDir(host) {
  const p = pathFor(host);
  if (host.platform === 'darwin') return p.join(host.home, 'Library', 'Caches', 'copilot');
  const fallback = p.join(host.home, '.cache');
  const base = host.platform === 'win32' ? host.env.LOCALAPPDATA : host.env.XDG_CACHE_HOME;
  return p.join(base || fallback, 'copilot');
}

// Candidate copilot-user-cache.json files, COPILOT_CACHE_HOME first when absolute; read-only, JSONC.
export function copilotUserCacheFiles(host = currentHost()) {
  const p = pathFor(host);
  const override = host.env.COPILOT_CACHE_HOME;
  const fallback = copilotCacheDir(host);
  const dirs = override && p.isAbsolute(override) ? [override, fallback] : [fallback];
  return uniquePaths(dirs.map((dir) => p.join(dir, 'copilot-user-cache.json')));
}

// Stable and Insiders first (callers index them), then the Copilot-capable OSS builds; Cursor and Windsurf are not scanned.
const VSCODE_PRODUCTS = ['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium'];
const FLATPAK_CODE_CONFIG = ['.var', 'app', 'com.visualstudio.code', 'config'];

// The per-OS parent of VS Code's product folders: Application Support, %APPDATA% or $XDG_CONFIG_HOME.
function vscodeAppDataDir(host) {
  const p = pathFor(host);
  if (host.platform === 'darwin') return p.join(host.home, 'Library', 'Application Support');
  if (host.platform === 'win32') return host.env.APPDATA ? p.resolve(host.env.APPDATA) : p.join(host.home, 'AppData', 'Roaming');
  return host.env.XDG_CONFIG_HOME ? p.resolve(host.env.XDG_CONFIG_HOME) : p.join(host.home, '.config');
}

function installAt(p, product, dataDir) {
  return { product, userDir: p.join(dataDir, 'User'), logsDir: p.join(dataDir, 'logs') };
}

// Every VS Code user-data dir the way VS Code resolves it (default, VSCODE_APPDATA, VSCODE_PORTABLE), plus Flatpak on Linux.
// Each entry: { product, userDir, logsDir }; product is null for a portable install, whose product is unknown. Read-only.
export function vscodeInstalls(host = currentHost()) {
  const p = pathFor(host);
  const base = vscodeAppDataDir(host);
  const installs = VSCODE_PRODUCTS.map((product) => installAt(p, product, p.join(base, product)));
  if (host.env.VSCODE_APPDATA) {
    for (const product of VSCODE_PRODUCTS) installs.push(installAt(p, product, p.join(p.resolve(host.env.VSCODE_APPDATA), product)));
  }
  if (host.env.VSCODE_PORTABLE) installs.push(installAt(p, null, p.join(p.resolve(host.env.VSCODE_PORTABLE), 'user-data')));
  if (host.platform === 'linux') installs.push(installAt(p, 'Code', p.join(host.home, ...FLATPAK_CODE_CONFIG, 'Code')));
  const seen = new Set();
  return installs.filter((install) => {
    if (seen.has(install.userDir)) return false;
    seen.add(install.userDir);
    return true;
  });
}

// VS Code Server user dirs on a remote host; where a remote window's chat sessions land is unverified.
export function vscodeRemoteUserDirs(host = currentHost()) {
  const p = pathFor(host);
  return ['.vscode-server', '.vscode-remote'].map((dir) => p.join(host.home, dir, 'data', 'User'));
}

// <hash>/chatSessions/<sid>.jsonl plus <hash>/workspace.json live under here.
export function vscodeWorkspaceStorageDir(userDir) {
  return path.join(userDir, 'workspaceStorage');
}

// <workspaceStorage>/<hash>/chatSessions: one workspace's Local-agent chat sessions.
export function vscodeChatSessionsDir(hashDir) {
  return path.join(hashDir, 'chatSessions');
}

// Chat sessions of windows with no folder open.
export function vscodeEmptyWindowSessionsDir(userDir) {
  return path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
}

// VS Code's global key/value SQLite store (ItemTable).
export function vscodeStateDb(userDir) {
  return path.join(userDir, 'globalStorage', 'state.vscdb');
}

// <logsDir>/<launch>/window<N>/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
export function vscodeCopilotChatLog(launchDir, windowName) {
  return path.join(launchDir, windowName, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
}
