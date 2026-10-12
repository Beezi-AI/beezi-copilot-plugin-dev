// The /sessions/report payload of one Copilot CLI segment: its id, the common header fields and every clamp.
import crypto from 'crypto';
import { clamp, BRANCH_MAX, AGENT_NAME_MAX, AGENT_TYPE_MAX, SEGMENT_ID_MAX } from '../contract/report-limits.mjs';
import { redactText } from '../core/redact.mjs';

// The portal DTO caps of the session title and the client dimensions.
export const SESSION_NAME_MAX = 500;
export const SOURCE_MAX = 50;
export const ORIGINATOR_MAX = 100;
export const CLI_VERSION_MAX = 50;

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
export function detectTimezone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone == null ? null : timeZone;
  } catch {
    return null;
  }
}

// The one rule for a session title on the wire, CLI and VS Code alike: redacted, then cut to the cap.
export function sessionNameField(name) {
  return typeof name === 'string' ? clamp(redactText(name), SESSION_NAME_MAX) : null;
}

// The server caps segmentId; an over-long subagent id is swapped for its hash, which is the same on every re-emit. A
// detached run folded into its parent keeps its own id in the scope, so its segments never overwrite the parent's.
function segmentScope(f, seg) {
  const base = f.parentSessionId == null ? f.sessionId : `${f.parentSessionId}:${f.sessionId}`;
  if (seg.agentId == null) return base;
  const agentKey = `${base}:${seg.agentId}:${seg.fromLine}-${seg.toLine}`.length > SEGMENT_ID_MAX
    ? crypto.createHash('sha1').update(seg.agentId).digest('hex')
    : seg.agentId;
  return `${base}:${agentKey}`;
}

// The creating client's dimensions ({ source, originator, cliVersion } from creatingSurface), each sent only when known.
function surfaceFields(surface) {
  if (surface == null) return {};
  return {
    ...(surface.source != null ? { source: clamp(surface.source, SOURCE_MAX) } : {}),
    ...(surface.originator != null ? { originator: clamp(surface.originator, ORIGINATOR_MAX) } : {}),
    ...(surface.cliVersion != null ? { cli_version: clamp(surface.cliVersion, CLI_VERSION_MAX) } : {}),
  };
}

// f: { sessionId, parentSessionId (a detached run's parent, else null), remote, billingFields, identity, sessionName,
// timezone, instructions, compactions, surface, info (subagent identity), stats, code_changes, operations, mode,
// durationSec }. Key order is the wire order the replay pins.
export function buildSegmentPayload(seg, f) {
  const isSub = seg.agentId != null;
  const info = isSub ? f.info : {};
  const folded = f.parentSessionId != null;
  return {
    segmentId: `${segmentScope(f, seg)}:${seg.fromLine}-${seg.toLine}`,
    sessionId: folded ? f.parentSessionId : f.sessionId,
    remote: f.remote,
    branch: clamp(seg.branch, BRANCH_MAX),
    from_line: seg.fromLine,
    to_line: seg.toLine,
    ...f.billingFields,
    ...f.identity,
    // A folded run never renames its parent.
    session_name: folded ? null : sessionNameField(f.sessionName),
    ...(f.timezone ? { timezone: f.timezone } : {}),
    ...f.instructions,
    ...(f.compactions > 0 ? { compactions: f.compactions } : {}),
    ...(isSub ? {} : surfaceFields(f.surface)),
    ...(isSub ? {
      is_subagent: true,
      agent_id: clamp(seg.agentId, AGENT_NAME_MAX),
      agent_type: clamp(info.agentType == null ? null : info.agentType, AGENT_TYPE_MAX),
      agent_name: clamp(info.agentName == null ? null : info.agentName, AGENT_NAME_MAX),
      spawn_depth: info.spawnDepth == null ? null : info.spawnDepth,
    } : {}),
    ...f.stats,
    code_changes: f.code_changes,
    operations: f.operations,
    // A window billed in neither mode carries no usage label.
    ...(f.mode == null ? {} : { usage_source: f.mode }),
    duration_sec: f.durationSec,
  };
}
