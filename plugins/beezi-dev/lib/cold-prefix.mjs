// A call is cold when it re-wrote a large prefix: prompt over 5k tokens, cache read under 20% of it, cache write over 50% of it.
const COLD_MIN_PROMPT_TOKENS = 5000;
const COLD_MAX_READ_SHARE = 0.2;
const COLD_MIN_WRITE_SHARE = 0.5;
// A cold call after a longer pause than this (5 minutes) counts as idle-cold.
const COLD_IDLE_GAP_MS = 5 * 60 * 1000;

function isColdPrefixCall(prompt, cacheRead, cacheWrite) {
  return prompt > COLD_MIN_PROMPT_TOKENS && cacheRead < prompt * COLD_MAX_READ_SHARE && cacheWrite > prompt * COLD_MIN_WRITE_SHARE;
}

// Prefixed so no agent id can collide with the main stream or an inherited property name.
export const MAIN_CALL_KEY = 'm';
function callKeyOf(agentId) {
  return agentId == null || agentId === '' ? MAIN_CALL_KEY : `a:${agentId}`;
}

// A call's start: its end time minus its reported duration (the end time itself when the duration is absent).
export function callStartMs(atMs, durationMs) {
  const own = typeof durationMs === 'number' && isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return atMs - own;
}

// Judges a call against the same agent's previous one and records it; `usage` is { prompt, cacheRead, cacheWrite }, and an agent's first call is never cold or a switch.
export function observeCall(lastCalls, agentId, atMs, model, usage, durationMs) {
  const key = callKeyOf(agentId);
  const previous = Object.prototype.hasOwnProperty.call(lastCalls, key) ? lastCalls[key] : null;
  const result = { switched: false, cold: false, idleCold: false };
  if (previous != null) {
    result.switched = previous.model !== model;
    result.cold = isColdPrefixCall(usage.prompt, usage.cacheRead, usage.cacheWrite);
    const gap = Number.isFinite(atMs) && previous.at != null ? callStartMs(atMs, durationMs) - previous.at : 0;
    result.idleCold = result.cold && gap > COLD_IDLE_GAP_MS;
  }
  lastCalls[key] = { at: Number.isFinite(atMs) ? atMs : (previous == null ? null : previous.at), model };
  return result;
}

export function emptyCold() {
  return { calls: 0, nano: null, switches: 0, idleCalls: 0 };
}

// `nano` is the call's reported credits or null; cold.nano stays null until a cold call reports some.
export function addCold(cold, call, nano) {
  if (call.switched) cold.switches += 1;
  if (!call.cold) return;
  cold.calls += 1;
  if (nano != null) cold.nano = (cold.nano == null ? 0 : cold.nano) + nano;
  if (call.idleCold) cold.idleCalls += 1;
}
