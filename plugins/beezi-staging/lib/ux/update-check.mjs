import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { pluginRoot, readPluginManifest } from '../config/plugin-root.mjs';
import { updateCheckFile } from '../config/paths.mjs';
import { updateManifestUrl } from '../config/api.mjs';
import { getJson } from '../platform/http.mjs';
import { compareVersions, isNewer } from '../core/version.mjs';

// Exported so test/update-check.test.mjs seeds cache records with it rather than hard-coding a
// number that a later bump would silently desync.
export const STATE_VERSION = 1;

// How long a fetched manifest reading is trusted. One hour: internal builds publish several
// times a day, so a longer window would hide the very updates this exists to surface.
const FRESH_MS = 60 * 60 * 1000;

// Tighter than postJson's 3s default: this runs inline on SessionStart, whose whole budget is 10s. raw.githubusercontent.com is a CDN — an
// answer slower than this is not coming, and the nudge simply waits for the next session.
const FETCH_TIMEOUT_MS = 1500;

// The nudge is a line the model relays, and both values come from remote JSON: only plain characters pass.
const MARKETPLACE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,64}$/;
const isPlain = (pattern, value) => typeof value === 'string' && pattern.test(value);

// The INSTALLED identity, from plugin.json — the file make-variant.sh rewrites.
// Deliberately NOT package.json: make-variant.sh leaves that at the base version, so on a dev
// build package.json says 0.17.0 while the plugin installed is 0.17.0-dev.4938. Comparing against
// package.json would nag every internal machine forever.
export function readLocalPlugin(deps = {}) {
  if (deps.localPlugin != null) return deps.localPlugin;
  const { name, version } = readPluginManifest(deps.pluginRoot == null ? pluginRoot() : deps.pluginRoot);
  if (!name || !version) return null;
  return { name: name, version: version };
}

