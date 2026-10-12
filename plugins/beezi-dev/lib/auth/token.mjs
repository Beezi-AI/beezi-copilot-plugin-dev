import { readCredentials, CREDENTIAL_STATUS, UNAVAILABLE_REASONS } from '../credentials/generation-store.mjs';
import { readCredentialLockOwner } from '../credentials/credential-lock.mjs';
import { credentialControlFile } from '../config/paths.mjs';
import { readJson } from '../platform/fs-store.mjs';
import { getDefaultKey } from '../accounts/index-store.mjs';
import { spawnDetached } from '../platform/spawn.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../contract/auth-states.mjs';
import { recordAuthResult } from './diagnostics.mjs';
import {
  readInflight, isWorkerAlive, readBackoff, readReauthMarker, recordLastAuthState, wasLastStateReady,
} from '../credentials/auth-markers.mjs';
import { scriptPath } from '../config/plugin-root.mjs';
import { sleep as defaultSleep } from '../core/async.mjs';
import { nonEmpty } from '../core/guards.mjs';

const WORKER_SCRIPT = scriptPath('refresh-worker.mjs');

const SKEW_MS = 60_000;

// A hook is killed at 10s and has real work to do afterwards, so it waits only long enough for a
// refresh that was going to be quick anyway and then reports `refreshing`. An interactive command
// has a human in front of it and can wait for the whole worker budget.
export const HOOK_REFRESH_WAIT_MS = 1_500;
export const INTERACTIVE_REFRESH_WAIT_MS = 30_000;
const POLL_MS = 50;

function result(authState, reason, extra) {
  return { authState, reason, accessToken: null, generation: null, ...extra };
}

// The generation's client id, plus the API origin it was issued for when the login recorded one.
function credentialFacts(credentials) {
  const facts = { clientId: credentials.client_id };
  if (nonEmpty(credentials.api_origin)) facts.apiOrigin = credentials.api_origin;
  return facts;
}

// The typed authentication accessor. Every user-facing decision reads this: only `ready` carries
// an access token, and each other state says whether the credentials are gone (`unlinked`),
// coming back (`refreshing`), temporarily out of reach (`unavailable`) or definitively rejected
// (`reauth_required`). Collapsing all of that into null is what made a keychain hiccup, a held
// lock and a network blip all read as "not linked".
//
// `options.forceRefresh` refreshes even when expires_at still looks healthy — the API's 401 is
// better evidence of expiry than this client's own estimate of an opaque token's lifetime.
// `options.waitMs` is how long to wait on the detached worker (default: the hook budget).
export async function getAuthentication(deps = {}, options = {}) {
  let account = options.account;
  if (account == null) {
    try { account = await getDefaultKey(deps); }
    catch { return result(AUTH_STATES.UNAVAILABLE, AUTH_REASONS.STORAGE_UNAVAILABLE); }
  }
  if (account == null) return result(AUTH_STATES.UNLINKED, AUTH_REASONS.NO_CREDENTIALS);
  const settle = (value) => settleAccount(account, value);
  const now = deps.now == null ? Date.now : deps.now;
  const looksFresh = (c) => (c == null || c.expires_at == null ? 0 : c.expires_at) - now() > SKEW_MS;

  // A caller that asked for more than the hook budget has a human waiting on it, so its store read
  // gets the longer cap and a second attempt when the first is killed rather than answered. Hooks
  // keep the fail-fast default: their whole budget is 10s and they still have work to do after.
  const interactive = options.waitMs != null && options.waitMs > HOOK_REFRESH_WAIT_MS;

  let first;
  try {
    first = await readCredentials(deps, { account, interactive });
  } catch { first = null; }
  if (first == null) return settle(result(AUTH_STATES.UNAVAILABLE, AUTH_REASONS.STORAGE_UNAVAILABLE));
  if (first.status === CREDENTIAL_STATUS.NONE) {
    return settle(result(AUTH_STATES.UNLINKED, AUTH_REASONS.NO_CREDENTIALS));
  }
  if (first.status !== CREDENTIAL_STATUS.READY) {
    const reason = first.reason === UNAVAILABLE_REASONS.BACKEND_TIMEOUT
      ? AUTH_REASONS.STORAGE_TIMEOUT
      : AUTH_REASONS.STORAGE_UNAVAILABLE;
    return settle(result(AUTH_STATES.UNAVAILABLE, reason));
  }

  const generation = first.generation;
  const facts = credentialFacts(first.credentials);

  // A generation the provider has definitively rejected. Nothing was deleted; the credentials
  // and the registered client are still there, and only a new login clears this.
  const reauth = readReauthMarker(account, generation);
  if (reauth != null) {
    return settle(result(AUTH_STATES.REAUTH_REQUIRED, reauth.reason, { generation, ...facts }));
  }
  if (!options.forceRefresh && looksFresh(first.credentials)) {
    return settle(ready(first.credentials.access_token, generation, facts));
  }
  if (typeof first.credentials.refresh_token !== 'string' || !first.credentials.refresh_token) {
    return settle(result(
      AUTH_STATES.REAUTH_REQUIRED, AUTH_REASONS.MISSING_REFRESH_TOKEN, { generation, ...facts },
    ));
  }

  // Somebody is already on it. A marker whose owner is gone means the grant may have been spent
  // without its replacement landing — the worker records that and preserves the credentials.
  const inflight = readInflight(account);
  if (inflight != null && inflight.generation === generation && isWorkerAlive(inflight, deps)) {
    return settle(result(
      AUTH_STATES.REFRESHING, AUTH_REASONS.REFRESH_IN_PROGRESS, { generation, ...facts },
    ));
  }

  // Seven hooks can fire together on one expiring token. A live lock owner means somebody is
  // already doing this work, and spawning six more workers that all answer `busy` costs six
  // node processes for nothing.
  const owner = readCredentialLockOwner(account);
  if (owner != null && isWorkerAlive({ pid: owner.pid, startedAt: owner.startedAt }, deps)) {
    return settle(result(
      AUTH_STATES.REFRESHING, AUTH_REASONS.REFRESH_IN_PROGRESS, { generation, ...facts },
    ));
  }

  const backoff = inflight == null ? readBackoff(account, generation) : null;
  if (backoff != null && backoff.nextAttemptAt > now() && !options.ignoreBackoff) {
    return settle(result(AUTH_STATES.UNAVAILABLE, backoff.reason, { generation, ...facts }));
  }

  const spawn = deps.spawnWorker == null ? defaultSpawnWorker : deps.spawnWorker;
  const spawned = spawn(generation, Boolean(options.forceRefresh), { ...deps, account });
  const waitMs = options.waitMs == null ? HOOK_REFRESH_WAIT_MS : options.waitMs;
  const settledResult = await waitForWorker(account, generation, waitMs, deps);
  if (settledResult != null) return settle({ ...facts, ...settledResult });
  if (!spawned) {
    // A machine that refuses to spawn (EPERM, EMFILE, a locked-down policy) can still recover:
    // the next hook tries again. Its own reason, not refresh_interrupted — no worker ever
    // started, so no grant can have been spent.
    return settle(result(
      AUTH_STATES.UNAVAILABLE, AUTH_REASONS.REFRESH_SPAWN_FAILED, { generation, ...facts },
    ));
  }
  return settle(result(AUTH_STATES.REFRESHING, AUTH_REASONS.REFRESH_IN_PROGRESS, { generation, ...facts }));
}

