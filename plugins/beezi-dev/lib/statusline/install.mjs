// Installs, detects and removes the status-line wrapper in the user's Copilot settings.json.
import fs from 'fs';
import { beeziHome } from '../config/paths.mjs';
import { copilotSettingsFile } from '../config/copilot-paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { checkInteractive } from '../host/mode-guard.mjs';
import { commandOf, readSettings, settingsProblem, writeSettings } from './copilot-settings.mjs';
import { psShimContent, shCommandPath, shShimContent, windowsShimCommand, withBom } from './shim-script.mjs';
import {
  beeziShimPath,
  captureScriptPaths,
  commandUsesShim,
  originalFile,
  recordedOriginal,
  resolveOriginal,
  statuslineShimFile,
} from './shim-records.mjs';

// Installs the status-line wrapper that feeds lib/statusline-snapshot.mjs. Copilot has no plugin component
// for status lines, so the capture only exists once `settings.json → statusLine` points at a script of ours. That
// is a USER setting — this module only runs from /beezi-dev-settings after the user agrees.
//
// The wrapper is a tiny shim at a STABLE path (beeziHome()) — sh on macOS/Linux, PowerShell on
// Windows — so the settings entry never depends on where the plugin is installed. The shim runs the install
// that recorded it, else the newest installed copy, and chains the status line the user
// already had, byte-for-byte (statusline.mjs runs the chain via BEEZI_STATUSLINE_CHAIN).

// Writes the shim for `platform`, chaining `chain` (a command string, or null for none).
function writeShim(shim, platform, chain, deps) {
  const scripts = captureScriptPaths(deps);
  fs.mkdirSync(beeziHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(shim, platform === 'win32' ? withBom(psShimContent(chain, scripts)) : shShimContent(chain, scripts));
  if (platform !== 'win32') fs.chmodSync(shim, 0o755);
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

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
    writeShim(shim, platform, null, deps);
    const snippet = `  "statusLine": ${JSON.stringify({ type: 'command', command })}`;
    return { ok: false, message: `${settingsProblem(error, file)} Add this yourself:\n${snippet}` };
  }
  if (error) return { ok: false, message: settingsProblem(error, file) };

  const current = settings.statusLine;
  const currentCommand = commandOf(current);
  const alreadyOurs = commandUsesShim(currentCommand, shim);

  const ours = readJson(originalFile());
  const original = recordedOriginal(current, ours, shim);
  const chain = commandOf(original);
  writeShim(shim, platform, chain, deps);

  if (ours == null || !alreadyOurs) {
    writeJsonSecure(originalFile(), { statusLine: original });
  }

  // An entry already ours is rewritten only to bring its command up to date (an older install quoted the PowerShell path).
  if (alreadyOurs && currentCommand === command) {
    return { ok: true, message: 'Beezi: status line already installed.' };
  }
  // Every other key of the user's entry (padding, refreshInterval, …) is kept as it was.
  settings.statusLine = { ...(isPlainObject(current) ? current : {}), type: 'command', command };
  writeSettings(settings);
  if (alreadyOurs) return { ok: true, message: 'Beezi: status line already installed.' };

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
