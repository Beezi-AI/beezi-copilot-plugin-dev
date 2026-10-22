import { rotateInstallationId as _rotateInstallationId } from '../telemetry/installation-id.mjs';
import { unlinkOnServer, revokeAtAuthServer } from '../auth/machine-unlink.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { readIndex, resolveAccountRef, setDefault, removeAccount } from '../accounts/index-store.mjs';
import { describeAccount } from '../accounts/refs.mjs';
import {
  readCredentials, deleteCredentialGeneration, deleteAllGenerationEntries,
  CREDENTIAL_STATUS, DELETE_STATUS,
} from '../credentials/generation-store.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../credentials/credential-lock.mjs';
import { clearAuthMarkers } from '../credentials/auth-markers.mjs';
import { recordLogout, recordLogoutUnconfirmed } from '../auth/diagnostics.mjs';
import { auditLedgerFile } from '../config/paths.mjs';
import { removePath } from '../platform/fs-store.mjs';
import { clearTrackingState } from '../state/tracking.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from '../auth/token.mjs';
import { AUTH_STATES } from '../contract/auth-states.mjs';
import { UserError } from '../core/errors.mjs';
import { checkInteractive as _checkInteractive } from '../host/mode-guard.mjs';
import { forgetAccountInSessions } from '../workspace/session-routes.mjs';

const LOGOUT_LOCK_WAIT_MS = 30_000;
const NOT_LINKED = 'Beezi: this machine is not linked. Nothing to do.';
const MORE_THAN_ONE = '✗ More than one account is linked — pick one.';

// Explicit logout, as lines. Never claims a server unlink it did not get, and never claims to
// have logged out when the credentials are still there. `single` logs out the only linked account in
// the same call; with none or several linked it removes nothing and lists them, as `list` does.
export async function runLogout(deps = {}, options = {}) {
  if (options.list) return listLines(await readIndex(deps));
  if (options.single) {
    const index = await readIndex(deps);
    if (index.accounts.length !== 1) return index.accounts.length === 0 ? listLines(index) : [MORE_THAN_ONE, ...listLines(index)];
  }
  // Past here an account is removed, so an unattended session must not reach it.
  const verdict = await (deps.checkInteractive || _checkInteractive)({ purpose: 'logging out of Beezi', requireWrite: true });
  if (verdict != null && verdict.ok === false) return [`✗ ${verdict.message}`];
  const lifecycle = await acquireCredentialLock({ lifecycle: true, waitMs: deps.lockWaitMs == null ? 30_000 : deps.lockWaitMs }, deps);
  if (!lifecycle) throw new UserError('Another Beezi account change is in progress. Retry /beezi-dev-logout in a moment.');
  try { return await logoutAccounts(deps, options); }
  finally { releaseCredentialLock(lifecycle); }
}

function listLines(index) {
  if (!index.accounts.length) return [NOT_LINKED];
  return index.accounts.map((a, i) => `${i + 1}. ${describeAccount(a)} [${a.key}]${a.key === index.default ? ' (default)' : ''}`);
}

// Read again under the lock, so an account linked after `single` counted one lands in the --account refusal.
async function logoutAccounts(deps, options) {
  const index = await readIndex(deps);
  if (!index.accounts.length) return [NOT_LINKED];
  if (!options.all && !options.account && index.accounts.length > 1) throw new UserError('Choose --account <key|email|number> or --all. Run /beezi-dev-settings account to list accounts.');
  const keys = options.all ? index.accounts.map(a => a.key) : [options.account ? await resolveAccountRef(options.account, deps) : index.accounts[0].key];
  const remaining = index.accounts.filter(a => !keys.includes(a.key));
  let next = null;
  if (options.nextDefault) {
    next = await resolveAccountRef(options.nextDefault, deps);
    if (!remaining.some(a => a.key === next)) throw new UserError('The next default must be an account that remains linked.');
  }
  if (keys.includes(index.default) && remaining.length && !next) throw new UserError('Choose the remaining analytics default with --next-default <key|email|number> before logging out.');
  const lines = [];
  for (const account of keys) {
    lines.push(`${describeAccount(index.accounts.find(a => a.key === account))}:`, ...await logoutOne(account, deps));
    if (account === index.default && next) await setDefault(next, deps);
    // Credentials are already tombstoned; the row goes, then the directory, then the sessions forget the account.
    await removeAccount(account, deps);
    forgetAccountInSessions(account);
  }
  // No account remains to carry this machine's diagnostics. A later login must not inherit
  // the departed account's diagnostic identity; consent itself remains a machine preference.
  if (!remaining.length) {
    try { (deps.rotateInstallationId || _rotateInstallationId)(); } catch (_) { /* best-effort */ }
  }
  return lines;
}

