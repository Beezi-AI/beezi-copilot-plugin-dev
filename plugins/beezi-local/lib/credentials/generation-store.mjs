import fs from 'fs';
import { credentialService, credentialControlFile, credentialGenerationFile } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { BACKENDS, backendsFor, backendByName } from './backends/index.mjs';
import { holdsCredentialLock } from './credential-lock.mjs';
import { sleep as defaultSleep } from '../core/async.mjs';

// Generation-versioned store, one whole set per ACCOUNT. Each credential set is an immutable entry
// <key>-gen-<n> in one backend; control.json (atomic temp+rename) names the committed generation
// and the backend holding it. Readers follow the control record and never fall back to another
// generation or backend copy.

export const CREDENTIAL_STATUS = Object.freeze({
  READY: 'ready',
  NONE: 'none',
  UNAVAILABLE: 'unavailable',
  STORAGE_CONFLICT: 'storage_conflict',
});

export const UNAVAILABLE_REASONS = Object.freeze({
  BACKEND_UNREADABLE: 'backend_unreadable',
  // The backend never answered — its helper was killed for taking too long. Distinct from
  // BACKEND_UNREADABLE because it says nothing about whether the credential is still there, and
  // the caller should say so rather than send the user to /beezi-local-login.
  BACKEND_TIMEOUT: 'backend_timeout',
  ENTRY_MALFORMED: 'entry_malformed',
  BACKEND_MISSING: 'backend_missing',
  CONTROL_UNREADABLE: 'control_unreadable',
  LOCKED: 'locked',
});

export const COMMIT_STATUS = Object.freeze({
  COMMITTED: 'committed',
  SUPERSEDED: 'superseded',
  LOCK_LOST: 'lock_lost',
});

export const DELETE_STATUS = Object.freeze({
  DELETED: 'deleted',
  SUPERSEDED: 'superseded',
  LOCK_LOST: 'lock_lost',
});

const CONTROL_VERSION = 1;

// The OS-store entry field carries the account key, so two accounts never share an entry.
function generationEntry(account, generation) {
  const service = credentialService();
  const entry = `${account}-gen-${generation}`;
  return {
    service, account: entry, target: `${service}/${entry}`, file: credentialGenerationFile(account, generation),
  };
}

// { value } for a parsed record, { value: null } when absent, { unreadable: true } otherwise.
function readControlAt(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return error != null && error.code === 'ENOENT' ? { value: null } : { unreadable: true };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && 'generation' in value) return { value };
  } catch { /* corrupt */ }
  return { unreadable: true };
}

function readControl(account) {
  return readControlAt(credentialControlFile(account));
}

function writeControl(account, generation, backend, highestGeneration) {
  writeJsonSecure(credentialControlFile(account), {
    version: CONTROL_VERSION, generation, backend, highestGeneration, committedAt: Date.now(),
  });
}

const highestOf = (control) => (
  control.value && typeof control.value.highestGeneration === 'number' ? control.value.highestGeneration : 0
);

// The backends store an opaque string. Since the Clerk OAuth migration that
// string is a JSON credentials object: { client_id, redirect_uri,
// token_endpoint, access_token, refresh_token, expires_at }. Legacy bare
// device tokens fail to parse and read as "not linked".
function parseCredentials(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && typeof obj.access_token === 'string' ? obj : null;
  } catch {
    return null;
  }
}

// Best-effort removal of a generation that is no longer committed.
function retireEntry(account, record, deps) {
  const b = backendByName(record.backend, deps);
  if (b == null || !b.available()) return;
  try { b.delete(generationEntry(account, record.generation)); } catch { /* orphan; never read again */ }
}

// A lock handle plus exactly one of expectedGeneration / force, so "no check" is never implicit.
function casGuard(options) {
  if (options.lock == null || typeof options.lock.nonce !== 'string') {
    throw new TypeError('A credential lock handle is required.');
  }
  const force = options.force === true;
  if ((options.expectedGeneration !== undefined) === force) {
    throw new TypeError('Pass exactly one of expectedGeneration or force.');
  }
  return { force, expectedGeneration: options.expectedGeneration };
}

// Spread the retries of readers that were killed together. The window is small enough that an
// interactive command still feels immediate and large enough to break the lockstep.
const RETRY_PAUSE_MIN_MS = 150;
const RETRY_PAUSE_SPREAD_MS = 600;

