// The user-facing markdown table of an account's workspace rules, plus the rule this folder follows.
import { isMultiTenant, isSingleTenant, tenantById } from '../workspace/tenants.mjs';
import { rulesOf, shortLabel } from '../workspace/rule-model.mjs';
import { routeKeyForDir } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { AccountStatus } from '../accounts/index-store.mjs';

const OUTSIDE_WHERE = 'home, /, temp or Copilot app chat folders';

const cell = (text) => String(text).replace(/\|/g, '\\|');
// A revoked account's analytics still queue on disk and upload once it signs in again.
const HELD = 'held until you sign in again';

function workspaceNames(row, ids) {
  if (ids.length === 0) return 'not tracked';
  return ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  }).join(', ');
}

// The user-facing rules table, as lines: accounts with known workspaces, no machine fields.
export function rulesTableLines(rows, dir, ctx) {
  const known = rows.filter((row) => isMultiTenant(row) || isSingleTenant(row));
  if (known.length === 0) return ['Rules need the account\'s workspaces, which are not known yet. Start a new Copilot session and try again.'];
  const out = [];
  known.forEach((row, i) => {
    if (known.length > 1) {
      if (i > 0) out.push('');
      out.push(`**${row.email || row.name || row.key}**`, '');
    }
    const stored = rulesOf(row);
    const single = isSingleTenant(row);
    const held = row.status === AccountStatus.REVOKED;
    if (stored.length === 0) {
      out.push('No rules yet.');
    } else if (single) {
      out.push('| Rule | Repo or folder | Where | Tracked |', '|---|---|---|---|');
      for (const r of stored) {
        const where = r.kind === 'outside' ? OUTSIDE_WHERE : r.label;
        out.push(`| R${r.index} | ${cell(shortLabel(r))} | ${cell(where)} | ${r.tenantIds.length === 0 ? 'No' : (held ? `Yes, ${HELD}` : 'Yes')} |`);
      }
    } else {
      out.push('| Rule | Repo or folder | Where | Sends to |', '|---|---|---|---|');
      for (const r of stored) {
        const where = r.kind === 'outside' ? OUTSIDE_WHERE : r.label;
        out.push(`| R${r.index} | ${cell(shortLabel(r))} | ${cell(where)} | ${cell(workspaceNames(row, r.tenantIds))}${held && r.tenantIds.length > 0 ? ` (${HELD})` : ''} |`);
      }
    }
    const key = routeKeyForDir(dir, ctx);
    if (key == null) return;
    const route = routeForDir(row, dir, ctx);
    out.push('', `This folder: ${shortLabel(key)} — ${route == null ? 'no rule yet' : `R${route.index}`}`);
  });
  return out;
}
