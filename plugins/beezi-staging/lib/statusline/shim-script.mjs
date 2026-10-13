// The status-line shim's text (sh and PowerShell) and the settings command that runs it; pure.
import path from 'path';

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// PowerShell treats U+2018-U+201B as single quotes too, so each is doubled like '.
const psQuote = (s) => `'${String(s).replace(/['‘-‛]/g, '$&$&')}'`;
// A plain path stays bare so existing settings entries still match; anything else is single-quoted.
export const shCommandPath = (s) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : shQuote(s));

// `scripts` is captureScriptPaths()' { glob, shGlob, current }.
export function shShimContent(chainCommand, scripts) {
  const { shGlob, current } = scripts;
  const chainEnv = chainCommand ? `BEEZI_STATUSLINE_CHAIN=${shQuote(chainCommand)} ` : '';
  // Degraded modes never blank a status line the user already had: no node or no plugin
  // falls back to running the chained command directly (or printing nothing if there was none).
  const fallback = chainCommand ? `printf '%s' "$input" | ${chainCommand}` : ':';
  return `#!/bin/sh
# Beezi status line shim — installed by /beezi-staging-settings. Records the model, context use and allow-all state
# Copilot hands every render, then draws your previous status line unchanged.
# Remove with: /beezi-staging-settings statusline off, or node <plugin>/scripts/statusline-install.mjs --uninstall
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

export function psShimContent(chainCommand, scripts) {
  const { glob, current } = scripts;
  return `# Beezi status line shim — installed by /beezi-staging-settings. Records the model, context use and allow-all state
# Copilot hands every render, then draws your previous status line unchanged.
# Remove with: /beezi-staging-settings statusline off, or node <plugin>/scripts/statusline-install.mjs --uninstall
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
export const withBom = (text) => `﻿${text}`;

// A bare `powershell.exe` resolves against the child's current directory first (same hijack
// credential-backends.mjs pins against), so the settings command names the System32 binary outright. A path with no
// space stays unquoted, which cmd, PowerShell and sh all run: to PowerShell a line starting with a quoted string is an
// expression, not a command.
export function windowsShimCommand(shim, env) {
  const ps = env.SystemRoot
    ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return `${/\s/.test(ps) ? `"${ps}"` : ps} -NoProfile -ExecutionPolicy Bypass -File "${shim}"`;
}

// The chained status line as Copilot would run it: Copilot expands a leading `~` and `$VAR` / `${VAR}` itself, which
// cmd.exe (the Windows shell this chain runs under) never does. Elsewhere sh expands both, so the command is unchanged.
export function expandChainCommand(command, { platform = process.platform, env = process.env, home = '' } = {}) {
  if (platform !== 'win32' || typeof command !== 'string') return command;
  return command
    .replace(/(^|[\s"'])~(?=[\\/]|$|[\s"'])/g, (m, lead) => `${lead}${home}`)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, bare) => {
      const value = env[braced || bare];
      return typeof value === 'string' ? value : m;
    });
}