function ready(accessToken, generation, facts) {
  return {
    authState: AUTH_STATES.READY, reason: AUTH_REASONS.OK, accessToken, generation, ...facts,
  };
}

// Records the transition and turns the first `ready` after any non-ready state into `recovered`,
// which is the event Task 5 reports as a recovery rather than as normal traffic.
function settleAccount(account, value) {
  const recovering = value.authState === AUTH_STATES.READY && !wasReady(account);
  const reason = recovering ? AUTH_REASONS.RECOVERED : value.reason;
  recordAuthResult({ authState: value.authState, reason }, { account });
  try { recordLastAuthState(account, value.authState, value.authState === AUTH_STATES.READY ? AUTH_REASONS.OK : reason); }
  catch { /* a state hint is never worth failing a hook over */ }
  return { ...value, reason };
}

function wasReady(account) {
  try {
    return wasLastStateReady(account);
  } catch {
    return true; // unknown: report `ok`, never a false recovery
  }
}

function defaultSpawnWorker(generation, force, deps) {
  const args = ['--account', deps.account, '--generation', String(generation)];
  if (force) args.push('--force');
  return spawnDetached(WORKER_SCRIPT, deps, args);
}

// Polls the CHEAP files only — the control record and the two markers. Rereading the credential
// store here would spawn `security`/`secret-tool` on every poll, which costs more than the wait
// it is trying to bound. One real read happens, at most, once a change is visible.
async function waitForWorker(account, generation, waitMs, deps) {
  const now = deps.now == null ? Date.now : deps.now;
  // Deliberately NOT unref'd: the detached child is unref'd and stdin is already drained, so
  // while a hook waits here this timer is the only handle keeping its process alive.
  const sleep = deps.sleep == null ? defaultSleep : deps.sleep;
  const pollMs = deps.pollMs == null ? POLL_MS : deps.pollMs;
  const deadline = now() + waitMs;
  for (;;) {
    const control = readJson(credentialControlFile(account), null);
    if (control != null && typeof control.generation === 'number' && control.generation !== generation) {
      const next = await readCredentials(deps, { account }).catch(() => null);
      if (next != null && next.status === CREDENTIAL_STATUS.READY) {
        return ready(next.credentials.access_token, next.generation, credentialFacts(next.credentials));
      }
      return result(AUTH_STATES.UNAVAILABLE, AUTH_REASONS.STORAGE_UNAVAILABLE, { generation: null });
    }
    const reauth = readReauthMarker(account, generation);
    if (reauth != null) {
      return result(AUTH_STATES.REAUTH_REQUIRED, reauth.reason, { generation });
    }
    const backoff = readBackoff(account, generation);
    if (backoff != null && backoff.nextAttemptAt > now()) {
      return result(AUTH_STATES.UNAVAILABLE, backoff.reason, { generation });
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

// Compatibility wrapper for the many callers that only need a bearer token and have no user-
// facing decision to make (checkpoint, usage-ping, session-audit, track-session, audit-flush,
// billing-capture, key-resolve). Everything that talks to the user reads getAuthentication.
export async function getAccessToken(deps = {}, options = {}) {
  const auth = await getAuthentication(deps, options);
  return auth.authState === AUTH_STATES.READY ? auth.accessToken : null;
}