export function readUpdateCheck(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(updateCheckFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeUpdateCheck(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    write(updateCheckFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

// Keyed on time ALONE, and that is safe only because the record holds the remote FACTS and never
// a verdict: an update the user has since installed is caught by re-comparing on read.
function isFresh(cached, nowMs) {
  if (cached == null) return false;
  const at = Date.parse(cached.checkedAt == null ? '' : cached.checkedAt);
  if (Number.isNaN(at)) return false;
  // Second clause: a stamp from the future is a clock change, not a fresh reading.
  return nowMs - at <= FRESH_MS && at <= nowMs;
}

// Matched on plugin.json's OWN name — beezi / beezi-dev / beezi-staging. That is the same string
// sync-to-github.sh copies into the entry it upserts, so the two are in lockstep by construction.
function findEntry(manifest, pluginName) {
  if (manifest == null || typeof manifest !== 'object') return null;
  if (!Array.isArray(manifest.plugins)) return null;
  for (const entry of manifest.plugins) {
    if (entry == null || entry.name !== pluginName) continue;
    if (typeof entry.version !== 'string') return null;
    return {
      latestVersion: entry.version,
      // What `copilot plugin marketplace update <marketplace>` wants, and the manifest already
      // carries it — so dev/staging need no config beyond the URL.
      marketplaceName: typeof manifest.name === 'string' ? manifest.name : null,
    };
  }
  return null;
}

async function fetchRemote(pluginName, nowIso, deps) {
  // `=== undefined`, NOT `== null`. Once env.json carries the prod URL, updateManifestUrl() always
  // returns a string, so a `== null` check would leave tests no way to express "no URL configured"
  // — they would silently fall through to the real one and hit the network. An explicit
  // `manifestUrl: null` must mean absent.
  const url = deps.manifestUrl === undefined ? updateManifestUrl() : deps.manifestUrl;
  // No URL is the normal state of an older variant build; a non-https one is a misconfiguration.
  // Neither is an observation about the installed version.
  if (typeof url !== 'string' || url.slice(0, 8) !== 'https://') return null;
  try {
    const body = await getJson(url, { fetchImpl: deps.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS });
    const found = findEntry(body, pluginName);
    if (found == null) return null;
    const record = {
      checkedAt: nowIso,
      pluginName: pluginName,
      latestVersion: found.latestVersion,
      marketplaceName: found.marketplaceName,
    };
    writeUpdateCheck(record, deps);
    return record;
  } catch {
    return null;   // offline, timed out, rate-limited, 404, or a body that is not JSON
  }
}

// The two terminal commands that update this plugin, in order: shared by the SessionStart nudge and /beezi-staging-status
// so both always name the same steps. null when the manifest names no usable marketplace.
export function updateCommands(pluginName, marketplaceName) {
  if (!isPlain(MARKETPLACE_NAME, marketplaceName)) return null;
  return [`copilot plugin marketplace update ${marketplaceName}`, `copilot plugin update ${pluginName}`];
}

// The last step of every update hint: the session-start notice, /beezi-staging-status and /beezi-staging-release-notes.
export const APPLY_UPDATE = 'restart Copilot to apply it';

// Names the exact commands: "update the plugin" is not actionable without knowing which
// marketplace it came from. A manifest with no name leaves no command to name, so the interactive
// menu is offered rather than printing `beezi-dev@undefined`.
export function composeNudge(local, record) {
  if (!isPlain(VERSION_TEXT, record.latestVersion)) return null;
  const head = `Beezi: a newer ${local.name} is published — ${local.version} → ${record.latestVersion}.`;
  const commands = updateCommands(local.name, record.marketplaceName);
  if (commands == null) {
    return `${head} Run /plugin to update it, then ${APPLY_UPDATE}.`;
  }
  return `${head} Run: ${commands[0]}, then ${commands[1]}`
    + ` (in the Copilot app: Customize → Plugins → Update) — then ${APPLY_UPDATE}.`;
}

// The newest published reading for the installed plugin: the cached one while fresh, else fetched; when the fetch
// fails the last cached reading stands in, flagged `stale`. { local, record, stale }; never throws.
export async function readLatest(deps = {}) {
  try {
    const local = readLocalPlugin(deps);
    if (local == null) return { local: null, record: null, stale: false };
    const now = deps.now == null ? new Date() : deps.now;
    let cached = readUpdateCheck(deps);
    // A reading about a DIFFERENT plugin name (variant swap under one BEEZI_COPILOT_HOME) says nothing.
    if (cached != null && cached.pluginName !== local.name) cached = null;
    if (isFresh(cached, now.getTime())) return { local: local, record: cached, stale: false };
    const fetched = await fetchRemote(local.name, now.toISOString(), deps);
    if (fetched != null) return { local: local, record: fetched, stale: false };
    return { local: local, record: cached, stale: cached != null };
  } catch {
    return { local: null, record: null, stale: false };
  }
}

// The one-line nudge, or null when there is nothing to say. Best-effort by contract: never throws.
export async function checkForUpdate(deps = {}) {
  try {
    const { local, record, stale } = await readLatest(deps);
    if (local == null || record == null || stale) return null;
    // Re-decided on every read against the version installed RIGHT NOW, never persisted. A user
    // who took the update sees silence on the very next start, before the cache expires.
    if (!isNewer(record.latestVersion, local.version)) return null;
    return composeNudge(local, record);
  } catch {
    return null;
  }
}

// 'update' | 'current' | 'ahead' | 'unknown' (not comparable) | 'unchecked' (no usable reading), by the same
// comparison as checkForUpdate, so /beezi-staging-status never contradicts the session-start notice.
function versionStatus(local, record) {
  if (record == null || !isPlain(VERSION_TEXT, record.latestVersion)) return 'unchecked';
  const order = compareVersions(record.latestVersion, local.version);
  if (order === 1) return 'update';
  if (order === 0) return 'current';
  return order === -1 ? 'ahead' : 'unknown';
}

// What /beezi-staging-status shows about the plugin, from a readLatest() answer: { local, latest, status, marketplace }.
export function pluginInfo(reading) {
  const local = reading == null ? null : reading.local;
  if (local == null) return { local: null };
  const status = versionStatus(local, reading.record);
  const record = status === 'unchecked' ? null : reading.record;
  return {
    local: local,
    latest: record == null ? null : { version: record.latestVersion, checkedAt: record.checkedAt, stale: reading.stale },
    status: status,
    marketplace: record == null ? null : record.marketplaceName,
  };
}

// `YYYY-MM-DD HH:MM UTC` — fixed, so the output reads the same on every machine and locale.
function formatTime(iso) {
  const ms = Date.parse(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// The Plugin field's value: "0.1.93, the newest", "0.1.92. Update available: 0.1.93", "0.1.93 (could not check for updates)".
export function pluginText(info) {
  if (info == null || info.local == null) return 'unknown (could not read its version)';
  const version = info.local.version;
  const latest = info.latest;
  if (info.status === 'update' && latest != null) {
    const seen = latest.stale ? ` (could not check now; last seen ${formatTime(latest.checkedAt) || 'earlier'})` : '';
    return `${version}. Update available: ${latest.version}${seen}`;
  }
  if (latest == null || latest.stale) return `${version} (could not check for updates)`;
  if (info.status === 'current') return `${version}, the newest`;
  if (info.status === 'ahead') return `${version}, newer than the published ${latest.version}`;
  return `${version} (could not compare it with the published ${latest.version})`;
}

// How to update, only when a newer version is out: the same commands and app path as the SessionStart notice.
export function updateSteps(info) {
  if (info == null || info.local == null || info.status !== 'update' || info.latest == null) return [];
  const commands = updateCommands(info.local.name, info.marketplace);
  return [
    `To update to ${info.latest.version}:`,
    commands == null ? '  Run /plugin to update it.' : `  Run: ${commands[0]}, then ${commands[1]}`,
    '  In the Copilot app: Customize → Plugins → Update.',
    `  Then ${APPLY_UPDATE}.`,
  ];
}
