// Where an events.jsonl session comes from, read once per run by the live checkpoint and history alike: the Copilot app's
// facts, the lines a fork copied, a detached run's parent, the creating client, the start and the BYOK verdict.
import { appSessionFacts } from '../sources/app/app-db.mjs';
import { sessionSurface } from '../sources/cli/client-surface.mjs';
import { sessionStartOf } from '../sources/cli/event-types.mjs';
import { detachedParentOf, forkBoundary, ownEvents } from '../capture/session-lineage.mjs';
import { sessionByok } from '../billing/session-byok.mjs';

// The first session.start's stamp in ms, null when it has none: the instant the session's plan is resolved at.
export function sessionStartMs(events) {
  const start = sessionStartOf(events);
  const ms = start == null || typeof start.timestamp !== 'string' ? NaN : Date.parse(start.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

// → { appFacts, forkLine, parentSessionId, surface ({ source, originator, cliVersion }), startedAtMs, byok }. Never throws.
// BYOK reads the lines past the fork with history's rule; `ownProcess` is true only on the session's own hook, the one
// process whose env describes it.
export async function readSessionOrigin(sessionId, events, transcriptPath, { ownProcess = false, env = process.env } = {}) {
  const appFacts = await appSessionFacts(sessionId);
  const forkLine = forkBoundary(events, sessionId, appFacts);
  return {
    appFacts,
    forkLine,
    parentSessionId: detachedParentOf(events, sessionId),
    surface: sessionSurface(sessionId, transcriptPath, events, appFacts != null),
    startedAtMs: sessionStartMs(events),
    byok: sessionByok({ appFacts, events: ownEvents(events, forkLine), ownProcess, env }),
  };
}
