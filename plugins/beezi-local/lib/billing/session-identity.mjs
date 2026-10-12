// Owns the one order that names the GitHub account a session ran under, for the CLI, the app, VS Code and history alike.
import { identityKey } from '../core/github-identity.mjs';
import { processEnvAccount, runtimeSignInKey, signedInIdentityKeys } from '../sources/cli/copilot-identity.mjs';
import { resolveSessionAccount, sessionSpan } from '../sources/cli/session-account.mjs';
import { resolveVscodeAccount, vscodeAccountAt } from '../sources/vscode/account.mjs';
import { appAccounts, appSessionAccount, isAppSession } from '../sources/app/app-db.mjs';
import { currentVscodeSignIn, vscodeSignedIn } from './billing-local.mjs';

// BOUND: evidence names the account (persist it). CURRENT: no evidence and the machine knows at most one account, so the
// current one stands (`account` when the surface names it, else the run's identity). OMIT: no evidence and several
// accounts are known, so the report carries no account rather than a guess.
export const SessionIdentityStatus = Object.freeze({ BOUND: 'bound', CURRENT: 'current', OMIT: 'omit' });

export const SessionAccountSource = Object.freeze({ PROCESS_ENV: 'process-env', APP_DB: 'app-db' });

// The `surface` values that change the order: VS Code Local chat sessions and VS Code Agent Host CLI sessions.
export const IdentitySurface = Object.freeze({ VSCODE: 'vscode', VSCODE_AGENT_HOST: 'vscode-agent-host' });

function withSource(found, source) {
  const key = found == null ? null : identityKey(found.host, found.login);
  return key == null ? null : { key, host: found.host, login: found.login, source };
}

// An app session the app holds no binding for while it has several accounts: the shared app log serves every account,
// so only the session's own evidence may name one.
async function ambiguousAppSession(sessionId) {
  return (await isAppSession(sessionId)) && (await appAccounts()).length > 1;
}

// An events.jsonl session (CLI, app, Agent Host): this process's own app account, the app's durable binding, VS Code's
// account for an Agent Host session, then the Copilot process logs (strictly) and the transcript's /login notice.
async function transcriptSessionAccount(input) {
  const own = input.ownProcess === true ? withSource(processEnvAccount(input.env), SessionAccountSource.PROCESS_ENV) : null;
  if (own != null) return own;
  const app = withSource(await appSessionAccount(input.sessionId), SessionAccountSource.APP_DB);
  if (app != null) return app;
  const opts = { events: input.events, transcriptPath: input.transcriptPath };
  if (input.surface === IdentitySurface.VSCODE_AGENT_HOST) {
    const vscode = await vscodeAccountAt(sessionSpan(input.sessionId, opts).firstMs);
    if (vscode != null) return vscode;
  }
  return resolveSessionAccount(input.sessionId, { ...opts, strict: await ambiguousAppSession(input.sessionId) });
}

// The '<host>/<login>' keys of every GitHub account this machine knows: Copilot CLI logins, a gh CLI sign-in the runtime
// reported, Copilot app accounts and VS Code's Copilot Chat sign-in. Never throws.
export async function knownAccountKeys() {
  const keys = signedInIdentityKeys();
  keys.push(runtimeSignInKey());
  for (const account of await appAccounts()) keys.push(identityKey(account.host, account.login));
  const vscode = vscodeSignedIn();
  if (vscode != null) keys.push(vscode.key);
  return keys.filter((key, i) => key != null && keys.indexOf(key) === i);
}

// { status, account } for one session. input: { sessionId, surface, events, transcriptPath, vscodeSession, ownProcess, env }.
// surface 'vscode' reads vscodeSession (a readVscodeSession() result); ownProcess is true only on the session's own hook.
export async function resolveSessionIdentity(input) {
  const local = input.surface === IdentitySurface.VSCODE;
  const found = local ? await resolveVscodeAccount(input.vscodeSession) : await transcriptSessionAccount(input);
  if (found != null) return { status: SessionIdentityStatus.BOUND, account: found };
  if ((await knownAccountKeys()).length > 1) return { status: SessionIdentityStatus.OMIT, account: null };
  return { status: SessionIdentityStatus.CURRENT, account: local ? currentVscodeSignIn(input.vscodeSession) : null };
}
