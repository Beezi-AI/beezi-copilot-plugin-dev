import { readBillingConfig, configForAccount } from './billing-config.mjs';
import { IdentityStatus } from './copilot-account.mjs';

// WHICH GitHub account this machine's Copilot is signed in as, in the one shape every ingest path sends.
//
// The session report (checkpoint), the usage rows (/me/copilot/usage) and the account check-in all
// stamp through this one function. Two builders reading the same sources in a different order would
// land one machine's sessions and its quota on two different accounts, and neither would look wrong
// on its own.
//
// The identity comes only from the snapshot's live `identity` (see readBillingConfig), so callers that
// pass one snapshot to several builders get one identity across all of them. billing.json's stored
// lastIdentity is never read here: it exists for change detection only.
//
// account_uuid is the GitHub identity key '<host>/<login>'. Keys are omitted, never nulled: absence is
// how the stamp says "not stated", and there is no account_email because no verified email exists locally.
const KEY_MAX = 64;

// `sessionId` is accepted for the seam: V-38(c) is open and defaults to "Agent Host bills the same user".
// `account` is the session's bound identity key (lib/session-account-copilot.mjs); it replaces the current identity.
export function accountStamp({ sessionId = null, config = null, account = null } = {}) {
  try {
    const snapshot = configForAccount(config == null ? readBillingConfig() : config, account);
    const identity = snapshot.identity;
    if (identity == null || identity.status !== IdentityStatus.OK) return {};
    if (typeof identity.key !== 'string' || identity.key === '' || identity.key.length > KEY_MAX) return {};
    return { account_uuid: identity.key };
  } catch {
    return {};
  }
}
