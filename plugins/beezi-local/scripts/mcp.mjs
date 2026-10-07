// Stdio MCP entry: bridges to the portal with the stored login (logic in lib/mcp-bridge.mjs) and hosts the session
// watcher. Stdout carries JSON-RPC only.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createBridge } from '../lib/mcp-bridge.mjs';
import { beeziHome } from '../lib/paths.mjs';

if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
// Marks this process for lib/sessions.mjs: its copy of the session-id variable can outlive /clear and /new.
process.env.BEEZI_PROCESS_ROLE = 'mcp';

// Mirrors the watcher's own disable rule, so the module is not even imported when it is off.
const WATCHER_OFF = ['0', 'false', 'no', 'off', 'disabled'];
const logToFile = (msg) => {
  try {
    const file = path.join(beeziHome(), 'logs', 'watcher.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* the watcher log never reaches stdout or stderr */ }
};

const bridge = createBridge({ write: (line) => process.stdout.write(`${line}\n`) });
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { void bridge.handleLine(line); });

let stdinClosed = false;
let stopWatcher = null;
const watcherValue = String(process.env.BEEZI_COPILOT_WATCHER == null ? '' : process.env.BEEZI_COPILOT_WATCHER);
if (WATCHER_OFF.indexOf(watcherValue.trim().toLowerCase()) === -1) {
  // Deferred until the stdin reader is serving, so a slow or broken watcher never delays the handshake.
  setImmediate(() => {
    if (stdinClosed) return;
    import('../lib/session-watcher.mjs')
      .then((mod) => { if (!stdinClosed) stopWatcher = mod.startWatcher({ log: logToFile }); })
      .catch((error) => logToFile(`watcher disabled: ${error && error.message ? error.message : error}`));
  });
}

const shutdown = () => {
  stdinClosed = true;
  try { if (typeof stopWatcher === 'function') stopWatcher(); } catch { /* exiting anyway */ }
  process.exit(0);
};
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
// A stdio server that dies is not restarted, and the watcher and the engine now run inside this process: a stray rejection must not end it.
process.on('unhandledRejection', (error) => logToFile(`unhandled rejection: ${error && error.message ? error.message : error}`));
