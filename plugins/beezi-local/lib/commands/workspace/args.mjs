// Argument resolution shared by the workspace subcommands: usage, --session, --account, workspace refs and the attendance check.
import { AccountStatus, getDefaultKey, listAccounts } from '../../accounts/index-store.mjs';
import { currentSessionId } from '../../host/current-session.mjs';
import { findSessionWorkspaceByCwd, readSessionWorkspace } from '../../workspace/session-routes.mjs';
import { isSingleTenant, isMultiTenant, tenantsOf } from '../../workspace/tenants.mjs';
import { refParts, resolveTenantRef } from '../tenant-flags.mjs';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { readSessionHead } from '../../sources/cli/session-files.mjs';
import { UserError } from '../../core/errors.mjs';
import { checkInteractive } from '../../host/mode-guard.mjs';
import { accountLabel } from '../../ux/workspace-lines.mjs';
import { startHistoryWorker } from '../../history/pending-trigger.mjs';

export const USAGE = 'Usage: workspace.mjs rules [--table] [--session <id>] [--account <ref>]'
  + ' | rule add (--current | --repo <url> | --folder <path> | --outside) (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | rule set <n> (<id|name|n>… | none) [--account <ref>]'
  + ' | rule remove <n> [--account <ref>]'
  + ' | rule add-all (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | routes [--session <id>] [--account <ref>]'
  + ' | joined [add-all | done] [--session <id>] [--account <ref>]'
  + ' | new-folders [ask | send <id|name|n>… | none] [--session <id>] [--account <ref>]'
  + ' | read <id|name|n> [--session <id>] [--account <ref>]';

export function parseSessionFlag(argv) {
  const rest = [];
  let session = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') {
      session = argv[++i];
      if (session == null || !isUsableSessionId(session)) throw new UserError('--session needs a Copilot session id.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { session, rest };
}

// --session, then the session Copilot runs this command in, then the newest session recorded for this directory.
export function resolveSession(flag) {
  if (flag != null) return { sessionId: flag, state: readSessionWorkspace(flag) };
  const own = currentSessionId(process.cwd());
  if (own != null) return { sessionId: own, state: readSessionWorkspace(own) };
  const byCwd = findSessionWorkspaceByCwd(process.cwd());
  return byCwd == null ? { sessionId: null, state: null } : byCwd;
}

export function choiceDir(state) {
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

// Refuses (prints ✗ and returns false) when the session answers questions without a person: a guessed answer must not be persisted.
// The session being answered is passed so the verdict is about it, not about whichever session the environment names.
export async function mayPersist(purpose, sessionId = null) {
  // Both the session being answered and the one running this command: pointing --session at an attended sibling must not bypass an autopilot caller.
  const requests = [{ purpose, requireWrite: true }];
  if (sessionId != null) requests.push({ purpose, requireWrite: true, sessionId });
  for (const request of requests) {
    const verdict = await checkInteractive(request);
    if (verdict != null && verdict.ok === false) {
      console.log(`✗ ${verdict.message}`);
      return false;
    }
  }
  return true;
}

// --account, then the default, then the only linked account.
export async function resolveAccount(key) {
  const accounts = await listAccounts();
  const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
  if (accounts.length === 0) throw new UserError('This machine is not linked. Run /beezi-local-login to link an account.');
  let chosen = key;
  if (chosen == null) chosen = await getDefaultKey();
  if (chosen == null && linked.length === 1) chosen = linked[0].key;
  if (chosen == null) throw new UserError('Several accounts are linked and none is the default. Pass --account <ref> (see /beezi-local-settings account).');
  const row = accounts.find((a) => a.key === chosen);
  if (row == null) throw new UserError('No such linked account.');
  return row;
}

// --account's row, else every linked account.
export async function selectedRows(account) {
  return account == null
    ? (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED)
    : [await resolveAccount(account)];
}

export function requireMulti(row) {
  if (!isMultiTenant(row)) {
    throw new UserError(`${accountLabel(row)} has one workspace (or its workspaces are not known yet), so there is nothing to choose.`);
  }
}

// Same refusal as requireMulti, but only for workspaces that aren't known yet: a one-workspace account may still pass none.
export function requireKnownWorkspaces(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) {
    throw new UserError(`${accountLabel(row)}'s workspaces are not known yet. Start a new Copilot session, then try again.`);
  }
}

function refValues(refs) {
  const values = [];
  for (const ref of refs) values.push(...refParts(ref));
  return values;
}

// A one-workspace account's rule refs may only be `none`: there is nothing else to choose.
export function requireNoneForSingle(row, refs) {
  if (!isSingleTenant(row)) return;
  const values = refValues(refs);
  if (values.length === 1 && values[0].toLowerCase() === 'none') return;
  throw new UserError(`${accountLabel(row)} has one workspace, so a rule can only stop tracking a repo or folder. Pass none.`);
}

// Ids/names/positions (comma lists too) in row order; `none` anywhere wins and means send nowhere.
export function selection(row, refs) {
  const values = refValues(refs);
  if (values.length === 0) throw new UserError(USAGE);
  if (values.some((v) => v.toLowerCase() === 'none')) return [];
  const picked = values.map((v) => resolveTenantRef(row, v));
  return tenantsOf(row).map((t) => t.id).filter((id) => picked.indexOf(id) !== -1);
}

// Starts the history upload a write just requested, unless the calling flow uploads next.
export async function afterRuleWrite(key, ctx, deps = {}) {
  if (ctx != null && ctx.deferUpload) return;
  await (deps.startHistoryWorker == null ? startHistoryWorker : deps.startHistoryWorker)(key);
}

// Past sessions come from the Copilot session-file index; the recorded directory is read from each session's head.
export function pastSessionOptions(liveSessionId) {
  return { liveSessionId, readCwd: (p) => (readSessionHead(p) || {}).cwd || null };
}
