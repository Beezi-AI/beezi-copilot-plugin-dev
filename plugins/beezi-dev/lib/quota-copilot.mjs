// A DEFAULT import, not a named one: it is read off the object at call time, so a patched child_process is honoured.
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beeziHome, quotaCacheFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { acquireLock, releaseLock, LOCK_STALE_MS } from './single-instance-lock.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { readCopilotIdentity, identityKey as keyOf, normalizeHost, signedInIdentityKeys, IdentityStatus } from './copilot-account.mjs';

// The monthly Copilot quota and the signed-in account's plan, from the Copilot runtime's own
// `account.getQuota` and `account.getCurrentAuth`.
//
// A short-lived Copilot server-mode child answers those calls and nothing else. It sits behind a
// cache, a single-flight lock, a failure backoff and a hard time budget, and it is started only by
// the detached scripts/quota-worker.mjs (or a non-hook process): no hook ever starts the Copilot
// runtime inline (R-06). Nothing here spawns at import time.

export const QUOTA_FRESH_MS = 15 * 60 * 1000;

// Why a probe returned what it returned, for the backoff and for reporting.
export const QuotaReason = Object.freeze({
  OK: 'ok',
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
  NOT_SIGNED_IN: 'not-signed-in',
  NO_QUOTA: 'no-quota',
  TIMEOUT: 'timeout',
  ERROR: 'error',
});

// The portal's allowance enums (snake_case on the wire); a value outside them is dropped, never sent.
export const AllowanceType = Object.freeze({
  LIMITED: 'limited',
  UNLIMITED: 'unlimited',
  UNKNOWN: 'unknown',
});

export const AllowanceUnit = Object.freeze({
  AI_CREDITS: 'ai_credits',
  PREMIUM_REQUESTS: 'premium_requests',
});

const LOCK_NAME = 'quota-probe';
const LONG_BACKOFF_MS = 6 * 60 * 60 * 1000;
const SHORT_BACKOFF_MS = 60 * 60 * 1000;
const SPAWN_GAP_MS = 60 * 1000;
const MAX_PROBE_MS = 8000;
// A hung or babbling child must not be buffered without bound; the real answer is a few hundred bytes.
const MAX_OUTPUT_BYTES = 1024 * 1024;

// The Copilot SDK's own launch (CLI 1.0.90): headless server on stdio, Content-Length framing, then `connect`.
// Measured: ~0.9 s warm, no session directory created.
const SERVER_ARGS = ['--headless', '--no-auto-update', '--stdio'];
const HANDSHAKE = [{ method: 'connect', params: { supportedTaskKinds: ['agent', 'client', 'shell'] } }];
const AUTH_METHOD = 'account.getCurrentAuth';
const QUOTA_METHOD = 'account.getQuota';
const NOT_SIGNED_IN_RE = /not (signed|logged) in|unauthenticated|no (auth|credentials)/i;
// V-37 is open: premium_interactions is the only quota type the spec names.
const SNAPSHOT_KEY = 'premium_interactions';
// The snapshot's own resetDate has been observed equal to its timestamp, so it counts only well past the fetch.
const SNAPSHOT_RESET_MIN_AHEAD_MS = 24 * 60 * 60 * 1000;

function isOff(value) {
  return /^(0|false|off|no)$/i.test(String(value == null ? '' : value).trim());
}

// Off by switch, inside a probe child (never recurse into Beezi hooks), or without launch flags.
function probeDisabled(env) {
  return isOff(env.BEEZI_COPILOT_QUOTA) || env.BEEZI_COPILOT_PROBE === '1' || SERVER_ARGS == null;
}

// BEEZI_COPILOT_CLI overrides the binary, for a machine where `copilot` is not on the PATH hooks inherit.
function copilotCommand(env) {
  const override = String(env.BEEZI_COPILOT_CLI == null ? '' : env.BEEZI_COPILOT_CLI).trim();
  return override === '' ? 'copilot' : override;
}

