// Sign-in for the terminal setup: the browser flow on a desktop, else (or after a timeout) the paste-back flow.
import { lastLine, token } from './output.mjs';

export const NETWORK_ERRORS = ['Could not reach the Beezi server', 'The login server took too long'];
// No skill name: make-variant renames /beezi-local-analytics in login.mjs's line, and this must still match.
export const STILL_READS = 'still reads from';
export const TIMED_OUT = 'Login timed out before the browser round-trip completed.';
export const SIGN_IN_LABEL = 'Waiting for you to sign in in your browser…';
export const LINK_LABEL = 'Getting your sign-in link…';
export const FINISH_LABEL = 'Finishing your sign-in…';
export const NO_BROWSER_QUESTION = 'Sign in without the browser instead?';
export const PASTE_QUESTION = "Paste the full address from your browser's address bar:";
const ACCOUNT_LINE = /^account=/;
const PENDING_LINE = /^login=pending$/;

// False where no browser can open on this machine: an SSH session, a Codespace, a dev container, or Linux with no display.
export function browserLikely(env, platform) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (env.CODESPACES === 'true' || env.REMOTE_CONTAINERS === 'true') return false;
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// The account a login.mjs run linked; null when the sign-in did not finish.
export function signInResult(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const line = lastLine(result.stdout, /^account=\S+$/);
  const offline = NETWORK_ERRORS.some((text) => output.indexOf(text) !== -1);
  if (result.code !== 0 || line === null || offline) return null;
  return { key: token(line, 'account'), readsElsewhere: result.stdout.indexOf(STILL_READS) !== -1 };
}

function timedOut(result) {
  return `${result.stdout}\n${result.stderr}`.indexOf(TIMED_OUT) !== -1;
}

// login.mjs --no-browser, the address pasted back from the browser, then login.mjs --complete; null when any part stops.
async function pasteBack(ctx) {
  const started = await ctx.run('login', ['--no-browser'], { stream: true, hide: PENDING_LINE, label: LINK_LABEL });
  if (started.code !== 0 || lastLine(started.stdout, PENDING_LINE) === null) return null;
  const typed = await ctx.ask.text(PASTE_QUESTION);
  const address = typeof typed === 'string' ? typed.trim() : '';
  if (address === '') return null;
  const done = await ctx.run('login', ['--complete', address], { stream: true, hide: ACCOUNT_LINE, label: FINISH_LABEL });
  return signInResult(done);
}

// The browser sign-in, or the paste-back where no browser can open, or after the browser sign-in timed out.
export async function signIn(ctx) {
  if (!browserLikely(ctx.env, ctx.platform)) return pasteBack(ctx);
  const result = await ctx.run('login', [], { stream: true, hide: ACCOUNT_LINE, label: SIGN_IN_LABEL });
  if (!timedOut(result)) return signInResult(result);
  return (await ctx.ask.confirm(NO_BROWSER_QUESTION, true)) === true ? pasteBack(ctx) : null;
}