function retryPause(deps) {
  const random = deps.randomImpl == null ? Math.random : deps.randomImpl;
  const sleep = deps.sleepImpl == null ? defaultSleep : deps.sleepImpl;
  return sleep(RETRY_PAUSE_MIN_MS + Math.floor(random() * RETRY_PAUSE_SPREAD_MS));
}

// One OS-store read per committed generation per process, shared by every caller: on Windows each read is a
// PowerShell spawn. One slot per control file, tagged with the record it was read under, so a new commit replaces the
// slot instead of piling up; only a read that produced a token stays, and a commit or delete here drops them all.
const readMemo = new Map();

function memoizedRead(b, entry, readOptions, slot, tag) {
  const hit = readMemo.get(slot);
  if (hit != null && hit.tag === tag) return hit.pending;
  const pending = Promise.resolve(b.read(entry, readOptions)).then((attempt) => {
    if (attempt.token == null) forget(slot, pending);
    return attempt;
  }, (error) => { forget(slot, pending); throw error; });
  readMemo.set(slot, { tag, pending });
  return pending;
}

function forget(slot, pending) {
  const current = readMemo.get(slot);
  if (current != null && current.pending === pending) readMemo.delete(slot);
}

// The plaintext file gains nothing from the memo; a caller holding the lock rereads under it.
function readEntry(b, entry, readOptions, control, options) {
  if (b.name === BACKENDS.FILE || options.lock != null) return b.read(entry, readOptions);
  const tag = `${control.generation}|${control.backend}|${control.committedAt}`;
  return memoizedRead(b, entry, readOptions, credentialControlFile(options.account), tag);
}

// Writes and deletes re-probe OS stores rather than trust a recorded "unreachable".
const writeDeps = (deps) => ({ ...deps, freshProbe: true });

// ── public store API ──────────────────────────────────────────────────────────────────────────

// { status: 'ready', generation, backend, credentials } | { status: 'none' }
// | { status: 'unavailable', reason, generation?, backend? } | { status: 'storage_conflict', sources }.
// `options.lock` lets a caller that already holds the namespace lock reread without re-acquiring.
// `options.interactive` says a human is waiting: the backend read gets the longer cap AND one more
// attempt when its helper was killed before answering. Hooks must leave it off — their whole
// budget is 10s and they still have work to do after the read.
export async function readCredentials(deps = {}, options = {}) {
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable) {
    return { status: CREDENTIAL_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASONS.CONTROL_UNREADABLE };
  }
  if (control.value == null) return { status: CREDENTIAL_STATUS.NONE };
  const { generation, backend } = control.value;
  if (generation == null) return { status: CREDENTIAL_STATUS.NONE };
  const unavailable = (reason) => ({ status: CREDENTIAL_STATUS.UNAVAILABLE, reason, generation, backend });
  const b = backendByName(backend, deps);
  if (b == null) return unavailable(UNAVAILABLE_REASONS.BACKEND_MISSING);
  if (!b.available()) return unavailable(UNAVAILABLE_REASONS.BACKEND_UNREADABLE);
  const entry = generationEntry(account, generation);
  const interactive = options.interactive === true;
  let attempt = await readEntry(b, entry, { interactive }, control.value, options);
  // A killed read says nothing about whether the credential is still there, so it is worth one
  // more try — after a jittered pause, because the readers that lost the race are the ones that
  // started together, and retrying them in lockstep just recreates the pile-up that killed them.
  if (attempt.token == null && attempt.timedOut && interactive) {
    await retryPause(deps);
    attempt = await readEntry(b, entry, { interactive }, control.value, options);
  }
  const raw = attempt.token;
  if (!raw) {
    return unavailable(
      attempt.timedOut ? UNAVAILABLE_REASONS.BACKEND_TIMEOUT : UNAVAILABLE_REASONS.BACKEND_UNREADABLE,
    );
  }
  const credentials = parseCredentials(raw);
  if (!credentials) return unavailable(UNAVAILABLE_REASONS.ENTRY_MALFORMED);
  return { status: CREDENTIAL_STATUS.READY, generation, backend, credentials };
}

