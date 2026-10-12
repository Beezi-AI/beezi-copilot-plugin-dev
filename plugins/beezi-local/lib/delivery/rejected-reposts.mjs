// Which quarantined `<name>.json.rejected` reports a flush pass re-posts after a plugin update: each file is handled
// once per plugin version, recorded per file so a pass cut short never re-posts what it already settled, and a
// window whose lines the account's coverage record already holds is deleted instead of posted twice.
import fs from 'fs';
import { REJECTED_SUFFIX } from './queue-files.mjs';
import { checkpointLineFor, currentBinding, loadCoverageCheckpoints } from '../state/coverage-record.mjs';

const REJECTED_NAME = `.json${REJECTED_SUFFIX}`;

const isRejectedName = (name) => name.endsWith(REJECTED_NAME);

function rejectedNames(dir) {
  try { return fs.readdirSync(dir).filter(isRejectedName); } catch { return []; }
}

// health: the account's record (state/health-record.mjs); version: the running plugin's, or null (nothing is re-posted).
// → { due(name), handled(name), outcome(dir) }; outcome is the pass's { rejectedTried, rejectedDone } for the record.
export function createReposts(health, version) {
  const retry = version != null && health.rejectedRetriedFor !== version;
  const prior = retry && health.rejectedTried != null && health.rejectedTried.version === version ? health.rejectedTried.files : [];
  const tried = new Set(prior);
  return {
    due: (name) => retry && isRejectedName(name) && !tried.has(name),
    // A file refused under this version, or left alone as not plainly postable; a queued name counts as its quarantined one.
    handled: (name) => { tried.add(isRejectedName(name) ? name : `${name}${REJECTED_SUFFIX}`); },
    outcome(dir) {
      if (!retry) return {};
      const names = rejectedNames(dir);
      return { rejectedTried: names.filter((name) => tried.has(name)), rejectedDone: names.every((name) => tried.has(name)) };
    },
  };
}

// Only windows numbered in the session's own events file: its main window or one of its subagents'. A folded detached
// run posts under its parent's id with lines of another file, and a VS Code request window counts requests, not lines.
export function ownFileWindow(payload) {
  const id = payload.segmentId;
  const sessionId = payload.sessionId;
  if (typeof id !== 'string' || typeof sessionId !== 'string' || !id.startsWith(`${sessionId}:`)) return false;
  const tail = `:${payload.from_line}-${payload.to_line}`;
  if (!id.endsWith(tail)) return false;
  const middle = id.slice(sessionId.length, id.length - tail.length);
  return middle === '' || (payload.is_subagent === true && /^:[^:]+$/.test(middle));
}

// True when a coverage line (the highest parent line a sync delivered, or null) already holds every line of the window.
export function coveredWindow(payload, coverageLine) {
  return Number.isInteger(coverageLine) && Number.isInteger(payload.to_line) && payload.to_line <= coverageLine && ownFileWindow(payload);
}

// → (tenantId, sessionId) → the coverage line, reading each workspace's record once per pass, bound as history writes it.
export function coverageLookup(session) {
  const records = new Map();
  const identity = session.clientId == null ? null : session.clientId;
  return (tenantId, sessionId) => {
    const tag = tenantId == null ? '' : tenantId;
    if (!records.has(tag)) records.set(tag, loadCoverageCheckpoints(session.key, currentBinding(identity, tenantId)));
    return checkpointLineFor(records.get(tag), sessionId);
  };
}
