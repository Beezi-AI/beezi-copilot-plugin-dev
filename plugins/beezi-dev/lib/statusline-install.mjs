import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beeziHome } from './paths.mjs';
import { copilotSettingsFile, copilotInstalledPluginsDir } from './copilot-paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { checkInteractive } from './mode-guard.mjs';

// Installs the status-line wrapper that feeds lib/statusline-snapshot.mjs. Copilot has no plugin component
// for status lines, so the capture only exists once `settings.json → statusLine` points at a script of ours. That
// is a USER setting — this module only runs from /beezi-dev-settings after the user agrees.
//
// The wrapper is a tiny shim at a STABLE path (beeziHome()) — sh on macOS/Linux, PowerShell on
// Windows — so the settings entry never depends on where the plugin is installed. The shim runs the install
// that recorded it, else the newest installed copy, and chains the status line the user
// already had, byte-for-byte (statusline.mjs runs the chain via BEEZI_STATUSLINE_CHAIN).

export function statuslineShimFile(platform = process.platform) {
  return path.join(beeziHome(), platform === 'win32' ? 'statusline.ps1' : 'statusline.sh');
}

// The statusLine object that was replaced, kept for uninstall: { statusLine: <object|null> }.
function originalFile(home = beeziHome()) {
  return path.join(home, 'statusline-original.json');
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// PowerShell treats U+2018-U+201B as single quotes too, so each is doubled like '.
const psQuote = (s) => `'${String(s).replace(/['\u2018-\u201B]/g, '$&$&')}'`;
// A plain path stays bare so existing settings entries still match; anything else is single-quoted.
const shCommandPath = (s) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : shQuote(s));

