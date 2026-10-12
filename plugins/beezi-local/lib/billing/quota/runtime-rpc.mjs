// The Copilot runtime's server mode over stdio: launch, Content-Length JSON-RPC framing and the quota probe exchange.
// A DEFAULT import, not a named one: it is read off the object at call time, so a patched child_process is honoured.
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { beeziHome } from '../../config/paths.mjs';
import { readCopilotIdentity, signedInIdentityKeys, IdentityStatus } from '../../sources/cli/copilot-identity.mjs';
import { QuotaReason, readAuth, readSnapshot } from './snapshot.mjs';

export const MAX_PROBE_MS = 8000;
// A hung or babbling child must not be buffered without bound; the real answer is a few hundred bytes.
const MAX_OUTPUT_BYTES = 1024 * 1024;

// The Copilot SDK's own launch (CLI 1.0.90): headless server on stdio, Content-Length framing, then `connect`.
// Measured: ~0.9 s warm, no session directory created.
const SERVER_ARGS = ['--headless', '--no-auto-update', '--stdio'];
const HANDSHAKE = [{ method: 'connect', params: { supportedTaskKinds: ['agent', 'client', 'shell'] } }];
const AUTH_METHOD = 'account.getCurrentAuth';
const QUOTA_METHOD = 'account.getQuota';
const NOT_SIGNED_IN_RE = /not (signed|logged) in|unauthenticated|no (auth|credentials)/i;

function isOff(value) {
  return /^(0|false|off|no)$/i.test(String(value == null ? '' : value).trim());
}

// Off by switch, inside a probe child (never recurse into Beezi hooks), or without launch flags.
export function probeDisabled(env) {
  return isOff(env.BEEZI_COPILOT_QUOTA) || env.BEEZI_COPILOT_PROBE === '1' || SERVER_ARGS == null;
}

// BEEZI_COPILOT_CLI overrides the binary, for a machine where `copilot` is not on the PATH hooks inherit.
function copilotCommand(env) {
  const override = String(env.BEEZI_COPILOT_CLI == null ? '' : env.BEEZI_COPILOT_CLI).trim();
  return override === '' ? 'copilot' : override;
}

// An npm-installed `copilot` is a .cmd shim on Windows, which Node cannot spawn directly. cmd.exe is
// invoked explicitly (not `shell: true`, which emits a deprecation warning on stderr) with the whole
// command line in one pair of quotes that /s strips and windowsVerbatimArguments keeps intact.
// An absolute cmd.exe: a bare name is searched for in the working directory first.
function launchArgs(command, args, env, platform) {
  if (platform !== 'win32') return { file: command, args, verbatim: false };
  const quoted = command.indexOf(' ') === -1 ? command : `"${command}"`;
  const shell = env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: shell, args: ['/d', '/s', '/c', `"${quoted} ${args.join(' ')}"`], verbatim: true };
}

