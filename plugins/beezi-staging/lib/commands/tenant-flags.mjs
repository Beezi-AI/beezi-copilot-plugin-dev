// The --tenant command flag: workspace references, and the workspaces a command sends to.
import { UserError } from '../core/errors.mjs';
import { accountRowFor, isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { resolveTargets } from '../workspace/targets.mjs';
import { currentSessionWorkspace } from '../workspace/session-routes.mjs';

// The references in one argument: comma-separated, trimmed, empty ones dropped. Quotes around a reference are stripped,
// because cmd.exe hands a single-quoted '<id>,<id>' to node with its quotes.
export function refParts(value) {
  const parts = [];
  for (const part of String(value).split(',')) {
    const ref = part.trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (ref !== '') parts.push(ref);
  }
  return parts;
}

// An id, a case-insensitive name, or a 1-based position in row.tenants; throws when none match.
export function resolveTenantRef(row, ref) {
  const value = ref == null ? '' : String(ref).trim();
  if (!value) throw new UserError('No workspace given.');
  const tenants = tenantsOf(row);
  if (tenants == null) {
    throw new UserError('This account\'s workspaces are not known yet. Start a new Copilot session, then try again.');
  }
  const byId = tenants.find((t) => t.id === value);
  if (byId) return byId.id;
  const byName = tenants.find((t) => typeof t.name === 'string' && t.name.toLowerCase() === value.toLowerCase());
  if (byName) return byName.id;
  if (/^\d+$/.test(value)) {
    const byPosition = tenants[Number(value) - 1];
    if (byPosition) return byPosition.id;
  }
  throw new UserError(`No workspace of this account matches "${value}". Use a workspace name or id shown in /beezi-staging-settings.`);
}

// Splits argv into the --tenant values and the rest; a --tenant with no value throws.
function splitTenantFlags(argv) {
  const rest = [];
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--tenant') { rest.push(argv[i]); continue; }
    const value = argv[++i];
    if (value == null) throw new UserError('--tenant needs a value: a workspace name or id shown in /beezi-staging-settings.');
    values.push(value);
  }
  return { rest, values };
}

// Strips every --tenant <ref[,ref…]> out of argv; tenantIds is [] when the flag is absent.
export function parseTenantFlags(argv, row) {
  const { rest, values } = splitTenantFlags(argv);
  const tenantIds = [];
  for (const value of values) {
    for (const ref of refParts(value)) {
      const id = resolveTenantRef(row, ref);
      if (tenantIds.indexOf(id) === -1) tenantIds.push(id);
    }
  }
  return { argv: rest, tenantIds };
}

function workspaceRequired(message) {
  const error = new UserError(message);
  error.workspaceRequired = true;
  return error;
}

// --tenant flags when given, else this session's targets ([null] = headerless); none left throws workspaceRequired.
export function parseCommandTargets(argv, row) {
  const account = accountRowFor(row);
  // A missing or logged-out account has no targets and one or unknown workspaces go headerless: flags are stripped, never resolved.
  if (account.unlinked === true) return { argv: splitTenantFlags(argv).rest, tenantIds: [] };
  if (!isMultiTenant(account)) return { argv: splitTenantFlags(argv).rest, tenantIds: [null] };
  const parsed = parseTenantFlags(argv, account);
  if (parsed.tenantIds.length > 0) return parsed;
  const resolved = resolveTargets(account, currentSessionWorkspace());
  if (resolved.targets.length > 0) return { argv: parsed.argv, tenantIds: resolved.targets };
  if (resolved.pendingAsk) {
    throw workspaceRequired('Beezi has not been told where analytics from this folder go yet, so this session sends nowhere. Choose with /beezi-staging-settings rules, or pass --tenant <workspace>.');
  }
  if (resolved.rule != null) {
    throw workspaceRequired(`The rule for ${resolved.rule.label} is "Don't track", so this session sends nowhere. Change it with /beezi-staging-settings rules, or pass --tenant <workspace>.`);
  }
  throw workspaceRequired('New folders are set to Don\'t send, so this session sends nowhere. Change it with /beezi-staging-settings new-folders, or pass --tenant <workspace>.');
}
