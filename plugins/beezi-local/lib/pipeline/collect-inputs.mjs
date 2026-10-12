// CLI checkpoint step 9: collector inputs built once per run, each segment's collector outputs, and the payload emit loop.
import { claimIntervals, mergeIntervals, subtractIntervals, totalMs } from '../core/intervals.mjs';
import { collectOperations, completionsById, emptyOperations } from '../capture/collectors/operations.mjs';
import { buildToolIndex, collectToolFailures } from '../capture/collectors/tool-failures.mjs';
import { countCompactions } from '../capture/collectors/compactions.mjs';
import { collectCodeChanges, emptyCodeChanges } from '../capture/collectors/code-changes.mjs';
import { collectSubagents, subagentStateMap } from '../capture/collectors/subagents.mjs';
import { readSubagentMarkers } from '../state/subagent-markers.mjs';
import { resolveSessionName } from '../sources/cli/session-name.mjs';
import { projectInstructions } from '../repo/project-instructions.mjs';
import { localRemote, UNKNOWN_REMOTE } from '../repo/repo-context.mjs';
import { segmentStats } from '../capture/segment-stats.mjs';
import { buildSegmentPayload, detectTimezone } from '../capture/payload-header.mjs';
import { mcpPluginByServer } from './plugin-servers.mjs';
import { CONTINUE, stopRun } from './run-skeleton.mjs';
import { isPlain } from '../core/guards.mjs';

// True when any number inside is above zero: a subagent that did no counted work.
function anyPositive(v) {
  if (typeof v === 'number') return v > 0;
  if (v != null && typeof v === 'object') return Object.keys(v).some((k) => anyPositive(v[k]));
  return false;
}

// → { base (the collectors' shared ctx), toolIndex, subagentInfo, infoFor(agentId), sessionName, instructionsFor(root),
// timezone }. run: { sessionId, cwd, state, events, windowEvents, hookErrors, transcript, forkLine, appFacts }.
function collectRunInputs(run, errors) {
  const { sessionId, cwd, state, events, windowEvents, hookErrors, transcript, forkLine, appFacts } = run;
  // Whole-file indexes and the installed plugins' MCP servers are read once per run and shared by every segment's collectors.
  const completeById = completionsById(events);
  let toolIndex = null;
  try { toolIndex = buildToolIndex(events); } catch { errors.push('collector:tool-failures'); }
  const base = {
    sessionId, cwd, state, allEvents: events, hookErrors, completeById, toolIndex, forkLine, mcpPluginByServer: mcpPluginByServer(),
  };
  // Identity comes from the whole file on every trigger: the window that named a subagent (its subagent.started)
  // is consumed by whichever checkpoint reaches it first, and a later one would never see it again.
  let subagentInfo = {};
  try {
    const subagentList = collectSubagents(events, { state, subagentMarkers: readSubagentMarkers(sessionId) });
    subagentInfo = subagentStateMap(subagentList);
  } catch { errors.push('collector:subagents'); }
  const infoFor = (agentId) => (isPlain(subagentInfo[agentId]) ? subagentInfo[agentId] : (isPlain(state.subagents[agentId]) ? state.subagents[agentId] : {}));
  // The stored name is kept when nothing new resolves; a null never overwrites it.
  let resolved = null;
  try { resolved = resolveSessionName(sessionId, windowEvents, transcript, appFacts); } catch { errors.push('collector:session-name'); }
  const sessionName = resolved != null ? resolved : state.sessionName;
  const instructionsCache = new Map();
  const instructionsFor = (root) => {
    if (instructionsCache.has(root)) return instructionsCache.get(root);
    let found;
    try { found = projectInstructions(root); } catch { found = { project_instructions_status: 'unknown' }; }
    instructionsCache.set(root, found);
    return found;
  };
  return { base, toolIndex, subagentInfo, infoFor, sessionName, instructionsFor, timezone: detectTimezone() };
}