// The file path of any Copilot-plugin variant's shim (~/.beezi-copilot/statusline.sh, ~/.beezi-copilot-dev/
// statusline.ps1, the path quoted after -File in a powershell.exe invocation), or null when the command is not one
// of ours. Only `.beezi-copilot*` homes match: another Beezi plugin's shim is never chained, adopted or removed.
// A shim is never chained either — wrapping a wrapper would stack captures on every re-install — so its home is
// where the status line it replaced is on record instead.
const beeziShimPath = (command) => {
  if (typeof command !== 'string') return null;
  const m = command.match(/(?:^|["\s])([^"]*?[/\\]\.beezi-copilot[^/\\]*[/\\]statusline\.(?:sh|ps1))(?:"|$)/)
    || command.match(/(?:^|\s)'([^']*?[/\\]\.beezi-copilot[^/\\]*[/\\]statusline\.sh)'/);
  return m == null ? null : m[1];
};

const commandUsesShim = (command, shim) => typeof command === 'string'
  && (command.includes(shim) || command.includes(shQuote(shim)));

// The command object's statusline command string, or null when it is not a command statusLine.
function commandOf(statusLine) {
  if (statusLine == null || statusLine.type !== 'command') return null;
  return typeof statusLine.command === 'string' ? statusLine.command : null;
}

// Walks shims back to the status line the user actually wrote: a variant's shim stands for
// whatever ITS home has on record, which on a machine running several variants can be another
// shim again. `visited` stops a pair of variants that point at each other from looping. ourShim
// is matched by path, so a BEEZI_COPILOT_HOME outside the usual ~/.beezi-copilot* naming still resolves.
function resolveOriginal(statusLine, visited, ourShim) {
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

// Where the capture script lives: the install that recorded the shim, else the newest copy under
// installed-plugins/<marketplace>/<plugin>/ (plugin name baked in: variants differ), else the chained command alone.
function captureScriptPaths(deps) {
  const self = deps.selfPath == null ? fileURLToPath(import.meta.url) : deps.selfPath;
  const pluginRoot = path.dirname(path.dirname(self));
  const manifest = readJson(path.join(pluginRoot, 'plugin.json'), null);
  const pluginName = manifest != null && typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : 'beezi';
  const installed = copilotInstalledPluginsDir();
  return {
    glob: path.join(installed, '*', pluginName, 'scripts', 'statusline.mjs'),
    // Only the `*` stays unquoted, so a folder with a space in its name still expands to one path.
    shGlob: `${shQuote(installed)}/*/${shQuote(pluginName)}/scripts/statusline.mjs`,
    current: path.join(pluginRoot, 'scripts', 'statusline.mjs'),
  };
}

function shShimContent(chainCommand, deps) {
  const { shGlob, current } = captureScriptPaths(deps);
  const chainEnv = chainCommand ? `BEEZI_STATUSLINE_CHAIN=${shQuote(chainCommand)} ` : '';
  // Degraded modes never blank a status line the user already had: no node or no plugin
  // falls back to running the chained command directly (or printing nothing if there was none).
  const fallback = chainCommand ? `printf '%s' "$input" | ${chainCommand}` : ':';
  return `#!/bin/sh
# Beezi status line shim — installed by /beezi-dev-settings. Records the model, context use and allow-all state
# Copilot hands every render, then draws your previous status line unchanged.
# Remove with: /beezi-dev-settings statusline off, or node <plugin>/scripts/statusline-install.mjs --uninstall
input=$(cat)
script=${shQuote(current)}
[ -f "$script" ] || script=$(ls -t ${shGlob} 2>/dev/null | head -n 1)
if [ -n "$script" ] && [ -f "$script" ] && command -v node >/dev/null 2>&1; then
  printf '%s' "$input" | ${chainEnv}node "$script"
else
  ${fallback}
fi
`;
}

function psShimContent(chainCommand, deps) {
  const { glob, current } = captureScriptPaths(deps);
  return `# Beezi status line shim — installed by /beezi-dev-settings. Records the model, context use and allow-all state
# Copilot hands every render, then draws your previous status line unchanged.
# Remove with: /beezi-dev-settings statusline off, or node <plugin>/scripts/statusline-install.mjs --uninstall
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$in = [Console]::In.ReadToEnd()
$chain = ${psQuote(chainCommand == null ? '' : chainCommand)}
$script = ${psQuote(current)}
if (-not (Test-Path $script)) {
  $found = Get-ChildItem -Path ${psQuote(glob)} -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $script = if ($found) { $found.FullName } else { '' }
}
if ($script -and (Test-Path $script) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  if ($chain) { $env:BEEZI_STATUSLINE_CHAIN = $chain }
  $in | node $script
} elseif ($chain) {
  $in | & $env:ComSpec /c $chain
}
`;
}

// A leading U+FEFF writes the UTF-8 BOM that makes Windows PowerShell 5.1 read the .ps1 as UTF-8, not ANSI.
const withBom = (text) => `\ufeff${text}`;

// A bare `powershell.exe` resolves against the child's current directory first (same hijack
// credential-backends.mjs pins against), so the settings command names the System32 binary outright.
function windowsShimCommand(shim, env) {
  const ps = env.SystemRoot
    ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return `"${ps}" -NoProfile -ExecutionPolicy Bypass -File "${shim}"`;
}

// { settings } for a missing file ({}) or a plain-JSON object; { error: 'not-json' } for JSONC or any other parse
// failure, { error: 'unreadable' } when the file cannot be read.
function readSettings() {
  const file = copilotSettingsFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    return e != null && e.code === 'ENOENT' ? { settings: {} } : { error: 'unreadable' };
  }
  if (text.trim() === '') return { settings: {} };
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { settings: parsed } : { error: 'not-json' };
  } catch {
    return { error: 'not-json' };
  }
}

