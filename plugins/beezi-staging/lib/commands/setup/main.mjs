// The terminal setup's entry: the header, the terminal, the prompt and the runner, then the wizard or the stop line.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { friendlyMessage } from '../../core/errors.mjs';
import { copilotAuthEnv } from '../../sources/cli/copilot-identity.mjs';
import { headerLines } from '../../ux/setup/finale.mjs';
import { canReadKeys, formatLine, paint, terminalStyle } from '../../ux/setup/style.mjs';
import { createPrompt, openTerminal } from './prompt.mjs';
import { createRunner } from './runner.mjs';
import { runSetup } from './wizard.mjs';

// Copilot's session id: removed from the children's environment, so no script binds this run to a session.
export const SESSION_KEYS = ['COPILOT_AGENT_SESSION_ID'];
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Run /beezi-staging-login in GitHub Copilot instead.';
export const STOPPED = 'Setup stopped. Run /beezi-staging-login in GitHub Copilot to finish.';
// Copilot keeps these out of its hooks' environment (GH_TOKEN still reaches them), so the steps run without them too.
export const HIDDEN_TOKEN_VARS = ['COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN'];
const SHOW_CURSOR = '\x1b[?25h';
const MARGIN = '  ';

export function realDeps(root) {
  return {
    root,
    env: process.env,
    platform: process.platform,
    output: process.stdout,
    openTerminal,
    createPrompt,
    createRunner,
    runSetup,
    makeTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-')),
    // Removes the dir when empty; a dir a script wrote into is left for the OS temp cleaner.
    removeDir: (dir) => {
      try {
        fs.rmdirSync(dir);
      } catch (error) { /* not empty, or already gone */ }
    },
    onExit: (handler) => { process.on('exit', handler); },
    onInterrupt: (handler) => { process.on('SIGINT', handler); },
    exit: (code) => { process.exit(code); },
  };
}

export function hiddenTokenLine(name) {
  return `⚠ Beezi: your shell sets ${name}, but Copilot hides it from plugins, so Beezi can’t tell which GitHub `
    + 'account that token belongs to. To fix that, export it as GH_TOKEN instead.';
}

// The shell's env without the token vars Copilot hides from its hooks.
function hookVisibleEnv(env) {
  const out = Object.assign({}, env);
  HIDDEN_TOKEN_VARS.forEach((name) => { delete out[name]; });
  return out;
}

// Each non-empty \n-separated part starts at the setup's left margin.
function indent(line) {
  return String(line).split('\n').map((part) => (part === '' ? part : MARGIN + part)).join('\n');
}

// Runs the wizard on the terminal and resolves its exit code; the header is left to the installer when it ran the setup.
export function setupMain(deps) {
  const output = deps.output;
  const style = terminalStyle({ stream: output, env: deps.env });
  // Wrapped to the width on a terminal; a log keeps each line whole.
  const format = (line) => (output.isTTY ? formatLine(style, indent(line), output.columns || 80) : paint(style, indent(line)));
  const print = (line) => { output.write(`${format(line)}\n`); };
  if (deps.env.BEEZI_INSTALLER !== '1') headerLines(style).forEach((line) => { output.write(`${line}\n`); });
  const input = deps.openTerminal();
  if (input === null) {
    print(NO_TERMINAL);
    return Promise.resolve(1);
  }
  let run = null;
  let ask = null;
  let done;
  // A synchronous throw from here on ends in the same stop line as a rejected wizard.
  try {
    const cwd = deps.makeTempDir();
    deps.onExit(() => deps.removeDir(cwd));
    // Shows the cursor again on process exit.
    if (output.isTTY) deps.onExit(() => { output.write(SHOW_CURSOR); });
    // Shared by SIGINT and Ctrl+C inside an arrow-key menu; a drawn activity line is cleared first.
    const stop = () => {
      if (run !== null) run.clearActivity();
      print('');
      print(STOPPED);
      deps.exit(130);
    };
    deps.onInterrupt(stop);
    const interactive = canReadKeys({ input, output, env: deps.env });
    ask = deps.createPrompt({ input, output, style, interactive, onInterrupt: stop, format });
    run = deps.createRunner({
      root: deps.root, cwd, env: hookVisibleEnv(deps.env), sessionKeys: SESSION_KEYS, paint: format,
      output, activity: output.isTTY === true && deps.env.TERM !== 'dumb', margin: MARGIN, accent: style.accent,
    });
    const progress = (label) => { run.setLabel(label); };
    const envToken = copilotAuthEnv(deps.env).envToken;
    const notices = HIDDEN_TOKEN_VARS.indexOf(envToken) !== -1 ? [hiddenTokenLine(envToken)] : [];
    done = deps.runSetup({ run, ask, print, progress, style, notices, env: deps.env, platform: deps.platform });
  } catch (error) {
    if (ask !== null) ask.close();
    print(`✗ ${friendlyMessage(error)}`);
    return Promise.resolve(1);
  }
  return done
    .catch((error) => {
      print(`✗ ${friendlyMessage(error)}`);
      return 1;
    })
    .then((code) => {
      ask.close();
      return code;
    });
}