// An npm-installed `copilot` is a .cmd shim on Windows, which Node cannot spawn directly. cmd.exe is
// invoked explicitly (not `shell: true`, which emits a deprecation warning on stderr) with the whole
// command line in one pair of quotes that /s strips and windowsVerbatimArguments keeps intact.
// An absolute cmd.exe: a bare name is searched for in the working directory first.
function launchArgs(command, args, env) {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const quoted = command.indexOf(' ') === -1 ? command : `"${command}"`;
  const shell = env.ComSpec || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: shell, args: ['/d', '/s', '/c', `"${quoted} ${args.join(' ')}"`], verbatim: true };
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// Content-Length framing: append chunks, and while a full header + body is buffered parse it and slice it off.
function createDecoder(onMessage, onOverflow) {
  let buffered = Buffer.alloc(0);
  let total = 0;
  return function push(chunk) {
    total += chunk.length;
    if (total > MAX_OUTPUT_BYTES) { onOverflow(); return; }
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const match = /content-length:\s*(\d+)/i.exec(buffered.slice(0, headerEnd).toString('ascii'));
      if (match == null) { buffered = buffered.slice(headerEnd + 4); continue; }
      const end = headerEnd + 4 + Number(match[1]);
      if (buffered.length < end) return;
      const body = buffered.slice(headerEnd + 4, end).toString('utf8');
      buffered = buffered.slice(end);
      let message = null;
      try { message = JSON.parse(body); } catch { message = null; }
      if (message != null) onMessage(message);
    }
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// An ISO string only for a parseable date in 2020-2100; a seconds/milliseconds mix-up lands far outside it.
function isoInRange(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2020 && year <= 2100 ? new Date(ms).toISOString() : null;
}

function oneOf(value, enumeration) {
  return typeof value === 'string' && Object.values(enumeration).indexOf(value) !== -1 ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

// The account's own reset date wins; the snapshot's resetDate is a fallback only when it is clearly in the future.
function resetsAtOf(snap, auth, fetchedAt) {
  if (auth.quotaResetAt != null) return auth.quotaResetAt;
  const fromSnap = isoInRange(snap.resetDate);
  return fromSnap != null && Date.parse(fromSnap) > Date.parse(fetchedAt) + SNAPSHOT_RESET_MIN_AHEAD_MS ? fromSnap : null;
}

// token-based billing means the allowance is counted in AI credits; its absence leaves the unit unknown.
function allowanceUnitOf(snap, auth) {
  const tokenBased = typeof snap.tokenBasedBilling === 'boolean' ? snap.tokenBasedBilling : auth.tokenBasedBilling;
  if (tokenBased === true) return AllowanceUnit.AI_CREDITS;
  if (tokenBased === false) return AllowanceUnit.PREMIUM_REQUESTS;
  return null;
}

// P4: only the named fields of the chosen snapshot are read; the rest of the response is discarded unread.
function readSnapshot(result, auth, fetchedAt) {
  const snapshots = result != null && typeof result === 'object' ? result.quotaSnapshots : null;
  if (snapshots == null || typeof snapshots !== 'object' || !Object.prototype.hasOwnProperty.call(snapshots, SNAPSHOT_KEY)) return null;
  const snap = snapshots[SNAPSHOT_KEY];
  if (snap == null || typeof snap !== 'object') return null;
  const entitlement = finite(snap.entitlementRequests);
  const used = finite(snap.usedRequests);
  const remaining = finite(snap.remainingPercentage);
  const overage = finite(snap.overage);
  const unlimited = snap.isUnlimitedEntitlement === true || entitlement === -1;
  let percentUsed = null;
  if (!unlimited) {
    // Floored at 0; overage may push it past 100.
    if (remaining != null) percentUsed = Math.max(0, Math.round(100 - remaining));
    else if (entitlement != null && entitlement > 0 && used != null) percentUsed = Math.round((used / entitlement) * 100);
  }
  // Limited only on an explicit flag or a positive entitlement; a zero entitlement with no flag is not a reading.
  let allowanceType = AllowanceType.UNKNOWN;
  if (unlimited) allowanceType = AllowanceType.UNLIMITED;
  else if (snap.isUnlimitedEntitlement === false || (entitlement != null && entitlement > 0)) allowanceType = AllowanceType.LIMITED;
  return {
    percentUsed,
    resetsAt: resetsAtOf(snap, auth, fetchedAt),
    entitlement: unlimited ? null : entitlement,
    used: unlimited ? null : used,
    unlimited,
    allowanceType,
    unit: allowanceUnitOf(snap, auth),
    overage: overage != null && overage >= 0 ? overage : null,
    overagePermitted: bool(snap.overageAllowedWithExhaustedQuota),
    source: 'sdk_quota',
    fetchedAt,
    identityKey: auth.key,
  };
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// The cycle end: the full UTC instant when present, else the date-only field read as that day at 00:00 UTC.
function quotaResetOf(user) {
  const utc = isoInRange(user.quota_reset_date_utc);
  if (utc != null) return utc;
  const day = str(user.quota_reset_date);
  return day != null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? isoInRange(`${day}T00:00:00.000Z`) : null;
}

// P2: only these scalars leave account.getCurrentAuth; token-carrying auth variants are discarded unread.
function readAuth(result) {
  const info = result != null && typeof result === 'object' ? result.authInfo : null;
  if (info == null || typeof info !== 'object') return null;
  const user = info.copilotUser != null && typeof info.copilotUser === 'object' ? info.copilotUser : {};
  // The runtime reports the host as a URL ('https://github.com'); keys use the bare host, as config.json does.
  const host = normalizeHost(info.host);
  const login = str(info.login) || str(user.login);
  const key = keyOf(host, login);
  if (key == null) return null;
  return {
    key,
    host,
    login,
    authType: str(info.type),
    rawPlan: str(user.copilot_plan),
    rawSku: str(user.access_type_sku),
    quotaResetAt: quotaResetOf(user),
    tokenBasedBilling: bool(user.token_based_billing),
  };
}

// The runtime's account counts only if it is the one this process attributes to: the same key when the file
// names one, a listed user when several are signed in, any env-credential account under an env token.
function authMatches(auth, configured) {
  if (auth == null) return false;
  if (configured.status === IdentityStatus.OK) return configured.key === auth.key;
  if (configured.status === IdentityStatus.AMBIGUOUS) return signedInIdentityKeys().indexOf(auth.key) !== -1;
  if (configured.status === IdentityStatus.ENV_TOKEN) return auth.authType !== 'user';
  return false;
}

// Ask the Copilot runtime for the signed-in account and the monthly quota. Never rejects; the child always ends (P5).
// P1: only the handshake, `account.getCurrentAuth` and `account.getQuota` with `params: {}` are sent, never a token.
// P2: getCurrentAuth is read through readAuth only; getAllUsers, login, logout, models.*, session.* are never called.
// P3: a server-to-client request gets JSON-RPC -32601, notifications are ignored, and only responses to our ids are read.
export function probeQuota({ env = process.env, timeoutMs = MAX_PROBE_MS, spawn } = {}) {
  return new Promise((resolve) => {
    if (probeDisabled(env)) { resolve({ reason: QuotaReason.DISABLED, quota: null }); return; }
    // Taken at probe time: the answer is kept only if the runtime reports the account this process attributes to.
    const configured = readCopilotIdentity({ env });
    const spawnImpl = spawn == null ? (file, args, options) => childProcess.spawn(file, args, options) : spawn;
    const requests = HANDSHAKE.map((h) => ({ method: h.method, params: h.params }))
      .concat([{ method: AUTH_METHOD, params: {} }, { method: QUOTA_METHOD, params: {} }]);
    const authStep = HANDSHAKE.length;
    let auth = null;
    let child = null;
    let settled = false;
    let timer = null;
    let step = 0;

    function finish(reason, quota) {
      if (settled) return;
      settled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (child) {
        // stdin EOF is how the server is meant to end; kill is the backstop, and covers the Windows shell wrapper.
        try { child.stdin.end(); } catch { /* already closed */ }
        try { child.kill(); } catch { /* already gone */ }
      }
      resolve({ reason, quota, auth: reason === QuotaReason.OK || reason === QuotaReason.NO_QUOTA ? auth : null });
    }

    function send(message) {
      if (settled || !child) return;
      try { child.stdin.write(frame(message)); } catch { finish(QuotaReason.ERROR, null); }
    }

    function sendStep() {
      send({ jsonrpc: '2.0', id: step + 1, method: requests[step].method, params: requests[step].params });
    }

    function onMessage(message) {
      if (message == null || typeof message !== 'object') return;
      if (message.method != null) {
        if (message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      if (message.id !== step + 1) return;
      if (message.error != null) {
        const text = typeof message.error.message === 'string' ? message.error.message : '';
        finish(NOT_SIGNED_IN_RE.test(text) ? QuotaReason.NOT_SIGNED_IN : QuotaReason.ERROR, null);
        return;
      }
      if (step === authStep) {
        auth = readAuth(message.result);
        // Another account than the one reports are attributed to: nothing from this runtime is kept.
        if (!authMatches(auth, configured)) { auth = null; finish(QuotaReason.ERROR, null); return; }
      }
      if (step < requests.length - 1) { step += 1; sendStep(); return; }
      const quota = readSnapshot(message.result, auth, new Date().toISOString());
      // An account switch during the probe would mislabel the answer, so it is dropped.
      if (!authMatches(auth, readCopilotIdentity({ env }))) { auth = null; finish(QuotaReason.ERROR, null); return; }
      finish(quota == null ? QuotaReason.NO_QUOTA : QuotaReason.OK, quota);
    }

    const launch = launchArgs(copilotCommand(env), SERVER_ARGS, env);
    try {
      child = spawnImpl(launch.file, launch.args, {
        stdio: 'pipe',
        // Never the caller's cwd (a repo): the child would resolve `copilot` and load project config from it.
        cwd: beeziHome(),
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        env: { ...env, BEEZI_COPILOT_PROBE: '1' },
      });
    } catch {
      finish(QuotaReason.UNAVAILABLE, null);
      return;
    }
    timer = setTimeout(() => finish(QuotaReason.TIMEOUT, null), timeoutMs);
    child.on('error', () => finish(QuotaReason.UNAVAILABLE, null));
    // An EPIPE from a child that exited mid-request is emitted asynchronously and must not kill the process.
    child.stdin.on('error', () => {});
    // Reached only when the child dies before answering; after `finish`, `settled` swallows it.
    child.on('close', () => finish(QuotaReason.UNAVAILABLE, null));
    // Drained and discarded: an unread pipe fills and blocks the child.
    child.stderr.on('data', () => {});
    child.stdout.on('data', createDecoder(onMessage, () => finish(QuotaReason.ERROR, null)));
    sendStep();
  });
}

function cacheFile() {
  return quotaCacheFile();
}

function validObservation(raw) {
  if (raw == null || typeof raw !== 'object' || raw.source !== 'sdk_quota') return null;
  if (typeof raw.fetchedAt !== 'string' || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
  return {
    percentUsed: finite(raw.percentUsed),
    resetsAt: isoInRange(raw.resetsAt),
    entitlement: finite(raw.entitlement),
    used: finite(raw.used),
    unlimited: raw.unlimited === true,
    allowanceType: oneOf(raw.allowanceType, AllowanceType),
    unit: oneOf(raw.unit, AllowanceUnit),
    overage: finite(raw.overage),
    overagePermitted: bool(raw.overagePermitted),
    source: 'sdk_quota',
    fetchedAt: raw.fetchedAt,
    identityKey: typeof raw.identityKey === 'string' ? raw.identityKey : null,
  };
}

// The runtime-reported account (read back by readRuntimeAuth in lib/copilot-account.mjs).
function validAuth(raw) {
  if (raw == null || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  if (typeof raw.fetchedAt !== 'string' || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
  return {
    key: raw.key,
    host: str(raw.host),
    login: str(raw.login),
    authType: str(raw.authType),
    rawPlan: str(raw.rawPlan),
    rawSku: str(raw.rawSku),
    quotaResetAt: isoInRange(raw.quotaResetAt),
    tokenBasedBilling: bool(raw.tokenBasedBilling),
    fetchedAt: raw.fetchedAt,
  };
}

// { version: 1, observation, auth, lastAttemptAt (ms), lastReason, backoffUntil (ms) }, tolerant of a missing or foreign file.
function readCache() {
  const raw = readJson(cacheFile(), null);
  const ok = raw != null && typeof raw === 'object' && raw.version === 1;
  return {
    version: 1,
    observation: ok ? validObservation(raw.observation) : null,
    auth: ok ? validAuth(raw.auth) : null,
    lastAttemptAt: ok ? finite(raw.lastAttemptAt) : null,
    lastReason: ok && typeof raw.lastReason === 'string' ? raw.lastReason : null,
    backoffUntil: ok ? finite(raw.backoffUntil) : null,
  };
}

function backoffActive(cache, now) {
  return cache.backoffUntil != null && cache.backoffUntil > now;
}

function backoffFor(reason) {
  if (reason === QuotaReason.OK) return 0;
  const long = reason === QuotaReason.UNAVAILABLE || reason === QuotaReason.DISABLED || reason === QuotaReason.NOT_SIGNED_IN;
  return long ? LONG_BACKOFF_MS : SHORT_BACKOFF_MS;
}

// The probe lock is a directory; a young one means a probe is running.
function lockHeld(now) {
  try { return now - fs.statSync(path.join(beeziHome(), `${LOCK_NAME}.lock`)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

// The cached observation while it is fresh and belongs to the live GitHub identity, else null. Sync, file reads only, never spawns.
// A different identity makes the cache stale: account A's quota is never served as B's.
export function readCachedQuota({ maxAgeMs = QUOTA_FRESH_MS, env = process.env } = {}) {
  try {
    const { observation } = readCache();
    if (observation == null) return null;
    const now = Date.now();
    const at = Date.parse(observation.fetchedAt);
    if (at > now + 60 * 1000 || now - at > maxAgeMs) return null;
    return observation.identityKey === readCopilotIdentity({ env }).key ? observation : null;
  } catch {
    return null;
  }
}

// What hooks call: the fresh cache or null. It is file I/O only, so it resolves well inside any budgetMs; it never
// starts the Copilot runtime, and a stale cache only kicks the background worker.
export async function readQuota({ budgetMs = 0 } = {}) {
  try {
    const cached = readCachedQuota();
    if (cached != null) return cached;
    maybeRefreshQuotaInBackground();
    return null;
  } catch {
    return null;
  }
}

// Spawns the detached quota worker unless one is pointless or already due. Never waits, never throws.
// V-29 is open and defaults to "a detached child survives its hook", as the other Beezi workers assume.
export function maybeRefreshQuotaInBackground({ env = process.env } = {}) {
  try {
    if (probeDisabled(env)) return false;
    const now = Date.now();
    if (readCachedQuota({ env }) != null) return false;
    const cache = readCache();
    if (backoffActive(cache, now)) return false;
    if (cache.lastAttemptAt != null && now - cache.lastAttemptAt < SPAWN_GAP_MS) return false;
    if (lockHeld(now)) return false;
    writeJsonSecure(cacheFile(), { ...cache, lastAttemptAt: now });
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    return spawnDetached(path.join(root, 'scripts', 'quota-worker.mjs'));
  } catch {
    return false;
  }
}

// The ONLY caller of probeQuota: quota-worker.mjs, or a non-hook process. Probes when the cache is stale,
// no backoff is active and the single-flight lock is ours; otherwise returns the fresh cache or null.
export async function refreshQuota({ budgetMs = MAX_PROBE_MS + 250 } = {}) {
  try {
    const fresh = readCachedQuota();
    if (fresh != null) return fresh;
    const cache = readCache();
    if (backoffActive(cache, Date.now())) return null;
    const timeoutMs = Math.min(budgetMs - 250, MAX_PROBE_MS);
    if (!(timeoutMs >= 500)) return null;
    if (!acquireLock(LOCK_NAME)) return null;
    try {
      const result = await probeQuota({ timeoutMs });
      const at = Date.now();
      const next = { version: 1, observation: cache.observation, auth: cache.auth, lastAttemptAt: at, lastReason: result.reason, backoffUntil: null };
      if (result.auth != null) next.auth = { ...result.auth, fetchedAt: new Date(at).toISOString() };
      if (result.reason === QuotaReason.OK) next.observation = result.quota;
      // No premium snapshot is not a failure once the account and plan are known: the next probe waits one fresh window.
      else if (result.reason === QuotaReason.NO_QUOTA && result.auth != null) next.backoffUntil = at + QUOTA_FRESH_MS;
      else next.backoffUntil = at + backoffFor(result.reason);
      writeJsonSecure(cacheFile(), next);
      return result.reason === QuotaReason.OK ? result.quota : null;
    } finally {
      releaseLock(LOCK_NAME);
    }
  } catch {
    return null;
  }
}