// settings.json is the user's own file: pretty-printed, written atomically so a crash can never leave Copilot
// with half a config. A symlink is written THROUGH (temp file beside the target, renamed onto it, permission
// bits kept), so the link stays.
function writeSettings(settings) {
  const file = copilotSettingsFile();
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* no file yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: default permissions */ }
  const tmp = `${target}.beezi-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  if (mode != null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

function settingsProblem(error, file) {
  return error === 'not-json'
    ? `Beezi: ${file} contains comments or is not plain JSON, so Beezi will not rewrite it.`
    : `Beezi: could not read ${file} — status line left untouched.`;
}

// Refuses when nobody may be answering: an autopilot answer is not consent to change a user setting.
function refusal(deps) {
  const verdict = (deps.checkInteractive == null ? checkInteractive : deps.checkInteractive)({ purpose: 'changing your status line', requireWrite: true });
  return verdict != null && verdict.ok === false ? { ok: false, message: verdict.message } : null;
}

// Returns { ok, message }. Never throws for expected failures.
export function installStatusline(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const env = deps.env == null ? process.env : deps.env;

  const refused = refusal(deps);
  if (refused != null) return refused;

  const file = copilotSettingsFile();
  const { settings, error } = readSettings();
  const shim = statuslineShimFile(platform);
  const command = platform === 'win32' ? windowsShimCommand(shim, env) : shCommandPath(shim);
  if (error === 'not-json') {
    // The shim is written anyway (nothing to chain: the line in that file cannot be read) so the snippet below works.
    fs.mkdirSync(beeziHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(shim, platform === 'win32' ? withBom(psShimContent(null, deps)) : shShimContent(null, deps));
    if (platform !== 'win32') fs.chmodSync(shim, 0o755);
    const snippet = `  "statusLine": ${JSON.stringify({ type: 'command', command })}`;
    return { ok: false, message: `${settingsProblem(error, file)} Add this yourself:\n${snippet}` };
  }
  if (error) return { ok: false, message: settingsProblem(error, file) };

  const current = settings.statusLine;
  const currentCommand = commandOf(current);
  const alreadyOurs = commandUsesShim(currentCommand, shim);

  // Re-install keeps the ORIGINAL original, and installing over another variant's shim inherits
  // the record that shim stands for; falling back to the siblings recovers a line an install
  // from before this resolution existed dropped on the floor.
  const visited = new Set();
  const ours = readJson(originalFile());
  let original = resolveOriginal(current, visited, shim);
  if (original == null) original = resolveOriginal(ours == null ? null : ours.statusLine, visited, shim);
  if (original == null) {
    for (const record of siblingRecords()) {
      original = resolveOriginal(record, visited, shim);
      if (original != null) break;
    }
  }
  const chain = commandOf(original);

  fs.mkdirSync(beeziHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(shim, platform === 'win32' ? withBom(psShimContent(chain, deps)) : shShimContent(chain, deps));
  if (platform !== 'win32') fs.chmodSync(shim, 0o755);

  if (ours == null || !alreadyOurs) {
    writeJsonSecure(originalFile(), { statusLine: original });
  }

  if (alreadyOurs) {
    return { ok: true, message: 'Beezi: status line already installed.' };
  }
  settings.statusLine = {
    type: 'command',
    command,
    ...(current != null && typeof current.padding === 'number' ? { padding: current.padding } : {}),
  };
  writeSettings(settings);

  return chain
    ? { ok: true, message: 'Beezi: status line wrapped — your existing status line still renders unchanged.' }
    : { ok: true, message: 'Beezi: status line installed — it records model, context use and allow-all state for Beezi and shows folder · model · context.' };
}

// True when this machine took the wrapper but its status line no longer runs one. Copilot's own /statusline
// (and any hand-edit) replaces settings.json → statusLine outright, and nothing here re-installs: the capture
// just stops, with no symptom the user could connect to it. Detecting it is all we do — re-writing a status-line
// setting the user changed on purpose is exactly the consent this module is careful about, so the
// caller nudges and the fix stays /beezi-dev-settings statusline on.
//
// Never installed (or properly uninstalled) reads as fine: only a machine that agreed once is
// owed the notice. Another variant's shim also reads as fine — the capture is running, just not
// out of this home.
export function statuslineCaptureDetached(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  if (readJson(originalFile()) == null) return false;
  const { settings, error } = readSettings();
  if (error) return false;
  const command = commandOf(settings.statusLine);
  if (commandUsesShim(command, statuslineShimFile(platform))) return false;
  return beeziShimPath(command) == null;
}

// True when settings.json → statusLine runs our shim or any Copilot-plugin variant's.
export function statuslineInstalled(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const { settings, error } = readSettings();
  if (error) return false;
  const command = commandOf(settings.statusLine);
  return commandUsesShim(command, statuslineShimFile(platform)) || beeziShimPath(command) != null;
}

// Puts back whatever /beezi-dev-settings replaced, but only while settings still point at our shim —
// a status line the user changed since is theirs, not ours to touch.
export function uninstallStatusline(deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const refused = refusal(deps);
  if (refused != null) return refused;
  const { settings, error } = readSettings();
  if (error) {
    return { ok: false, message: `${settingsProblem(error, copilotSettingsFile())} Nothing was restored.` };
  }
  const shim = statuslineShimFile(platform);
  const pointsAtUs = commandUsesShim(commandOf(settings.statusLine), shim);

  if (pointsAtUs) {
    const stored = readJson(originalFile());
    const orig = resolveOriginal(stored == null ? null : stored.statusLine, new Set(), shim);
    if (orig) settings.statusLine = orig;
    else delete settings.statusLine;
    writeSettings(settings);
  }
  try { fs.unlinkSync(shim); } catch { /* already absent */ }
  try { fs.unlinkSync(originalFile()); } catch { /* already absent */ }
  return {
    ok: true,
    message: pointsAtUs
      ? 'Beezi: status line restored.'
      : 'Beezi: status line was not ours to restore — shim removed, settings left untouched.',
  };
}
