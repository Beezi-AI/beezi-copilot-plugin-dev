import os from 'os';
import path from 'path';

// COPILOT_HOME, else ~/.copilot; resolved so every helper below returns an absolute path.
export function copilotHome() {
  const override = process.env.COPILOT_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.copilot');
}

export function copilotSessionStateDir() {
  return path.join(copilotHome(), 'session-state');
}

// Every directory that may hold session-state/<id>/; the CLI's own first (R-09).
export function copilotSessionStateRoots() {
  return [copilotSessionStateDir()];
}

export function copilotSessionDir(sessionId) {
  return path.join(copilotSessionStateDir(), String(sessionId));
}

export function copilotSessionFile(sessionId) {
  return path.join(copilotSessionDir(sessionId), 'events.jsonl');
}

export function copilotSessionStoreDb() {
  return path.join(copilotHome(), 'session-store.db');
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

// Copilot process logs (process-<startMs>-<pid>.log, github-app.<pid>.log); read-only.
export function copilotLogsDir() {
  return path.join(copilotHome(), 'logs');
}

const VSCODE_PRODUCTS = ['Code', 'Code - Insiders'];

// The per-OS parent of VS Code's product folders: Application Support, %APPDATA% or $XDG_CONFIG_HOME.
function vscodeAppDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA ? path.resolve(process.env.APPDATA) : path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ? path.resolve(process.env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
}

// One entry per VS Code product (stable, Insiders): its User dir and its per-launch logs root; read-only.
export function vscodeInstalls() {
  const base = vscodeAppDataDir();
  return VSCODE_PRODUCTS.map((product) => ({
    product,
    userDir: path.join(base, product, 'User'),
    logsDir: path.join(base, product, 'logs'),
  }));
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
