// What history needs about one CLI session beyond its reports, read once: its own events, creating surface, start and BYOK.
import { readEvents } from '../sources/cli/events.mjs';
import { sessionSurface } from '../sources/cli/client-surface.mjs';
import { sessionSpan } from '../sources/cli/session-account.mjs';
import { appSessionFacts } from '../sources/app/app-db.mjs';
import { forkBoundary, ownEvents } from '../capture/session-lineage.mjs';
import { sessionByok } from '../billing/session-byok.mjs';

// The lines past a fork's copied history, their first timestamp as the session's start and the session's
// BYOK verdict from the live path's own predicate, never this sync process's env.
export function ownSessionFacts(sessionId, events, appFacts) {
  const forkLine = forkBoundary(events, sessionId, appFacts);
  const own = ownEvents(events, forkLine);
  const startMs = sessionSpan(sessionId, { events: own }).firstMs;
  return {
    events: own,
    at: Number.isFinite(startMs) ? startMs : null,
    byok: sessionByok({ appFacts, events: own, ownProcess: false }),
  };
}

// → { events, at, byok, surface } where surface is the creating client's `source` (sessionSurface over every line, as live).
export async function readSessionFacts(entry) {
  const read = readEvents(entry.transcriptPath);
  const events = read.unreadable ? [] : read.events;
  const appFacts = await appSessionFacts(entry.sessionId);
  const surface = sessionSurface(entry.sessionId, entry.transcriptPath, events, appFacts != null).source;
  return { ...ownSessionFacts(entry.sessionId, events, appFacts), surface };
}
