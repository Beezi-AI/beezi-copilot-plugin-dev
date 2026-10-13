// Owns the backend contract: stable backend names, the bounded shell-less runner and read-result shaping.
import { execFile, execFileSync } from 'child_process';
import { POWERSHELL } from '../../platform/windows-paths.mjs';

// Stable names recorded in the store's control record, so a reader can follow the committed
// generation to the exact backend that holds it.
export const BACKENDS = Object.freeze({
  KEYCHAIN: 'keychain',
  SECRET_SERVICE: 'secret-service',
  CREDENTIAL_MANAGER: 'credential-manager',
  DPAPI_FILE: 'dpapi-file',
  FILE: 'file',
});

// An entry names one stored secret: `service`/`account` in the OS stores, `target` for the
// Credential Manager (CredDelete keys on it alone, so it carries the generation), `file` for the
// file-backed stores.

// Bound the spawn: a locked keychain / hung helper must not block the hook.
const RUN_TIMEOUT_MS = 5000;

// Reads get their own caps, because a read is the operation that races. On Windows every read
// spawns PowerShell, which costs ~1.1s of startup before it runs a line; measured on a developer
// machine one read alone takes 1.6–5.8s depending on load, two at once ~4.2s, and eight at once
// 7.0–8.3s. Hooks fire on every tool call — twice over when a second Beezi variant is installed —
// so losing that race is the normal case, not an exotic one.
//
// The two callers have different budgets, so they get different caps:
//
//   HOOK — killed at 10s and has real work to do after the read (bind, delta, enqueue). 6s buys
//   most of the contended distribution while still leaving several seconds to finish that work;
//   spending the whole 10s on the read alone would trade a fast wrong answer for a slow no answer.
//
//   INTERACTIVE — a human is waiting and nothing kills it, so it takes the full measured worst
//   case and, above this layer, one retry.
//
// Neither cap is load-bearing for correctness any more: a read that is killed now reports
// BACKEND_TIMEOUT, which never reads as "this machine is not linked".
const HOOK_READ_TIMEOUT_MS = 6000;
const INTERACTIVE_READ_TIMEOUT_MS = 8000;

// Run a command with no shell (argv array), optional stdin. Never throws — returns
// { ok, stdout, timedOut } so callers can fall back to the file store on any failure.
//
// `timedOut` separates "the helper was KILLED before it answered" from "the helper answered no".
// Collapsing the two is what let a slow read masquerade as a deleted credential.
export function defaultRun(file, args, input, options) {
  try {
    const stdout = execFileSync(file, args, {
      input: input == null ? undefined : input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: options == null || options.timeoutMs == null ? RUN_TIMEOUT_MS : options.timeoutMs,
      killSignal: 'SIGKILL',
    });
    return { ok: true, stdout: stdout == null ? '' : stdout, timedOut: false };
  } catch (error) {
    // Node reports the timeout kill as a signalled child; ETIMEDOUT covers the platforms that
    // surface it as an error code instead. Everything else is a real answer.
    const timedOut = error != null
      && (error.code === 'ETIMEDOUT' || (error.killed === true && error.signal != null));
    return { ok: false, stdout: '', timedOut };
  }
}

// Turn a run() result into a trimmed token, or null.
function tokenFrom(r) {
  const t = r.ok ? r.stdout.trim() : '';
  return t || null;
}

// One attempt, on the cap the caller's budget allows. Retrying is the STORE's decision, not the
// backend's (see readCredentials): only the caller knows whether it is a hook with a 10s budget
// that must fail fast, or an interactive command with a human waiting that can afford a second
// try. A retry here would have applied to both, and two attempts in a hook overrun the budget
// without ever reporting anything.
export function runRead(run, file, args, input, options) {
  const interactive = options != null && options.interactive === true;
  const timeoutMs = interactive ? INTERACTIVE_READ_TIMEOUT_MS : HOOK_READ_TIMEOUT_MS;
  if (run !== defaultRun) return run(file, args, input, { timeoutMs });
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: 'utf-8', windowsHide: true,
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: stdout || '', timedOut: Boolean(error && (error.killed || error.code === 'ETIMEDOUT')) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? undefined : input);
  });
}

// { token, timedOut } from a read attempt, so the store can tell an absent credential from one it
// simply could not get to in time.
export function readResult(r) {
  if (r && typeof r.then === "function") return r.then(readResult);
  return { token: tokenFrom(r), timedOut: r.timedOut === true };
}

// Every backend defines read(entry) -> { token, timedOut }; get(entry) -> string|null is derived
// from it, so the many callers that only want a token keep working unchanged.
export function withGet(backend) {
  backend.get = (entry, options) => {
    const value = backend.read(entry, options);
    return value && typeof value.then === "function" ? value.then((r) => r.token) : value.token;
  };
  return backend;
}

// PowerShell with no profile and no prompt, running `script` with `input` on stdin.
export function powershell(run, script, input) {
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], input);
}
