import crypto from 'crypto';
import { apiBase, OAUTH_SCOPES } from '../config/api.mjs';
import { markLinked, recordWhoami } from '../state/tracking.mjs';
import { discover as _discover, registerClient as _registerClient, pkcePair, toBase64Url, exchangeCode as _exchangeCode } from '../auth/oauth.mjs';
import { commitCredentials, deleteCredentialGeneration, deleteAllGenerationEntries, COMMIT_STATUS, DELETE_STATUS } from '../credentials/generation-store.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../credentials/credential-lock.mjs';
import { clearAuthMarkers } from '../credentials/auth-markers.mjs';
import { startLoopback as _startLoopback } from '../auth/loopback.mjs';
import { savePendingLogin, takePendingLogin, pasteBackRedirectUri as _pasteBackRedirectUri, PENDING_LOGIN_TTL_MS } from '../auth/pending-login.mjs';
import { openBrowser } from '../platform/browser.mjs';
import { readIndex, listAccounts, findByEmail, newAccountKey, addAccount, updateAccount } from '../accounts/index-store.mjs';
import { describeAccount } from '../accounts/refs.mjs';
import { unlinkOnServer, revokeAtAuthServer } from '../auth/machine-unlink.mjs';
import { pinnedTo } from '../auth/recipients.mjs';
import { readTrackingState } from '../state/tracking.mjs';
import { probeIdentity as _probeIdentity, PROBE_OUTCOMES } from '../auth/whoami.mjs';
import { getAuthentication as _getAuthentication, INTERACTIVE_REFRESH_WAIT_MS } from '../auth/token.mjs';
import { AUTH_STATES, AUTH_REASONS } from '../contract/auth-states.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from '../billing/account-sync.mjs';
import { reconcileBillingConfig as _reconcileBillingConfig } from '../billing/plan-reconcile.mjs';
import { readVscodeEntitlements as _readVscodeEntitlements } from '../sources/vscode/entitlement.mjs';
import { checkInteractive as _checkInteractive } from '../host/mode-guard.mjs';
import { DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { recordAuthResult as _recordAuthResult } from '../auth/diagnostics.mjs';
import { UserError } from '../core/errors.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { currentSessionWorkspace } from '../workspace/session-routes.mjs';
import { nonEmpty } from '../core/guards.mjs';

const SIGN_OUT_HINT = 'To add a different account, sign out of Beezi in the browser first or use a private window.';

export const LOGIN_MODES = Object.freeze({ BROWSER: 'browser', NO_BROWSER: 'no-browser', COMPLETE: 'complete' });
const USAGE = 'Usage: login.mjs [--no-browser | --complete <redirect-url-or-code>]';

// The script's arguments → { mode, pasted }: no flag is the loopback flow; the other two are the paste-back pair.
export function parseLoginArgs(args = []) {
  if (args.length === 0) return { mode: LOGIN_MODES.BROWSER, pasted: null };
  if (args.length === 1 && args[0] === '--no-browser') return { mode: LOGIN_MODES.NO_BROWSER, pasted: null };
  if (args.length === 2 && args[0] === '--complete' && String(args[1]).trim() !== '') return { mode: LOGIN_MODES.COMPLETE, pasted: args[1] };
  throw new UserError(USAGE);
}

// Browser authorization always mints a separate client; it cannot silently change an existing
// machine's client id and link date. Publishing credentials still uses the generation CAS lock.
export async function runLogin(deps = {}) {
  const { mode, pasted } = parseLoginArgs(deps.args);
  const ctx = loginContext(deps);
  // Linking persists an account, so an unattended session must not reach the browser or any write.
  const verdict = await (deps.checkInteractive || _checkInteractive)({ purpose: 'linking a Beezi account', requireWrite: true });
  if (verdict != null && verdict.ok === false) {
    ctx.log(`✗ ${verdict.message}`);
    return { status: 'refused' };
  }
  const linked = await listAccounts(deps);
  if (mode === LOGIN_MODES.COMPLETE) return linkAccount(ctx, linked, pastedGrant(ctx, pasted));
  printLinked(ctx.log, linked);
  if (mode === LOGIN_MODES.NO_BROWSER) return startPasteBack(ctx);
  return linkAccount(ctx, linked, await authorizeInBrowser(ctx));
}

// Exchanges `grant` and publishes the account it belongs to.
async function linkAccount(ctx, linked, grant) {
  // Reserve a keyed store before exchange so a lock failure cannot discard an issued grant.
  const provisional = newAccountKey();
  const lock = await acquireCredentialLock({ ...ctx.lockOptions, account: provisional }, ctx.deps);
  if (!lock) throw new UserError('Another Beezi process is using the saved login. Retry /beezi-dev-login in a moment.');
  const run = { ...ctx, linked, grant, provisional, lock, fresh: null, creds: null, lifecycle: null, committed: false };
  try {
    return await linkGrant(run);
  } catch (error) {
    if (!run.committed) await discardFresh(run).catch(() => {});
    throw error;
  } finally { if (run.lifecycle) releaseCredentialLock(run.lifecycle); releaseCredentialLock(run.lock); }
}

function loginContext(deps) {
  return {
    deps,
    log: deps.log || console.log,
    base: deps.base || apiBase(),
    now: deps.now || Date.now,
    probeIdentity: deps.probeIdentity || _probeIdentity,
    getAuthentication: deps.getAuthentication || _getAuthentication,
    sync: deps.syncAccountIfNeeded || _syncAccountIfNeeded,
    lockOptions: { waitMs: deps.lockWaitMs == null ? 30_000 : deps.lockWaitMs },
  };
}

function printLinked(log, linked) {
  log('\nBeezi analytics — link an account\n');
  if (!linked.length) return;
  for (const a of linked) log(`  ${describeAccount(a)}${a.status === 'revoked' ? ' (revoked)' : ''}`);
  log('Your browser signs in as whichever Beezi account it is already signed in as.');
  log(SIGN_OUT_HINT);
}

async function discoverEndpoints(deps) {
  try { return await (deps.discover || _discover)(); }
  catch (e) { e.loginReason = AUTH_REASONS.DISCOVERY_FAILED; throw e; }
}

async function registerFor(deps, meta, redirectUri) {
  try { return await (deps.registerClient || _registerClient)(meta.registrationEndpoint, redirectUri); }
  catch (e) { e.loginReason = AUTH_REASONS.REGISTRATION_FAILED; throw e; }
}

function newState() {
  return toBase64Url(crypto.randomBytes(16));
}

function authorizationUrl(meta, { clientId, redirectUri, state, challenge }) {
  return `${meta.authorizationEndpoint}?${new URLSearchParams({ response_type: 'code', client_id: clientId,
    redirect_uri: redirectUri, scope: OAUTH_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
}

// Discovery, client registration and the browser round trip: { meta, clientId, redirectUri, code, verifier }.
async function authorizeInBrowser({ deps, log }) {
  const meta = await discoverEndpoints(deps);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const lb = await (deps.startLoopback || _startLoopback)({ port: 0, expectedState: state });
  const clientId = await registerFor(deps, meta, lb.redirectUri);
  const url = authorizationUrl(meta, { clientId, redirectUri: lb.redirectUri, state, challenge });
  log(`Opening your browser to sign in with your Beezi account…\nIf it does not open, go to:\n  ${url}\n`);
  (deps.openBrowser || openBrowser)(url, {});
  let code;
  try { code = await lb.code; }
  catch (e) { e.loginReason = AUTH_REASONS.LOGIN_CANCELLED; throw e; }
  return { meta, clientId, redirectUri: lb.redirectUri, code, verifier };
}

// First half of the paste-back flow: registers a loopback redirect nothing listens on and saves the grant 0600 for --complete.
async function startPasteBack({ deps, log, now }) {
  const meta = await discoverEndpoints(deps);
  const { verifier, challenge } = pkcePair();
  const state = newState();
  const redirectUri = (deps.pasteBackRedirectUri || _pasteBackRedirectUri)();
  const clientId = await registerFor(deps, meta, redirectUri);
  savePendingLogin({ verifier, state, clientId, redirectUri, tokenEndpoint: meta.tokenEndpoint }, now());
  log(`Open this link in a browser on any device and sign in with your Beezi account:\n  ${authorizationUrl(meta, { clientId, redirectUri, state, challenge })}\n`);
  log('After you sign in, the browser tries to open an http://127.0.0.1 address and shows an error page. That is expected.');
  log(`Copy the full address from its address bar and paste it here within ${PENDING_LOGIN_TTL_MS / 60_000} minutes.`);
  log('login=pending');
  return { status: 'pending' };
}

// Second half: the pasted redirect checked against the saved state and turned back into a grant.
function pastedGrant({ now }, pasted) {
  try { return takePendingLogin(pasted, now()); }
  catch (e) { e.loginReason = AUTH_REASONS.LOGIN_CANCELLED; throw e; }
}

// Unlinks the fresh grant on the server, else revokes it at the auth server; a no-op once it is gone.
async function discardFresh({ deps, fresh, creds }) {
  if (!fresh) return;
  const result = await (deps.unlinkOnServer || unlinkOnServer)(fresh, deps);
  if ((!result || !result.unlinked)) await (deps.revokeAtAuthServer || revokeAtAuthServer)(creds, deps);
}

// Everything after the browser hands back a code, under the provisional account's lock.
async function linkGrant(run) {
  const who = await exchangeAndVerify(run);
  run.lifecycle = await acquireCredentialLock({ ...run.lockOptions, lifecycle: true }, run.deps);
  if (!run.lifecycle) throw new UserError('Another Beezi account change is in progress. Retry /beezi-dev-login in a moment.');
  const identity = { email: who.email.toLowerCase(), name: who.name, tenantId: who.tenantId, tenantName: who.tenantName,
    tenants: Array.isArray(who.tenants) ? who.tenants : null };
  await identifyMigratedRows(run);
  const existing = await findByEmail(identity.email, run.deps);
  if ((existing && existing.status) === 'linked') {
    const already = await reuseExisting(run, existing);
    if (already != null) return already;
  }
  const key = (existing && existing.key) || run.provisional;
  await lockAccount(run, key);
  const commit = await publishCredentials(run, key, { ...identity, clientId: run.grant.clientId, status: 'linked' }, existing);
  return finishLink(run, { key, who, identity, existing, commit });
}

// Exchanges the code for tokens and verifies who they belong to; sets run.creds and run.fresh, returns the identity.
async function exchangeAndVerify(run) {
  const { deps, grant } = run;
  let tokens;
  try { tokens = await (deps.exchangeCode || _exchangeCode)({ tokenEndpoint: grant.meta.tokenEndpoint, clientId: grant.clientId, redirectUri: grant.redirectUri, code: grant.code, verifier: grant.verifier }); }
  catch (e) { e.loginReason = AUTH_REASONS.EXCHANGE_FAILED; throw e; }
  if (!nonEmpty(tokens.access_token) || !nonEmpty(tokens.refresh_token)) {
    const e = new UserError('The login server did not return a usable session. Your previous Beezi authorization is untouched — try /beezi-dev-login again.');
    e.loginReason = AUTH_REASONS.EXCHANGE_FAILED; throw e;
  }
  // api_origin pins the grant to the API it was issued for; a version that predates it ignores the field.
  const apiOrigin = new URL(run.base).origin;
  run.creds = { client_id: grant.clientId, redirect_uri: grant.redirectUri, token_endpoint: grant.meta.tokenEndpoint, scope: OAUTH_SCOPES,
    api_origin: apiOrigin, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    expires_at: run.now() + (tokens.expires_in == null ? 3600 : tokens.expires_in) * 1000 };
  run.fresh = { key: run.provisional, token: tokens.access_token, clientId: grant.clientId, apiOrigin };
  const verified = await run.probeIdentity(run.fresh, { ...deps, base: run.base });
  if (verified.outcome !== PROBE_OUTCOMES.AUTHENTICATED || !nonEmpty(verified.identity && verified.identity.email)) {
    throw new UserError('Signed in, but Beezi could not verify this account. Your saved accounts are untouched. Retry /beezi-dev-login.');
  }
  return { valid: true, ...verified.identity };
}

// The probe session for a ready stored grant, pinned to its API origin when the grant recorded one.
function storedSession(a, auth) {
  return pinnedTo({ key: a.key, token: auth.accessToken, clientId: auth.clientId || a.clientId }, auth);
}

// A stored account's own grant, refreshed once on a 401: { auth, probe, session }; probe is null when it cannot be used.
async function checkStored(a, { deps, base, probeIdentity, getAuthentication }) {
  let auth = await getAuthentication(deps, { account: a.key, waitMs: INTERACTIVE_REFRESH_WAIT_MS });
  if (auth.authState !== AUTH_STATES.READY) return { auth, probe: null };
  let session = storedSession(a, auth);
  let probe = await probeIdentity(session, { ...deps, base });
  if (probe.outcome === PROBE_OUTCOMES.UNAUTHORIZED && probe.originMismatch !== true) {
    auth = await getAuthentication(deps, { account: a.key, forceRefresh: true, waitMs: INTERACTIVE_REFRESH_WAIT_MS });
    if (auth.authState === AUTH_STATES.READY) {
      session = storedSession(a, auth);
      probe = await probeIdentity(session, { ...deps, base });
    } else probe = null;
  }
  return { auth, probe, session };
}

// A migrated row must be identified by its own grant, never guessed from the new login.
async function identifyMigratedRows(run) {
  for (const a of run.linked.filter(a => !a.email && a.status === 'linked')) {
    const check = await checkStored(a, run);
    if ((check.probe && check.probe.outcome) === PROBE_OUTCOMES.AUTHENTICATED) {
      await updateAccount(a.key, { ...check.probe.identity, clientId: check.session.clientId }, run.deps);
    } else {
      throw new UserError('An existing account could not be identified. Retry when its authorization can be checked, or remove it with /beezi-dev-logout before adding an account.');
    }
  }
}

// A linked row for the same email whose grant still works keeps it ({ status: 'already_linked' }); a dead one returns
// null so the new grant replaces it; anything that cannot be verified now throws.
async function reuseExisting(run, existing) {
  const { deps, log } = run;
  const check = await checkStored(existing, run);
  if ((check.probe && check.probe.outcome) === PROBE_OUTCOMES.AUTHENTICATED) {
    await discardFresh(run); run.fresh = null;
    // Stores the probe's workspace list so a join made since session start reaches joined and the upload.
    try { await updateAccount(existing.key, check.probe.identity, deps); } catch { /* best-effort */ }
    log(`\n✓ This machine is already linked as ${describeAccount(existing)}.`);
    log(SIGN_OUT_HINT);
    await logDefaultReader(run, existing.key);
    log(`account=${existing.key}`);
    return { status: 'already_linked', account: existing.key };
  }
  if (check.auth.reason === AUTH_REASONS.MISSING_REFRESH_TOKEN) {
    (deps.recordAuthResult || _recordAuthResult)({ authState: AUTH_STATES.REAUTH_REQUIRED, reason: AUTH_REASONS.CONSENT_REQUIRED }, { account: existing.key, source: DIAGNOSTIC_SOURCES.LOGIN });
  }
  const dead = check.auth.authState === AUTH_STATES.REAUTH_REQUIRED || check.auth.authState === AUTH_STATES.UNLINKED
    || (check.probe && check.probe.outcome) === PROBE_OUTCOMES.UNAUTHORIZED;
  if (!dead) throw new UserError('Your existing account could not be verified right now. Its saved authorization is untouched; retry later.');
  return null;
}

// Swaps the provisional lock for the existing account's own when the grant replaces that account's.
async function lockAccount(run, key) {
  if (key === run.provisional) return;
  const targetLock = await acquireCredentialLock({ ...run.lockOptions, account: key }, run.deps);
  if (!targetLock) throw new UserError('Another Beezi process is using this account. Retry /beezi-dev-login in a moment.');
  releaseCredentialLock(run.lock); run.lock = targetLock;
}

// Commits the new generation and publishes the row (an existing one before, a new one after); returns the commit.
async function publishCredentials(run, key, metadata, existing) {
  const { deps } = run;
  // Publish an existing row before replacing its generation: if the index is unwritable,
  // the previous authorization is still exactly intact and discoverable. The account lock
  // keeps refresh writers out; session readers derive their client id from the generation.
  if (existing) await (deps.updateAccount || updateAccount)(key, metadata, deps);
  let commit;
  try {
    commit = await (deps.commitCredentials || commitCredentials)(run.creds, { account: key, lock: run.lock, force: true }, deps);
    if (commit.status !== COMMIT_STATUS.COMMITTED) throw new UserError('Could not store the new Beezi authorization. Try /beezi-dev-login again.');
  } catch (error) {
    if (existing) {
      try { await updateAccount(key, existing, deps); }
      catch (_) { throw new UserError('Could not save the new authorization or restore its account details. The account is still listed; retry /beezi-dev-login to repair it.'); }
    }
    throw error;
  }
  run.committed = true;
  if (!existing) await addNewAccount(run, key, metadata, commit);
  return commit;
}

async function addNewAccount(run, key, metadata, commit) {
  const { deps } = run;
  try { await (deps.addAccount || addAccount)({ key, ...metadata }, deps); }
  catch (error) {
    // This key has never been published. Remove only our own generation while its lock
    // is still held, then let the outer failure path revoke the unused browser grant.
    run.committed = false;
    const removed = await deleteCredentialGeneration({ account: key, lock: run.lock, expectedGeneration: commit.generation }, deps);
    if (removed.status !== DELETE_STATUS.DELETED) {
      throw new UserError(`Could not publish or remove the new account (${key}). Retry /beezi-dev-login; the unused browser grant is being revoked.`);
    }
    deleteAllGenerationEntries({ ...deps, account: key, lock: run.lock });
    throw new UserError('Could not publish the new Beezi account. Its saved authorization was removed; retry /beezi-dev-login.');
  }
}

// Local bookkeeping, the success lines and one check-in per current target, once the account is published.
async function finishLink(run, { key, who, identity, existing, commit }) {
  const { log, grant } = run;
  clearAuthMarkers(key);
  const tracking = readTrackingState(key);
  if (!tracking || !tracking.linkedAt) markLinked(key);
  recordWhoami(key, who, grant.clientId);
  log(`\n✓ Beezi analytics linked as ${describeAccount(identity)}. Credentials stored in ${commit.where}.`);
  await logDefaultReader(run, key);
  // Records the GitHub identity and plan first, so the check-in below carries them (never throws).
  try {
    const entitlements = await (run.deps.readVscodeEntitlements || _readVscodeEntitlements)();
    (run.deps.reconcileBillingConfig || _reconcileBillingConfig)({ entitlements });
  } catch { /* best-effort */ }
  await checkInTargets(run, key, identity, existing);
  log(`account=${key}`);
  return { status: 'linked', account: key, where: commit.where, clientId: grant.clientId };
}

// Names the account /beezi-dev-analytics reads from when it is not `key`.
async function logDefaultReader({ deps, log }, key) {
  const index = await readIndex(deps);
  if (index.default !== key) log(`  /beezi-dev-analytics still reads from ${describeAccount(index.accounts.find(a => a.key === index.default))}.`);
}

// One check-in per current target; the existing row supplies rules and New folders, and a pending session checks in once a rule or New folders answers it.
// A whoami without tenants keeps the stored list, so a multi-workspace account never checks in headerless.
async function checkInTargets(run, key, identity, existing) {
  const merged = { ...(existing || {}), ...identity, key, tenants: identity.tenants != null ? identity.tenants : (existing ? existing.tenants : null) };
  const resolved = resolveTargets(merged, currentSessionWorkspace());
  for (const tenantId of resolved.targets) {
    const session = resolved.multi ? { ...run.fresh, key, tenantId } : { ...run.fresh, key };
    await run.sync(session, { force: true, via: 'login' }).catch(() => {});
  }
}
