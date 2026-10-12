// Owns opening a URL in the user's browser without a shell: the URL is always one argv element.
import { spawn as nodeSpawn } from 'child_process';
import { POWERSHELL } from './windows-paths.mjs';
import { resolveExecutable } from './executables.mjs';

// A launcher that hangs (a stuck PowerShell, a blocked `open`) is killed after this.
export const LAUNCH_TIMEOUT_MS = 5000;

// $BROWSER is a ':'-separated list of commands; only bare command names or paths run, never one needing a shell.
function browserVariable(env) {
  return String(env.BROWSER || '').split(':').filter((entry) => entry !== '' && !/[\s%]/.test(entry));
}

// The first installed Linux launcher: $BROWSER (Codespaces, VS Code remote), wslview under WSL, then xdg-open.
export function linuxLauncher(env) {
  const names = [...browserVariable(env), ...(env.WSL_DISTRO_NAME ? ['wslview'] : []), 'xdg-open'];
  for (const name of names) {
    const file = resolveExecutable(name, env);
    if (file != null) return file;
  }
  return null;
}

// The one launch for `platform`: { file, args, options }, or null when no launcher is installed.
export function launchPlan(url, { env, platform }) {
  if (platform === 'win32') {
    // Start-Process opens the http(s) association; the URL rides in an env var, never in the command text.
    return {
      file: POWERSHELL,
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:BEEZI_LOGIN_URL'],
      options: { stdio: 'ignore', windowsHide: true, env: { ...env, BEEZI_LOGIN_URL: url } },
    };
  }
  if (platform === 'darwin') return { file: '/usr/bin/open', args: [url], options: { stdio: 'ignore' } };
  const launcher = linuxLauncher(env);
  // A Linux launcher may run the browser in the foreground, so it is detached and never waited on.
  return launcher == null ? null : { file: launcher, args: [url], options: { stdio: 'ignore', detached: true } };
}

// Opens `url` (http or https only); true when a launcher was started. Never throws: the caller prints the URL anyway.
export function openBrowser(url, { env = process.env, platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!/^https?:\/\//i.test(String(url))) return false;
  const plan = launchPlan(String(url), { env, platform });
  if (plan == null) return false;
  try {
    const child = spawn(plan.file, plan.args, plan.options);
    child.on('error', () => {});
    if (plan.options.detached === true) {
      child.unref();
      return true;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, LAUNCH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('exit', () => clearTimeout(timer));
    return true;
  } catch {
    return false;
  }
}
