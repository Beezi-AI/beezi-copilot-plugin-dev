import fs from 'fs';
import path from 'path';
import { accountDir, queueDir, tenantTag } from '../config/paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { writeAccountJson } from '../accounts/account-files.mjs';
import { accountRowFor, isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { QUEUE_HOLD_MS } from '../contract/queue-policy.mjs';
import { stringIds } from '../core/guards.mjs';
import { rememberIdentityTarget } from '../state/identity-targets.mjs';

const QUEUE_VERSION = 1;
const HOLD_ASK = 'ask';
const ASK_SUFFIX = '__ask.json';

// Segment ids carry ':' (and could carry anything): only file-name-safe characters survive.
function segmentName(payload) {
  if (payload == null || typeof payload.segmentId !== 'string' || payload.segmentId === '') throw new TypeError('payload has no segmentId');
  return payload.segmentId.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Every write goes through writeAccountJson, so none can recreate a logged-out account's directory.
// false = the account directory is gone and the payload is rightly dropped. A failed write for an account
// that is still there throws instead, so the checkpoint keeps its cursor and retries rather than losing the report.
function writeQueued(key, file, envelope) {
  if (writeAccountJson(key, file, envelope)) return true;
  if (!fs.existsSync(accountDir(key))) return false;
  throw new Error('Could not write the queue file.');
}

// Writes the queue file, then drops the queued windows it supersedes.
function writeSuperseding(key, file, envelope) {
  const written = writeQueued(key, file, envelope);
  if (written) supersedeContained(path.dirname(file), path.basename(file));
  return written;
}

// Multi-workspace copies are <seg>__<tenantTag>.json; everything else keeps <seg>.json.
export function enqueue(key, payload, tenantId = null, { multi = false } = {}) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  const seg = segmentName(payload);
  const filename = multi && tenantId != null ? `${seg}__${tenantTag(tenantId)}.json` : `${seg}.json`;
  return writeSuperseding(key, path.join(queueDir(key), filename), { version: QUEUE_VERSION, tenantId, payload });
}

// The Ask portion, held until the session answers: <seg>__ask.json.
export function enqueueHeld(key, payload, askTenants) {
  const file = path.join(queueDir(key), `${segmentName(payload)}${ASK_SUFFIX}`);
  return writeSuperseding(key, file, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: stringIds(askTenants) || [], payload });
}

// Queue files are { version, tenantId, payload[, hold, askTenants] } envelopes; a file without a payload object is a legacy raw payload.
export function unwrapQueueFile(value) {
  if (value != null && typeof value === 'object' && value.payload != null && typeof value.payload === 'object') {
    return {
      tenantId: typeof value.tenantId === 'string' ? value.tenantId : null,
      payload: value.payload,
      hold: value.hold === HOLD_ASK ? HOLD_ASK : null,
      askTenants: stringIds(value.askTenants),
    };
  }
  return { tenantId: null, payload: value, hold: null, askTenants: null };
}

// Held = an ask hold, or an unstamped file on a multi-workspace account (askTenants null = every current workspace).
function isHeld(entry, row) {
  return entry.hold === HOLD_ASK || (entry.tenantId == null && isMultiTenant(row));
}

function heldSegment(filePath) {
  const base = path.basename(filePath);
  return base.endsWith(ASK_SUFFIX) ? base.slice(0, -ASK_SUFFIX.length) : base.slice(0, -'.json'.length);
}

