// workspace.mjs places: the folder picker, recent repos and folders with no rule of their own other than this directory's.
import { parseAccountFlag } from '../../accounts/index-store.mjs';
import { tenantsOf } from '../../workspace/tenants.mjs';
import { createRouteContext, routeKeyForDir } from '../../workspace/route-key.mjs';
import { routeForDir } from '../../workspace/routing.mjs';
import { isLineSafePlace, rulesOf } from '../../workspace/rule-model.mjs';
import { samePlace } from '../../workspace/route-describe.mjs';
import { planReviewPlaces } from '../../history/history-routing.mjs';
import { listSessionFiles } from '../../sources/cli/session-files.mjs';
import { UserError } from '../../core/errors.mjs';
import { pickerHeaderLine, pickerLine, ruleAddCommandLine } from '../../ux/workspace-lines.mjs';
import { machineLine } from '../../ux/machine-lines.mjs';
import { choiceDir, resolveSession } from '../../workspace/session-routes.mjs';
import { USAGE, pastSessionOptions, parseSessionFlag, resolveAccount } from './args.mjs';

// The folder picker offers at most this many places.
const PICKER_PLACES = 3;

// The picker's places, most sessions first; `options` are planReviewPlaces' (liveSessionId, now, readState, readCwd).
export function pickerPlaces(row, entries, dir, ctx, options = {}) {
  const here = dir == null ? null : routeForDir(row, dir, ctx) || routeKeyForDir(dir, ctx);
  const stored = rulesOf(row);
  return planReviewPlaces(row, entries, ctx, options)
    .filter(isLineSafePlace)
    .filter((place) => !samePlace(place, here) && !stored.some((r) => samePlace(r, place)))
    .slice(0, PICKER_PLACES);
}

// A header, then per place its F line and the rule-add command to finish with <tenants>; nothing when there is no place.
export function pickerLines(row, places) {
  if (places.length === 0) return [];
  const lines = [pickerHeaderLine(row, places.length)];
  places.forEach((place, i) => {
    lines.push(pickerLine(i + 1, row, place));
    lines.push(ruleAddCommandLine(`F${i + 1}-command`, place, row));
  });
  return lines;
}

export async function places(argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const tenants = tenantsOf(row);
  const current = resolveSession(session);
  const found = tenants == null || tenants.length === 0
    ? []
    : pickerPlaces(row, await listSessionFiles(), choiceDir(current.state), createRouteContext(), pastSessionOptions(current.sessionId));
  for (const line of pickerLines(row, found)) console.log(line);
  console.log(machineLine([['places', found.length]]));
}