// Writes `credentials` as the next generation into the first backend that accepts it, then
// publishes the control record — only while the caller still owns the lock, and only if the
// committed generation still equals `expectedGeneration` (null = none committed) unless `force`.
// { status: 'committed', generation, backend, where } | { status: 'superseded', generation }
// | { status: 'lock_lost' }.
export async function commitCredentials(credentials, options = {}, deps = {}) {
  const guard = casGuard(options);
  if (options.lock.account !== options.account) throw new TypeError("Credential lock belongs to a different account.");
  if (!holdsCredentialLock(options.lock)) return { status: COMMIT_STATUS.LOCK_LOST };
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable && !guard.force) return { status: COMMIT_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: COMMIT_STATUS.SUPERSEDED, generation: current };
  }
  const generation = highestOf(control) + 1;
  const entry = generationEntry(account, generation);
  const raw = JSON.stringify(credentials);
  readMemo.clear();
  let backend = null;
  let where = null;
  for (const b of backendsFor(writeDeps(deps))) {
    if (!b.available()) continue;
    where = b.set(entry, raw);
    if (where) { backend = b; break; }
  }
  if (backend == null) throw new Error('No credential backend accepted the write.');
  // The entry stays as an orphan on purpose: never read (no control record names it) and
  // overwritten by name by the next commit, whereas a by-name delete here could remove an entry
  // a concurrent holder just wrote under the same number.
  if (!holdsCredentialLock(options.lock)) return { status: COMMIT_STATUS.LOCK_LOST };
  writeControl(account, generation, backend.name, generation);
  if (typeof current === 'number') retireEntry(account, control.value, writeDeps(deps));
  return { status: COMMIT_STATUS.COMMITTED, generation, backend: backend.name, where };
}

// Publishes "nothing committed" (keeping the generation counter), then removes the entry — in
// that order, so a crash in between leaves no permanently unavailable generation. Same
// lock/expectedGeneration/force contract as commitCredentials.
// { status: 'deleted', generation } | { status: 'superseded', generation } | { status: 'lock_lost' }.
export async function deleteCredentialGeneration(options = {}, deps = {}) {
  const guard = casGuard(options);
  if (options.lock.account !== options.account) throw new TypeError("Credential lock belongs to a different account.");
  if (!holdsCredentialLock(options.lock)) return { status: DELETE_STATUS.LOCK_LOST };
  const account = options.account;
  const control = readControl(account);
  if (control.unreadable && !guard.force) return { status: DELETE_STATUS.SUPERSEDED, generation: null };
  const current = control.value == null ? null : control.value.generation;
  if (!guard.force && guard.expectedGeneration !== current) {
    return { status: DELETE_STATUS.SUPERSEDED, generation: current };
  }
  readMemo.clear();
  writeControl(account, null, null, highestOf(control));
  if (typeof current === 'number') retireEntry(account, control.value, writeDeps(deps));
  return { status: DELETE_STATUS.DELETED, generation: current };
}

// Removes every generation entry this namespace could still hold, committed or orphaned.
//
// commitCredentials deliberately leaves an entry behind when it loses the lock mid-write, because
// a by-name delete there can remove what a concurrent holder just wrote under the same number.
// That hazard is specific to the lock-lost path: a caller that HOLDS the lock — logout — has no
// concurrent holder, and an orphan created by a refresh holds the freshly ROTATED refresh token
// while the committed generation's is the dead one. Leaving it is a live grant sitting in the
// keychain of a machine the user just signed out of.
export function deleteAllGenerationEntries(deps = {}) {
  if (!holdsCredentialLock(deps.lock) || deps.lock.account !== deps.account) return 0;
  const account = deps.account;
  const control = readControl(account);
  // highest + 1: a lock-lost commit writes gen-<highest+1> and never reaches writeControl, so the
  // control record has no idea that entry exists. That number IS the orphan this sweep is for.
  const highest = (control.unreadable ? 0 : highestOf(control)) + 1;
  readMemo.clear();
  const backends = backendsFor(writeDeps(deps));
  let removed = 0;
  for (let generation = 1; generation <= highest; generation += 1) {
    const entry = generationEntry(account, generation);
    for (const b of backends) {
      if (!b.available()) continue;
      try { if (b.delete(entry) !== false) removed += 1; } catch { /* ignore */ }
    }
  }
  return removed;
}

// Where the committed generation lives, for status: { backend, plaintext } or null when none is committed. Never
// spawns and never returns the secret: a DPAPI file is plaintext when it holds no `enc` (older builds under CLM).
export function describeCredentialStorage(account) {
  const control = readControl(account);
  if (control.unreadable || control.value == null || control.value.generation == null) return null;
  const { generation, backend } = control.value;
  if (backend === BACKENDS.FILE) return { backend, plaintext: true };
  if (backend !== BACKENDS.DPAPI_FILE) return { backend, plaintext: false };
  const stored = readJson(credentialGenerationFile(account, generation));
  return { backend, plaintext: stored != null && typeof stored.enc !== 'string' };
}
