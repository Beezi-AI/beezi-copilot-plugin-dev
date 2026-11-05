// Owns the wire bodies an anonymized workspace receives: each scrubber returns a copy and leaves its input untouched.
import { anonAccount, anonSession, isAnonValue } from './anon-value.mjs';
import { anonBranch, anonRemote } from './anon-repo-address.mjs';

export const PRIVATE_MARK = 'beeziPrivate';

const ACCOUNT_FIELDS = ['account_uuid', 'account_email'];
const GITHUB_HOST = 'github.com';

function isRawAccount(value) {
  return typeof value === 'string' && !isAnonValue(value);
}

// The host is the part of '<host>/<login>' before the first slash.
function isGithubCom(account) {
  return account.split('/')[0].toLowerCase() === GITHUB_HOST;
}

// Drops the marker always; each field changes only when its kind is in `kinds`.
export function anonymizeReport(payload, keyHex, kinds) {
  const out = { ...payload };
  delete out[PRIVATE_MARK];
  if (kinds.includes('repos') && out.remote != null) out.remote = anonRemote(keyHex, out.remote);
  if (kinds.includes('branches') && out.branch != null) out.branch = anonBranch(keyHex, payload.remote, out.branch);
  if (kinds.includes('sessions')) {
    delete out.agent_name;
    if (out.session_name != null) out.session_name = anonSession(keyHex, out.sessionId);
  }
  if (kinds.includes('accounts')) {
    if (isRawAccount(payload.account_uuid)) out.account_is_github_com = isGithubCom(payload.account_uuid);
    for (const field of ACCOUNT_FIELDS) if (out[field] != null) out[field] = anonAccount(keyHex, out[field]);
  }
  return out;
}

export function anonymizeUsageRow(row, keyHex) {
  const out = { ...row };
  if (out.account_uuid != null) out.account_uuid = anonAccount(keyHex, out.account_uuid);
  return out;
}

export function anonymizeAccountSync(body, keyHex) {
  const out = { ...body };
  if (isRawAccount(body.accountUuid)) out.accountIsGithubCom = isGithubCom(body.accountUuid);
  if (out.accountUuid != null) out.accountUuid = anonAccount(keyHex, out.accountUuid);
  return out;
}

export function scrubSessionError(body) {
  const out = { ...body };
  delete out.errorDetails;
  delete out.lastAssistantMessage;
  return out;
}
