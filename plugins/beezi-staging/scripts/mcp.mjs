// Stdio MCP entry: bridges to the portal with the stored login (logic in lib/mcp/server.mjs and lib/mcp/bridge.mjs)
// and hosts the session watcher. Stdout carries JSON-RPC only.
import { startMcpServer } from '../lib/mcp/server.mjs';
import { isWatcherEnabled } from '../lib/config/flags.mjs';

if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
// Marks this process for lib/sessions.mjs: its copy of the session-id variable can outlive /clear and /new.
process.env.BEEZI_PROCESS_ROLE = 'mcp';

// The watcher's own disable rule, checked here so the module is not even imported when it is off.
startMcpServer({ loadWatcher: isWatcherEnabled(process.env) ? () => import('../lib/mcp/watcher.mjs') : null });
