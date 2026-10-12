// When the monthly Copilot quota is re-probed: the detached worker kick for hooks and the single-flight refresh itself.
import { scriptPath } from '../../config/plugin-root.mjs';
import { acquireLock, releaseLock } from '../../platform/single-instance-lock.mjs';
import { spawnDetached } from '../../platform/spawn.mjs';
import { QUOTA_FRESH_MS, PROBE_LOCK, readCache, writeCache, backoffActive, backoffFor, lockHeld, readProbeQuota } from './cache.mjs';
import { MAX_PROBE_MS, probeDisabled, probeQuota } from './runtime-rpc.mjs';
import { QuotaReason } from './snapshot.mjs';
import { processEnvAccount, runtimeSignInKey, signedInIdentityKeys } from '../../sources/cli/copilot-identity.mjs';

// The monthly Copilot quota and the signed-in account's plan, from the Copilot runtime's own
// `account.getQuota` and `account.getCurrentAuth`.
//
// A short-lived Copilot server-mode child answers those calls and nothing else. It sits behind a
// cache, a single-flight lock, a failure backoff and a hard time budget, and it is started only by
// the detached scripts/quota-worker.mjs (or a non-hook process): no hook ever starts the Copilot
// runtime inline. Nothing here spawns at import time.

const SPAWN_GAP_MS = 60 * 1000;

// True in a Copilot app runtime's process whose account is not the terminal's: the cache holds one account, so its
// probe would evict the terminal's answer on every switch. Such an account's quota and plan come from the runtime's user
// cache; an app-only machine, or an app on the terminal's own account, still probes.
function otherThanTerminal(env) {
  const own = processEnvAccount(env);
  if (own == null) return false;
  const terminal = signedInIdentityKeys().concat([runtimeSignInKey()]).filter((key) => key != null);
  return terminal.some((key) => key !== own.key);
}

// Spawns the detached quota worker unless one is pointless or already due. Never waits, never throws.
// Assumes a detached child survives its hook, as the other Beezi workers do.
export function maybeRefreshQuotaInBackground({ env = process.env, now = () => Date.now(), spawn = spawnDetached } = {}) {
  try {
    if (probeDisabled(env) || otherThanTerminal(env)) return false;
    const nowMs = now();
    if (readProbeQuota({ env, now }) != null) return false;
    const cache = readCache();
    if (backoffActive(cache, nowMs)) return false;
    if (cache.lastAttemptAt != null && nowMs - cache.lastAttemptAt < SPAWN_GAP_MS) return false;
    if (lockHeld(nowMs)) return false;
    writeCache({ ...cache, lastAttemptAt: nowMs });
    return spawn(scriptPath('quota-worker.mjs'));
  } catch {
    return false;
  }
}

// The ONLY caller of probeQuota: quota-worker.mjs, or a non-hook process. Probes when the cache is stale,
// no backoff is active and the single-flight lock is ours; otherwise returns the fresh cache or null.
export async function refreshQuota({ budgetMs = MAX_PROBE_MS + 250, probe = probeQuota, now = () => Date.now() } = {}) {
  try {
    const fresh = readProbeQuota({ now });
    if (fresh != null) return fresh;
    const cache = readCache();
    if (backoffActive(cache, now())) return null;
    const timeoutMs = Math.min(budgetMs - 250, MAX_PROBE_MS);
    if (!(timeoutMs >= 500)) return null;
    if (!acquireLock(PROBE_LOCK)) return null;
    try {
      const result = await probe({ timeoutMs });
      const at = now();
      const next = { version: 1, observation: cache.observation, auth: cache.auth, lastAttemptAt: at, lastReason: result.reason, backoffUntil: null };
      if (result.auth != null) next.auth = { ...result.auth, fetchedAt: new Date(at).toISOString() };
      if (result.reason === QuotaReason.OK) next.observation = result.quota;
      // No premium snapshot is not a failure once the account and plan are known: the next probe waits one fresh window.
      else if (result.reason === QuotaReason.NO_QUOTA && result.auth != null) next.backoffUntil = at + QUOTA_FRESH_MS;
      else next.backoffUntil = at + backoffFor(result.reason);
      writeCache(next);
      return result.reason === QuotaReason.OK ? result.quota : null;
    } finally {
      releaseLock(PROBE_LOCK);
    }
  } catch {
    return null;
  }
}
