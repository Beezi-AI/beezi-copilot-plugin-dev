// workspace.mjs read <ref>: the workspace this Copilot session's analytics tools read from.
import { parseAccountFlag } from '../../accounts/index-store.mjs';
import { currentSessionId } from '../../host/current-session.mjs';
import { recordReadTenant } from '../../workspace/session-routes.mjs';
import { resolveTenantRef } from '../tenant-flags.mjs';
import { UserError } from '../../core/errors.mjs';
import { tenantName } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { USAGE, parseSessionFlag, resolveAccount } from './args.mjs';

// Never selects a session by guess: without --session it needs the session Copilot runs this command in.
export async function read(argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const tenantId = resolveTenantRef(row, rest[0]);
  const sessionId = session != null ? session : currentSessionId(process.cwd());
  if (sessionId == null || recordReadTenant(sessionId, row.key, tenantId) == null) {
    throw new UserError('No single Copilot session could be identified here. Run this inside a Copilot session or pass --session <id>.');
  }
  console.log(`✓ Reading from ${tenantName(row, tenantId)} in this session.`);
  console.log(machineLine([['read', tenantId]]));
}
