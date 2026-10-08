import { EVENT_TYPES } from './copilot-events.mjs';
import { inSegment } from './operations.mjs';

// Completed compactions of the segment's own stream; a failed compaction (success false) is not one.
export function countCompactions(events, segment) {
  let count = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (e.type !== EVENT_TYPES.COMPACTION_COMPLETE || !inSegment(e, segment)) continue;
    if (e.data != null && e.data.success === false) continue;
    count += 1;
  }
  return count;
}