// On Windows `kill` reaches only the cmd.exe wrapper, so a timed-out runtime below it is ended as a process tree.
// taskkill by absolute path, fire and forget.
function killTree(pid, env, spawnImpl) {
  if (!Number.isInteger(pid)) return;
  try {
    const taskkill = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawnImpl(taskkill, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    if (killer != null && typeof killer.on === 'function') killer.on('error', () => {});
  } catch { /* already gone */ }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// Content-Length framing: append chunks, and while a full header + body is buffered parse it and slice it off.
function createDecoder(onMessage, onOverflow) {
  let buffered = Buffer.alloc(0);
  let total = 0;
  return function push(chunk) {
    total += chunk.length;
    if (total > MAX_OUTPUT_BYTES) { onOverflow(); return; }
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const match = /content-length:\s*(\d+)/i.exec(buffered.slice(0, headerEnd).toString('ascii'));
      if (match == null) { buffered = buffered.slice(headerEnd + 4); continue; }
      const end = headerEnd + 4 + Number(match[1]);
      if (buffered.length < end) return;
      const body = buffered.slice(headerEnd + 4, end).toString('utf8');
      buffered = buffered.slice(end);
      let message = null;
      try { message = JSON.parse(body); } catch { message = null; }
      if (message != null) onMessage(message);
    }
  };
}

// Whose answer the probe may keep, from the files and env alone: no earlier runtime answer and no VS Code stand-in,
// so a VS Code sign-in or a stale answer never blocks the terminal's own gh CLI account.
function configuredIdentity(env) {
  return readCopilotIdentity({ env, runtimeAnswers: false });
}

// The runtime's account counts only if it is the one this process attributes to: the same key when the file
// names one, a listed user when several are signed in, any env-credential account under an env token, and any account
// when nothing is configured (a gh CLI sign-in).
function authMatches(auth, configured) {
  if (auth == null) return false;
  if (configured.status === IdentityStatus.OK) return configured.key === auth.key;
  if (configured.status === IdentityStatus.AMBIGUOUS) return signedInIdentityKeys().indexOf(auth.key) !== -1;
  if (configured.status === IdentityStatus.ENV_TOKEN) return auth.authType !== 'user';
  return configured.status === IdentityStatus.LOGGED_OUT;
}

// Ask the Copilot runtime for the signed-in account and the monthly quota. Never rejects; the child always ends.
// Only the handshake, `account.getCurrentAuth` and `account.getQuota` with `params: {}` are sent, never a token.
// getCurrentAuth is read through readAuth only; getAllUsers, login, logout, models.*, session.* are never called.
// A server-to-client request gets JSON-RPC -32601, notifications are ignored, and only responses to our ids are read.
export function probeQuota({ env = process.env, timeoutMs = MAX_PROBE_MS, spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (probeDisabled(env)) { resolve({ reason: QuotaReason.DISABLED, quota: null }); return; }
    // Taken at probe time: the answer is kept only if the runtime reports the account this process attributes to.
    const configured = configuredIdentity(env);
    const spawnImpl = spawn == null ? (file, args, options) => childProcess.spawn(file, args, options) : spawn;
    const requests = HANDSHAKE.map((h) => ({ method: h.method, params: h.params }))
      .concat([{ method: AUTH_METHOD, params: {} }, { method: QUOTA_METHOD, params: {} }]);
    const authStep = HANDSHAKE.length;
    let auth = null;
    let child = null;
    let settled = false;
    let timer = null;
    let step = 0;

    function finish(reason, quota) {
      if (settled) return;
      settled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (child) {
        // stdin EOF is how the server is meant to end; kill is the backstop, and covers the Windows shell wrapper.
        try { child.stdin.end(); } catch { /* already closed */ }
        if (reason === QuotaReason.TIMEOUT && platform === 'win32') killTree(child.pid, env, spawnImpl);
        try { child.kill(); } catch { /* already gone */ }
      }
      resolve({ reason, quota, auth: reason === QuotaReason.OK || reason === QuotaReason.NO_QUOTA ? auth : null });
    }

    function send(message) {
      if (settled || !child) return;
      try { child.stdin.write(frame(message)); } catch { finish(QuotaReason.ERROR, null); }
    }

    function sendStep() {
      send({ jsonrpc: '2.0', id: step + 1, method: requests[step].method, params: requests[step].params });
    }

    function onMessage(message) {
      if (message == null || typeof message !== 'object') return;
      if (message.method != null) {
        if (message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      if (message.id !== step + 1) return;
      if (message.error != null) {
        const text = typeof message.error.message === 'string' ? message.error.message : '';
        finish(NOT_SIGNED_IN_RE.test(text) ? QuotaReason.NOT_SIGNED_IN : QuotaReason.ERROR, null);
        return;
      }
      if (step === authStep) {
        auth = readAuth(message.result);
        // Another account than the one reports are attributed to: nothing from this runtime is kept.
        if (!authMatches(auth, configured)) { auth = null; finish(QuotaReason.ERROR, null); return; }
      }
      if (step < requests.length - 1) { step += 1; sendStep(); return; }
      const quota = readSnapshot(message.result, auth, new Date().toISOString());
      // An account switch during the probe would mislabel the answer, so it is dropped.
      if (!authMatches(auth, configuredIdentity(env))) { auth = null; finish(QuotaReason.ERROR, null); return; }
      finish(quota == null ? QuotaReason.NO_QUOTA : QuotaReason.OK, quota);
    }

    const launch = launchArgs(copilotCommand(env), SERVER_ARGS, env, platform);
    try {
      // The data root is the child's cwd, and a spawn into a missing cwd fails with ENOENT.
      fs.mkdirSync(beeziHome(), { recursive: true, mode: 0o700 });
      child = spawnImpl(launch.file, launch.args, {
        stdio: 'pipe',
        // Never the caller's cwd (a repo): the child would resolve `copilot` and load project config from it.
        cwd: beeziHome(),
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        env: { ...env, BEEZI_COPILOT_PROBE: '1' },
      });
    } catch {
      finish(QuotaReason.UNAVAILABLE, null);
      return;
    }
    timer = setTimeout(() => finish(QuotaReason.TIMEOUT, null), timeoutMs);
    child.on('error', () => finish(QuotaReason.UNAVAILABLE, null));
    // An EPIPE from a child that exited mid-request is emitted asynchronously and must not kill the process.
    child.stdin.on('error', () => {});
    // Reached only when the child dies before answering; after `finish`, `settled` swallows it.
    child.on('close', () => finish(QuotaReason.UNAVAILABLE, null));
    // Drained and discarded: an unread pipe fills and blocks the child.
    child.stderr.on('data', () => {});
    child.stdout.on('data', createDecoder(onMessage, () => finish(QuotaReason.ERROR, null)));
    sendStep();
  });
}
