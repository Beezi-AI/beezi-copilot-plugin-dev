// Where the shim and its record of the replaced status line live, and how a shim chain resolves back to the original.
import fs from 'fs';
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { pluginRoot, readPluginManifest } from '../config/plugin-root.mjs';
import { copilotInstalledPluginsDir } from '../config/copilot-paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { commandOf } from './copilot-settings.mjs';
import { shQuote } from './shim-script.mjs';

export function statuslineShimFile(platform = process.platform) {
  return path.join(beeziHome(), platform === 'win32' ? 'statusline.ps1' : 'statusline.sh');
}

// The statusLine object that was replaced, kept for uninstall: { statusLine: <object|null> }.
export function originalFile(home = beeziHome()) {
  return path.join(home, 'statusline-original.json');
}

// The file path of any Copilot-plugin variant's shim (~/.beezi-copilot/statusline.sh, ~/.beezi-copilot-dev/
// statusline.ps1, the path quoted after -File in a powershell.exe invocation), or null when the command is not one
// of ours. Only `.beezi-copilot*` homes match: another Beezi plugin's shim is never chained, adopted or removed.
// A shim is never chained either — wrapping a wrapper would stack captures on every re-install — so its home is
// where the status line it replaced is on record instead.
export const beeziShimPath = (command) => {
  if (typeof command !== 'string') return null;
  const m = command.match(/(?:^|["\s])([^"]*?[/\\]\.beezi-copilot[^/\\]*[/\\]statusline\.(?:sh|ps1))(?:"|$)/)
    || command.match(/(?:^|\s)'([^']*?[/\\]\.beezi-copilot[^/\\]*[/\\]statusline\.sh)'/);
  return m == null ? null : m[1];
};

export const commandUsesShim = (command, shim) => typeof command === 'string'
  && (command.includes(shim) || command.includes(shQuote(shim)));

// Walks shims back to the status line the user actually wrote: a variant's shim stands for
// whatever ITS home has on record, which on a machine running several variants can be another
// shim again. `visited` stops a pair of variants that point at each other from looping. ourShim
// is matched by path, so a BEEZI_COPILOT_HOME outside the usual ~/.beezi-copilot* naming still resolves.
export function resolveOriginal(statusLine, visited, ourShim) {
  let line = statusLine;
  while (line != null) {
    const command = commandOf(line);
    const shim = commandUsesShim(command, ourShim) ? ourShim : beeziShimPath(command);
    if (shim == null) return line;
    if (visited.has(shim)) return null;
    visited.add(shim);
    const stored = readJson(originalFile(path.dirname(shim)));
    line = stored == null ? null : stored.statusLine;
  }
  return null;
}

// Records kept by the other Copilot-plugin variants installed on this machine. A variant that installed over
// another one's shim before this resolution existed left no record of its own, so a sibling's is the only
// surviving copy of the line the user had.
function siblingRecords() {
  const home = beeziHome();
  const parent = path.dirname(home);
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('.beezi-copilot') && path.join(parent, name) !== home)
    .map((name) => readJson(originalFile(path.join(parent, name))))
    .filter((stored) => stored != null)
    .map((stored) => stored.statusLine);
}

// The line an install chains: re-install keeps the ORIGINAL original, and installing over another variant's shim
// inherits the record that shim stands for; falling back to the siblings recovers a line an install from before
// this resolution existed dropped on the floor. `ours` is this home's record, or null.
export function recordedOriginal(current, ours, shim) {
  const visited = new Set();
  let original = resolveOriginal(current, visited, shim);
  if (original == null) original = resolveOriginal(ours == null ? null : ours.statusLine, visited, shim);
  if (original == null) {
    for (const record of siblingRecords()) {
      original = resolveOriginal(record, visited, shim);
      if (original != null) break;
    }
  }
  return original;
}

// Where the capture script lives: the install that recorded the shim, else the newest copy under
// installed-plugins/<marketplace>/<plugin>/ (plugin name baked in: variants differ), else the chained command alone.
export function captureScriptPaths(deps) {
  const root = deps.pluginRoot == null ? pluginRoot() : deps.pluginRoot;
  const pluginName = readPluginManifest(root).name || 'beezi';
  const installed = copilotInstalledPluginsDir();
  return {
    glob: path.join(installed, '*', pluginName, 'scripts', 'statusline.mjs'),
    // Only the `*` stays unquoted, so a folder with a space in its name still expands to one path.
    shGlob: `${shQuote(installed)}/*/${shQuote(pluginName)}/scripts/statusline.mjs`,
    current: path.join(root, 'scripts', 'statusline.mjs'),
  };
}