// Copies a held file to each target it may reach, then drops it once the session is no longer pending; returns { written: [file names], deleted, expired }.
// A copy goes only to workspaces in the file's ask set, the session's current targets and the account's current membership.
export function releaseHeldFile(filePath, row, state) {
  const none = { written: [], deleted: false, expired: false };
  const account = accountRowFor(row);
  if (!isMultiTenant(account)) return none;
  const value = readJson(filePath, null);
  if (value == null) return none;
  const entry = unwrapQueueFile(value);
  if (entry.payload == null || typeof entry.payload !== 'object' || !isHeld(entry, account)) return none;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return none; }
  if (Date.now() - stat.mtimeMs > QUEUE_HOLD_MS) {
    try { fs.unlinkSync(filePath); return { written: [], deleted: true, expired: true }; } catch { return none; }
  }

  const resolved = resolveTargets(account, state);
  const members = tenantsOf(account).map((t) => t.id);
  const eligible = entry.askTenants == null ? members : entry.askTenants;
  const due = resolved.targets.filter((t) => t != null && eligible.indexOf(t) !== -1 && members.indexOf(t) !== -1);
  const dir = path.dirname(filePath);
  const seg = heldSegment(filePath);
  const written = [];
  // Tenants whose copy could not be written stay in the hold for the next release.
  const unwritten = [];
  for (const tenantId of due) {
    const name = `${seg}__${tenantTag(tenantId)}.json`;
    const target = path.join(dir, name);
    // An existing copy may carry a newer payload.
    if (fs.existsSync(target)) continue;
    if (writeAccountJson(account.key, target, { version: QUEUE_VERSION, tenantId, payload: entry.payload })) {
      written.push(name);
      // The target learns the payload's GitHub identity, as a direct enqueue does.
      rememberIdentityTarget(account.key, entry.payload.account_uuid, tenantId);
    } else unwritten.push(tenantId);
  }

  const remaining = eligible.filter((t) => due.indexOf(t) === -1 || unwritten.indexOf(t) !== -1);
  // A rule, send or none settles it: what is not due now never will be.
  if (unwritten.length === 0 && (!resolved.pendingAsk || remaining.length === 0)) {
    try { fs.unlinkSync(filePath); return { written, deleted: true, expired: false }; } catch { return { written, deleted: false, expired: false }; }
  }
  const changed = entry.hold !== HOLD_ASK || entry.askTenants == null || remaining.length !== entry.askTenants.length;
  if (changed) {
    try {
      // A flush may have deleted it meanwhile; rewriting would resurrect it.
      if (fs.existsSync(filePath)
        && writeAccountJson(account.key, filePath, { version: QUEUE_VERSION, tenantId: null, hold: HOLD_ASK, askTenants: remaining, payload: entry.payload })) {
        // Keeps the original age so the hold window is not extended.
        fs.utimesSync(filePath, stat.atime, stat.mtime);
      }
    } catch { /* left as is; the next release retries */ }
  }
  return { written, deleted: false, expired: false };
}

// Quarantined reports keep their name plus this suffix, so no flusher, older builds included, posts them as queued.
export const REJECTED_SUFFIX = '.rejected';

// Queue names are <scope>_<from>-<to>[__<tag>].json[.rejected] (segmentName), so the window parses from the name without a read.
const QUEUE_NAME_RE = /^(.*)_(\d+)-(\d+)((?:__(?:(?!__)[\s\S])*)?)\.json(\.rejected)?$/;

function parseQueueName(name) {
  const m = QUEUE_NAME_RE.exec(name);
  return m ? { scope: m[1], from: Number(m[2]), to: Number(m[3]), tag: m[4] } : null;
}

// Mirrors the server's supersede locally: a queued or quarantined window of the same scope and target that the new window
// contains is deleted, since posted (or re-posted after an update) after the wider one it would be counted beside it.
function supersedeContained(dir, written) {
  const wide = parseQueueName(written);
  if (wide == null) return;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const narrow = name === written ? null : parseQueueName(name);
    if (narrow == null || narrow.scope !== wide.scope || narrow.tag !== wide.tag) continue;
    if (narrow.from < wide.from || narrow.to > wide.to) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* another flusher took it */ }
  }
}

// Sorts by scope (sessionId plus agent), from_line, then to_line, so a narrower window posts before the wider one that supersedes it.
export function sortQueueFiles(files) {
  const keyed = files.map((name) => {
    const parsed = parseQueueName(name);
    return parsed == null ? { name, scope: name, from: 0, to: 0 } : { name, scope: parsed.scope, from: parsed.from, to: parsed.to };
  });
  keyed.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)
    || a.from - b.from || a.to - b.to || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return keyed.map((k) => k.name);
}

// Expire queued reports older than the hold window, counting each into result.expired. Only meaningful while tracking
// is off — a live-mode queue drains through flushing, not expiry. Quarantined and temp files keep pruneStale's retention.
export function sweepHeldQueue(dir, result, now = Date.now()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// A held file inside the hold window counts as pending; past it the file expires.
export function waitOrExpire(filePath, result) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { mtimeMs = Date.now(); }
  if (Date.now() - mtimeMs <= QUEUE_HOLD_MS) {
    result.workspacePending += 1;
  } else {
    try { fs.unlinkSync(filePath); result.expired += 1; } catch { /* best-effort */ }
  }
}

// Releases every held file of this session on the account; returns how many copies were written.
export function releaseHeldQueue(row, sessionId) {
  const account = accountRowFor(row);
  if (sessionId == null || !isMultiTenant(account)) return 0;
  let dir;
  let files;
  try {
    dir = queueDir(account.key);
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const state = readSessionWorkspace(sessionId);
  let count = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    const value = readJson(filePath, null);
    if (value == null) continue;
    const entry = unwrapQueueFile(value);
    if (entry.payload == null || entry.payload.sessionId !== sessionId || !isHeld(entry, account)) continue;
    count += releaseHeldFile(filePath, account, state).written.length;
  }
  return count;
}
