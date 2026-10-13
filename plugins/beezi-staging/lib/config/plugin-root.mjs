import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The only module that knows its own folder depth: every other plugin file reaches the root through it.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function pluginRoot() {
  return ROOT;
}

export function pluginFile(name) {
  return path.join(ROOT, name);
}

export function scriptPath(name) {
  return path.join(ROOT, 'scripts', name);
}

// plugin.json's name and version, each null unless a string; read on every call, never cached.
export function readPluginManifest(root = ROOT) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); } catch { /* reads as absent */ }
  const text = (key) => (manifest != null && typeof manifest[key] === 'string' ? manifest[key] : null);
  return { name: text('name'), version: text('version') };
}
