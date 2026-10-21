import { pluginRoot } from '../lib/config/plugin-root.mjs';
import { realDeps, setupMain } from '../lib/commands/setup/main.mjs';

// The terminal setup the one-line installers run after the install: node <plugin root>/scripts/setup.mjs
setupMain(realDeps(pluginRoot())).then((code) => {
  process.exit(code);
});
