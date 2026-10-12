import os from 'os';
import { domainToASCII } from 'url';
import { readPluginManifest } from '../config/plugin-root.mjs';

let cachedVersion;

// The INSTALLED version, from plugin.json — the file make-variant.sh rewrites, so a
// dev build reports 0.17.0-dev.4938 rather than package.json's base 0.17.0. Read once per process:
// machineHeaders() runs on every authenticated request.
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  const version = readPluginManifest().version;
  cachedVersion = version ? version.slice(0, 255) : null;
  return cachedVersion;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// A header-safe host name: printable ASCII unchanged, else punycode, else percent-encoded.
export function headerSafeHost(name) {
  const text = String(name);
  if (PRINTABLE_ASCII.test(text)) return text;
  const punycode = domainToASCII(text);
  return punycode !== '' && PRINTABLE_ASCII.test(punycode) ? punycode : encodeURIComponent(text);
}

// The machine name the portal lists: a Codespace keeps its name across rebuilds, the OS hostname does not.
export function machineName(env = process.env, hostname = os.hostname()) {
  const codespace = env.CODESPACES === 'true' ? env.CODESPACE_NAME : '';
  return headerSafeHost(codespace || hostname).slice(0, 255);
}

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token). X-Beezi-Agent picks the tool axis for the
// backfill scope and analytics source — the server defaults an absent header to
// claude-code, but explicit beats implicit. X-Beezi-Plugin-Version is stored on the
// machine row; absent when the manifest cannot be read.
export function machineHeaders(clientId) {
  const headers = {
    'X-Beezi-Agent': 'copilot',
    'X-Beezi-Host': machineName(),
  };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  const version = pluginVersion();
  if (version) headers['X-Beezi-Plugin-Version'] = version;
  return headers;
}
