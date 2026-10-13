// Packs history session groups into request-sized backfill chunks.

// The backfill route caps chunks at 100 array items and mounts a 5mb body limit; 50 items with
// 1MB of headroom keeps every chunk comfortably inside both.
export const MAX_CHUNK_ITEMS = 50;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const wireBytes = (reports, timelines = []) =>
  Buffer.byteLength(JSON.stringify({ sessions: reports, timelines }), 'utf-8');

// Pack whole sessions into request-sized chunks of at most `maxItems` payloads / `maxBytes`.
//
// A session stays an indivisible packing unit so the ledger can attribute a whole chunk's
// verdict to whole sessions — the server dedupes via its upsert keys and needs no such
// grouping itself. Only a session too large for one request splits; its continuations carry
// `partialOf` so the caller accepts the session only when every part was accepted.
//
// A group's optional `timeline` rides in the chunk that carries its reports (the FIRST part of
// a split session — the server applies it once the session has stored anything). Timelines are
// small next to the 1MB headroom over the route's 5mb limit, so the split path does not re-run
// its byte math over them; the normal path counts them.
export function planChunks(sessionGroups, { maxItems = MAX_CHUNK_ITEMS, maxBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let current = null;

  const flushCurrent = () => {
    if (current && current.reports.length > 0) chunks.push(current);
    current = null;
  };

  for (const group of sessionGroups) {
    const reports = group.reports == null ? [] : group.reports;
    if (reports.length === 0) continue;

    if (reports.length > maxItems || wireBytes(reports) > maxBytes) {
      // Over-budget session: emit it alone, split by whichever cap binds first.
      flushCurrent();
      chunks.push(...splitSession(group, reports, maxItems, maxBytes));
      continue;
    }

    if (
      current &&
      (current.reports.length + reports.length > maxItems ||
        wireBytes(
          [...current.reports, ...reports],
          group.timeline ? [...current.timelines, group.timeline] : current.timelines,
        ) > maxBytes)
    ) {
      flushCurrent();
    }
    if (!current) current = { reports: [], sessionIds: [], timelines: [] };
    current.reports.push(...reports);
    current.sessionIds.push(group.sessionId);
    if (group.timeline) current.timelines.push(group.timeline);
  }
  flushCurrent();
  return chunks;
}

// One over-budget session's parts, each marked `partialOf`; the timeline rides with the first.
function splitSession(group, reports, maxItems, maxBytes) {
  const parts = [];
  let part = [];
  const emitPart = (partReports) => {
    parts.push({
      reports: partReports,
      sessionIds: [group.sessionId],
      partialOf: group.sessionId,
      timelines: parts.length === 0 && group.timeline ? [group.timeline] : [],
    });
  };
  for (const report of reports) {
    // A single report over the byte budget is still sent alone — it will be refused with a
    // definite status rather than looping forever trying to make it fit.
    if (part.length > 0 && (part.length >= maxItems || wireBytes([...part, report]) > maxBytes)) {
      emitPart(part);
      part = [];
    }
    part.push(report);
  }
  if (part.length > 0) emitPart(part);
  return parts;
}

// sessionId → how many parts a split session was cut into.
export function countSplitParts(chunks) {
  const parts = new Map();
  for (const chunk of chunks) {
    if (chunk.partialOf != null) parts.set(chunk.partialOf, (parts.has(chunk.partialOf) ? parts.get(chunk.partialOf) : 0) + 1);
  }
  return parts;
}
