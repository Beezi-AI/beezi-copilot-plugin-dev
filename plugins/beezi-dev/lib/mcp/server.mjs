// The stdio MCP server: JSON-RPC lines between stdin/stdout and the bridge, and the watcher's lifetime.
import readline from 'readline';
import { createBridge } from './bridge.mjs';
import { appendWatcherLog } from './watcher-log.mjs';
import { isProbeSession } from './probe-session.mjs';

// `loadWatcher` is null when the watcher is off, so the caller decides whether its module is imported at all.
// A Copilot app probe session gets no watcher and handshakes with the portal only when a request needs it.
export function startMcpServer({ loadWatcher, probe = isProbeSession() }) {
  const bridge = createBridge({ write: (line) => process.stdout.write(`${line}\n`), lazyHandshake: probe });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => { void bridge.handleLine(line); });

  let stdinClosed = false;
  let stopWatcher = null;
  if (loadWatcher != null && !probe) {
    // Deferred until the stdin reader is serving, so a slow or broken watcher never delays the handshake.
    setImmediate(() => {
      if (stdinClosed) return;
      loadWatcher()
        .then((mod) => { if (!stdinClosed) stopWatcher = mod.startWatcher({ log: appendWatcherLog }); })
        .catch((error) => appendWatcherLog(`watcher disabled: ${error && error.message ? error.message : error}`));
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
  process.on('unhandledRejection', (error) => appendWatcherLog(`unhandled rejection: ${error && error.message ? error.message : error}`));
}
