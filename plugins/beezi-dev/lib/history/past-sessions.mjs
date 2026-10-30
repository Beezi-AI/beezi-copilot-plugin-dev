// Past sessions the history upload would send and the distinct places they ran in: the counts behind the setup question.
import { createRouteContext, routeKeyForDir } from '../workspace/route-key.mjs';
import { readSessionWorkspace } from '../workspace/session-routes.mjs';
import { isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { listSessionFiles } from '../sources/cli/session-files.mjs';
import { currentSessionId } from '../host/current-session.mjs';
import { isImported, loadLedger } from '../state/ledger.mjs';
import { cwdReader, withVscodeEntries } from './candidates.mjs';
import { ACTIVE_SESSION_WINDOW_MS } from './scan-limits.mjs';

const placeId = (key) => `${key.kind}\n${key.match}`;

// Sessions the upload would send (not live, active or imported) and their places deduped by kind+match, less
// `hereKey`'s place; one with no directory counts in sessions only.
export function countPastSessions(entries, { liveSessionId = null, now = Date.now(), imported, readState, readCwd, keyOf, hereKey = null }) {
  const places = new Set();
  let sessions = 0;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null || (liveSessionId != null && entry.sessionId === liveSessionId)) continue;
    if (now - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS || imported(entry.sessionId)) continue;
    sessions += 1;
    const state = readState(entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry.transcriptPath);
    const key = dir == null ? null : keyOf(dir);
    if (key != null) places.add(placeId(key));
  }
  if (hereKey != null) places.delete(placeId(hereKey));
  return { sessions, places: places.size };
}

// countPastSessions over this machine's CLI and VS Code sessions; a session in any of the account's ledgers (one per
// workspace, or the account's own for one workspace, as the history run keys them) is not uploaded again.
export function pastSessions(row, hereKey = null) {
  const ctx = createRouteContext();
  const identity = row.clientId == null ? null : row.clientId;
  const tenants = tenantsOf(row);
  const ledgerTenants = isMultiTenant(row) ? tenants.map((t) => t.id) : [null];
  const ledgers = ledgerTenants.map((tenantId) => loadLedger(row.key, identity, tenantId));
  const entries = withVscodeEntries(listSessionFiles());
  return countPastSessions(entries, {
    liveSessionId: currentSessionId(process.cwd()),
    imported: (sessionId) => ledgers.some((ledger) => isImported(ledger, sessionId)),
    readState: readSessionWorkspace,
    readCwd: cwdReader(entries),
    keyOf: (dir) => routeKeyForDir(dir, ctx),
    hereKey,
  });
}
