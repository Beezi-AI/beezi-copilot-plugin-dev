// Which installed Copilot plugin ships each MCP server, from <copilot home>/installed-plugins/<marketplace>/<plugin>/mcp.json.
import fs from 'fs';
import path from 'path';
import { copilotInstalledPluginsDir } from '../config/copilot-paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { isPlain } from '../core/guards.mjs';

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// { serverKey: pluginName } over every installed plugin's mcpServers; the first plugin in name order keeps a shared key.
// Never throws: a missing folder or an unreadable mcp.json contributes nothing.
export function mcpPluginByServer(root = copilotInstalledPluginsDir()) {
  const out = {};
  for (const marketplace of subdirs(root)) {
    for (const plugin of subdirs(path.join(root, marketplace))) {
      const config = readJson(path.join(root, marketplace, plugin, 'mcp.json'), null);
      const servers = isPlain(config) && isPlain(config.mcpServers) ? config.mcpServers : {};
      for (const key of Object.keys(servers)) if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = plugin;
    }
  }
  return out;
}
