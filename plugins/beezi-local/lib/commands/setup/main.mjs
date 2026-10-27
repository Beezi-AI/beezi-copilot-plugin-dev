// The terminal setup's entry: the terminal, the prompt and the runner, then the wizard and the finale or the stop line.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { friendlyMessage } from '../../core/errors.mjs';
import { finaleLines } from '../../ux/setup/finale.mjs';
import { canReadKeys, colorEnabled, createStyle, formatLine, formatOfferLine, paint } from '../../ux/setup/style.mjs';
import { createPrompt, openTerminal } from './prompt.mjs';
import { createRunner } from './runner.mjs';
import { runSetup } from './wizard.mjs';

// Copilot's session id: removed from the children's environment, so no script binds this run to a session.
export const SESSION_KEYS = ['COPILOT_AGENT_SESSION_ID'];
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Run /beezi-local-login in Copilot instead.';
export const STOPPED = 'Setup stopped. Run the installer again, or /beezi-local-login in Copilot, to finish.';
const AGENT = 'GitHub Copilot';
const SHOW_CURSOR = '\x1b[?25h';

export function realDeps(root) {
  return {
    root,
    env: process.env,
    platform: process.platform,
    output: process.stdout,
    random: Math.random,
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

// Runs the wizard on the terminal and resolves its exit code.
export function setupMain(deps) {
  const output = deps.output;
  const style = createStyle({ enabled: colorEnabled({ stream: output, env: deps.env }) });
  // Wrapped to the width on a terminal; a log keeps each line whole.
  const format = (line) => (output.isTTY ? formatLine(style, line, output.columns || 80) : paint(style, line));
  const print = (line) => { output.write(`${format(line)}\n`); };
  const printOffer = (line) => { output.write(`${formatOfferLine(style, line, output.isTTY ? output.columns || 80 : null)}\n`); };
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
    ask = deps.createPrompt({ input, output, style, interactive, onInterrupt: stop });
    run = deps.createRunner({
      root: deps.root, cwd, env: deps.env, sessionKeys: SESSION_KEYS, paint: format,
      output, activity: output.isTTY === true && deps.env.TERM !== 'dumb',
    });
    const progress = (label) => { run.setLabel(label); };
    done = deps.runSetup({ run, ask, print, printOffer, progress, env: deps.env, platform: deps.platform });
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
      if (code === 0) {
        finaleLines({ agent: AGENT, style, columns: output.columns || 80, random: deps.random })
          .forEach((line) => { output.write(`${line}\n`); });
      }
      return code;
    });
}