// One segment's collector outputs → { operations, code_changes, compactions }; a failed whole-file tool index is not rebuilt.
function collectSegment(windowEvents, seg, inputs, errors) {
  const isSub = seg.agentId != null;
  const ctx = { ...inputs.base, isSubagent: isSub };
  let operations;
  try { operations = collectOperations(windowEvents, seg, ctx).operations; } catch {
    operations = emptyOperations();
    errors.push('collector:operations');
  }
  if (inputs.toolIndex != null) {
    try {
      const found = collectToolFailures(windowEvents, seg, ctx);
      operations.failures = found.failures;
    } catch { errors.push('collector:tool-failures'); }
  }
  let code_changes;
  try { code_changes = collectCodeChanges(windowEvents, seg, ctx).code_changes; } catch {
    code_changes = emptyCodeChanges();
    errors.push('collector:code-changes');
  }
  let compactions = 0;
  try { compactions = isSub ? 0 : countCompactions(windowEvents, seg); } catch { errors.push('collector:compactions'); }
  return { operations, code_changes, compactions };
}

// Collectors and payloads, each queued before the next; any write failure keeps the cursor put. Sets sessionName,
// subagentInfo, covered and lastPayload on ctx; stops failed/emit-failed (tail runs) when a queue write fails.
export function emitSegments(ctx) {
  const { sessionId, cwd, errors, windowEvents, out, origin } = ctx;
  const inputs = collectRunInputs({
    sessionId, cwd, state: ctx.state, events: ctx.events, windowEvents, hookErrors: ctx.hookErrors, transcript: ctx.transcript,
    forkLine: ctx.forkLine, appFacts: origin.appFacts,
  }, errors);
  ctx.sessionName = inputs.sessionName;
  ctx.subagentInfo = inputs.subagentInfo;
  // Wall clock already billed for this session, as merged [startMs, endMs) intervals. The main stream and
  // every subagent cover the SAME stretch of clock, so a segment bills only the part no earlier one claimed.
  ctx.covered = mergeIntervals(ctx.state.coveredIntervals);
  let touched = false;
  for (const work of ctx.works) {
    const seg = work.segment;
    const isSub = seg.agentId != null;
    const resolvedRemote = ctx.repo.resolveRemote(seg.repoRoot);
    // A main work is never skipped, or the prefix would have a hole: the terminal fallback always names it.
    const remote = resolvedRemote == null ? (localRemote(seg.repoRoot == null ? cwd : seg.repoRoot) || UNKNOWN_REMOTE) : resolvedRemote;
    seg.remote = remote;
    const collected = collectSegment(windowEvents, seg, inputs, errors);
    // A subagent's context window is not the session's: its context fields never ship.
    const { stats, activeIntervals } = segmentStats(work, { includeContext: !isSub });
    // Main works run first and keep their full span; subagents bill only the residual.
    const durationSec = Math.round(totalMs(subtractIntervals(activeIntervals, ctx.covered)) / 1000);
    // Every main work is emitted, even with zero usage and zero duration; a subagent that did nothing is covered by the parent report.
    // A subagent's shutdown share is always emitted: it only exists because that agent billed something.
    if (isSub && work.shutdownShare !== true && stats.token_total === 0 && durationSec === 0 && stats.ai_credits_nano == null && !anyPositive(collected.operations)) continue;
    const payload = buildSegmentPayload(seg, {
      sessionId, parentSessionId: origin.parentSessionId, remote, billingFields: ctx.billing.fields, identity: ctx.billing.identity, sessionName: ctx.sessionName,
      timezone: inputs.timezone, instructions: inputs.instructionsFor(seg.repoRoot), compactions: collected.compactions,
      surface: origin.surface, info: isSub ? inputs.infoFor(seg.agentId) : {}, stats, code_changes: collected.code_changes,
      operations: collected.operations, mode: ctx.usage.mode, durationSec,
    });
    if (!touched) {
      ctx.lock.current().touch();
      touched = true;
    }
    try {
      ctx.delivery.emit(payload);
      if (activeIntervals.length) ctx.covered = claimIntervals(ctx.covered, activeIntervals);
      ctx.lastPayload = payload;
      out.segmentsQueued += 1;
    } catch {
      if (isSub) out.skipped.emitFailed += 1;
      return stopRun('failed', 'emit-failed', true);
    }
  }
  return CONTINUE;
}