async function logoutOne(account, deps) {
  const getAuthentication = deps.getAuthentication == null ? _getAuthentication : deps.getAuthentication;

  const before = await readCredentials(deps, { account }).catch(() => null);

  // Refreshes when stale and primes the machine-identity headers; a machine whose token cannot
  // be renewed still logs out locally, it just cannot prove the server-side unlink.
  const auth = await getAuthentication(deps, { account, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
  const storedClientId = before && before.credentials && before.credentials.client_id;
  const unlinkSession = (a) => pinnedTo({ key: account, token: a.accessToken, clientId: a.clientId || storedClientId }, a);
  const token = auth != null && auth.authState === AUTH_STATES.READY ? auth.accessToken : null;
  let server = token ? await unlinkOnServer(unlinkSession(auth), deps) : { unlinked: false, httpStatus: null };

  if (server.httpStatus === 401) {
    const retry = await getAuthentication(deps, { account, forceRefresh: true, waitMs: INTERACTIVE_REFRESH_WAIT_MS }).catch(() => null);
    if ((retry && retry.authState) === AUTH_STATES.READY) server = await unlinkOnServer(unlinkSession(retry), deps);
  }

  // The lock, then a REREAD: a refresh worker may have committed a new generation while the
  // DELETE was in flight, and deleting the generation read before that would leave the new one.
  const lock = await acquireCredentialLock(
    { account, waitMs: deps.lockWaitMs == null ? LOGOUT_LOCK_WAIT_MS : deps.lockWaitMs }, deps,
  );
  if (lock == null) {
    // Deliberately fatal. Printing "✓ Logged out" while the credentials are still stored is
    // exactly the lie this replaces.
    throw new UserError(
      'Another Beezi process is using the saved login, so nothing was removed. '
      + 'Wait a moment and run /beezi-dev-logout again.',
    );
  }
  let revoked = false;
  try {
    const current = await readCredentials(deps, { account, lock }).catch(() => null);
    const credentials = current != null && current.status === CREDENTIAL_STATUS.READY
      ? current.credentials
      : null;
    if (!server.unlinked) revoked = await revokeAtAuthServer(credentials, deps);
    const removal = await deleteCredentialGeneration({ account, lock, force: true }, deps);
    if (removal.status !== DELETE_STATUS.DELETED) {
      throw new UserError(
        'Could not remove the saved Beezi authorization from this machine. Try /beezi-dev-logout again.',
      );
    }
    // Orphans too: a generation entry a lock-lost commit left behind is never read, but a refresh
    // orphan holds the ROTATED refresh token — the live one — while the committed generation's is
    // already dead. Safe here and only here, because logout holds the lock.
    deleteAllGenerationEntries({ ...deps, account, lock });
    // Invalidates any refresh commit still in flight: its expected generation is gone, so its
    // CAS fails and nothing repopulates the store behind the logout.
    recordLogout();
    clearAuthMarkers(account);
  } finally {
    releaseCredentialLock(lock);
  }

  // Remove state belonging to this account only.
  clearTrackingState(account);
  try { removePath(auditLedgerFile(account), { force: true }); } catch { /* best-effort */ }

  if (server.unlinked) return ['✓ Logged out. This machine is unlinked from Beezi.'];
  if (revoked) {
    return [
      '✓ Logged out and access revoked.',
      '  The portal may still list this machine — remove it from the Connections tab.',
    ];
  }
  recordLogoutUnconfirmed(server.httpStatus);
  const refused = server.httpStatus === 401 || server.httpStatus === 403;
  return [
    '✓ Logged out locally.',
    refused
      ? `  The server refused the unlink request (HTTP ${server.httpStatus}), so this machine may still appear linked in the portal.`
      : '  Could not reach the server — this machine may still appear linked in the portal.',
    '  You can remove it from the Connections tab there.',
  ];
}
