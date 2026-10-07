import path from 'path';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { accountDir, tenantTag, BEEZI_ENV } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { loadLedger, ledgerDelivered } from './audit-ledger.mjs';
import { isUsableSessionId } from './session-state.mjs';

// A replay is append-only: it starts at the server's contiguous parent-line prefix or the session is deferred, and "could not ask" (null) is never read as "nothing stored".

// One request answers at most this many session ids.
export const MAX_COVERAGE_IDS = 200;

// A foreground command's budget; the hook budget that shrinks postJson's default does not apply.
const COVERAGE_TIMEOUT_MS = 60000;

const COVERAGE_FILE_VERSION = 1;

// §11 R-17: Plan 04's validator is the only session-id check; this is its historical name.
export { isUsableSessionId as isSafeSessionId } from './session-state.mjs';

function chunkIds(ids, size) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// null / undefined for an asked id is the server's "nothing" and reads as 0; anything else that is not a whole non-negative number is an unknown contract.
function readLineCount(value) {
  if (value === null || value === undefined) return { ok: true, lines: 0 };
  if (typeof value !== 'number' || !isFinite(value)) return { ok: false, lines: 0 };
  if (!Number.isInteger(value) || value < 0) return { ok: false, lines: 0 };
  return { ok: true, lines: value };
}

// Map<sessionId, storedPrefixLines> (absent = a confirmed 0) when every batch answered in the documented shape, else null.
export async function fetchCoverage(sessionIds, session, deps = {}, { timeoutMs = COVERAGE_TIMEOUT_MS } = {}) {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id !== '') : [];
  const coverage = new Map();
  if (ids.length === 0) return coverage;
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const url = `${apiBase()}${ENDPOINTS.sessionsCoverage}`;

  for (const batch of chunkIds([...new Set(ids)], MAX_COVERAGE_IDS)) {
    let res;
    try {
      res = await postJsonImpl(url, session, { sessionIds: batch }, { fetchImpl, timeoutMs });
    } catch {
      return null;
    }
    if (res == null || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) return null;
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      return null;
    }
    // A 2xx that is not the documented shape is an unavailable route, not a machine with no history.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const table = parsed.coverage;
    if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
    for (const sessionId of batch) {
      const read = readLineCount(Object.prototype.hasOwnProperty.call(table, sessionId) ? table[sessionId] : null);
      if (!read.ok) return null;
      if (read.lines > 0) coverage.set(sessionId, read.lines);
    }
  }
  return coverage;
}

// ── Durable coverage checkpoints ────────────────────────────────────────────────────────────────

// Outside state/ and queue/, so pruneStale never deletes it; one file per workspace of a multi-workspace account.
function coverageFile(key, tenantId) {
  return path.join(accountDir(key), tenantId == null ? 'coverage.json' : `coverage.${tenantTag(tenantId)}.json`);
}

// Everything a stored answer is only meaningful under.
export function currentBinding(identity, tenantId = null) {
  return {
    identity: identity == null ? null : identity,
    environment: BEEZI_ENV || 'prod',
    apiBase: apiBase(),
    tenantId: tenantId == null ? null : tenantId,
  };
}

function emptyRecord(binding) {
  return {
    version: COVERAGE_FILE_VERSION,
    identity: binding.identity == null ? null : binding.identity,
    environment: binding.environment == null ? 'prod' : binding.environment,
    apiBase: binding.apiBase == null ? null : binding.apiBase,
    tenantId: binding.tenantId == null ? null : binding.tenantId,
    sessions: {},
    updatedAt: null,
  };
}

function bindingMatches(record, binding) {
  if (!record || typeof record !== 'object') return false;
  if (record.version !== COVERAGE_FILE_VERSION) return false;
  if (record.identity !== (binding.identity == null ? null : binding.identity)) return false;
  if (record.environment !== (binding.environment == null ? 'prod' : binding.environment)) return false;
  if (record.apiBase !== (binding.apiBase == null ? null : binding.apiBase)) return false;
  if (record.tenantId !== (binding.tenantId == null ? null : binding.tenantId)) return false;
  return !!record.sessions && typeof record.sessions === 'object' && !Array.isArray(record.sessions);
}

// A record written under another login, environment, API base or workspace is discarded, never merged.
export function loadCoverageCheckpoints(key, binding) {
  let stored = null;
  try {
    stored = readJson(coverageFile(key, binding.tenantId), null);
  } catch {
    stored = null;
  }
  return bindingMatches(stored, binding) ? stored : emptyRecord(binding);
}

// 0600 like the ledger; createDir is off so a save racing a logout cannot recreate the account directory.
export function saveCoverageCheckpoints(key, record) {
  try {
    return writeJsonSecure(
      coverageFile(key, record.tenantId),
      { ...record, updatedAt: new Date().toISOString() },
      { createDir: false },
    ) !== false;
  } catch {
    return false;
  }
}

// The highest parent line this machine has confirmed delivered for a session, or null; only a server-accepted upload writes one.
export function checkpointLineFor(record, sessionId) {
  if (!record || !record.sessions || !Object.prototype.hasOwnProperty.call(record.sessions, sessionId)) return null;
  const entry = record.sessions[sessionId];
  if (!entry || typeof entry !== 'object') return null;
  if (!Number.isInteger(entry.line) || entry.line < 0) return null;
  return entry.line;
}

// The usage mode of the upload that wrote the checkpoint, or null when unknown.
export function checkpointUsageSourceFor(record, sessionId) {
  if (!record || !record.sessions || !Object.prototype.hasOwnProperty.call(record.sessions, sessionId)) return null;
  const entry = record.sessions[sessionId];
  if (!entry || typeof entry !== 'object') return null;
  return entry.usageSource === 'per_call' || entry.usageSource === 'session_totals' ? entry.usageSource : null;
}

// Monotonic: a later, shorter run never walks the confirmation backwards; `at` is an ISO string or epoch ms.
export function recordCoverageCheckpoint(record, sessionId, line, at, usageSource) {
  if (!record || !record.sessions) return record;
  if (typeof sessionId !== 'string' || !sessionId) return record;
  if (!Number.isInteger(line) || line < 0) return record;
  const previous = checkpointLineFor(record, sessionId);
  if (previous !== null && previous >= line) return record;
  const when = typeof at === 'number' && isFinite(at) ? new Date(at).toISOString() : (typeof at === 'string' && at ? at : new Date().toISOString());
  record.sessions[sessionId] = {
    line,
    at: when,
    source: 'delivered',
    usageSource: usageSource === 'per_call' || usageSource === 'session_totals' ? usageSource : null,
  };
  return record;
}

// ── The eligibility decision ────────────────────────────────────────────────────────────────────

export const ReplayDecision = Object.freeze({
  REPLAY: 'replay',
  DEFER: 'defer',
});

export const DeferReason = Object.freeze({
  // We could not ask the server. Retry later; never downgrade this to a scan from zero.
  UNAVAILABLE: 'coverage-unavailable',
  // The server's answer contradicts what this machine believes it delivered, so no start line can be proven not to overlap.
  GAP: 'coverage-gap',
  // The engine returned segments at or below the boundary we asked it to start after.
  OVERLAP: 'overlap',
  // Lines below the start may hold per-call tokens that a replay of shutdown totals would count again.
  USAGE_MODE: 'usage-mode',
});

// A REJECTED ledger entry is not delivery: pass ledgerDelivered false for it, so a once-unconnected repository replays in full.
export function decideReplay(sessionId, facts = {}) {
  const coverage = facts.coverage instanceof Map ? facts.coverage : null;
  const checkpointLine = Number.isInteger(facts.checkpointLine) && facts.checkpointLine >= 0 ? facts.checkpointLine : null;
  const localCursor = Number.isInteger(facts.localCursor) && facts.localCursor > 0 ? facts.localCursor : 0;
  const delivered = facts.ledgerDelivered === true;

  if (coverage === null) {
    return { decision: ReplayDecision.DEFER, reason: DeferReason.UNAVAILABLE, startCursor: null, stored: null };
  }
  const stored = coverage.has(sessionId) ? coverage.get(sessionId) : 0;
  const gap = { decision: ReplayDecision.DEFER, reason: DeferReason.GAP, startCursor: null, stored };

  if (stored > 0) {
    // Either witness ahead of the server's prefix means lines above `stored` are not all free.
    if ((checkpointLine !== null && checkpointLine > stored) || localCursor > stored) return gap;
    return { decision: ReplayDecision.REPLAY, reason: null, startCursor: stored, stored };
  }

  // stored === 0 is both "never delivered" and "everything stored sits past a gap"; any one witness of the second reading defers.
  if ((checkpointLine !== null && checkpointLine > 0) || localCursor > 0 || delivered) return gap;
  return { decision: ReplayDecision.REPLAY, reason: null, startCursor: 0, stored };
}

// ── The start line for a session with no cursor yet ─────────────────────────────────────────────

// → { startLine } | { deferred: true, reason }: asks each recipient in turn inside one deadline, the first DEFER wins, and the highest prefix overlaps nobody.
export async function establishStart(sessionId, recipients, { timeoutMs = 5000 } = {}) {
  try {
    if (!isUsableSessionId(sessionId)) return { deferred: true, reason: 'invalid-session-id' };
    if (!Array.isArray(recipients) || recipients.length === 0) return { deferred: true, reason: 'no-recipients' };
    const deadline = Date.now() + timeoutMs;
    let startLine = 0;
    for (const recipient of recipients) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { deferred: true, reason: DeferReason.UNAVAILABLE };
      const tenantId = recipient.tenantId == null ? null : recipient.tenantId;
      const coverage = await fetchCoverage([sessionId], recipient, {}, { timeoutMs: remaining });
      const record = loadCoverageCheckpoints(recipient.key, currentBinding(recipient.clientId, tenantId));
      const ledger = loadLedger(recipient.key, recipient.clientId, tenantId);
      const verdict = decideReplay(sessionId, {
        coverage,
        checkpointLine: checkpointLineFor(record, sessionId),
        localCursor: 0,
        ledgerDelivered: ledgerDelivered(ledger, sessionId),
      });
      if (verdict.decision === ReplayDecision.DEFER) return { deferred: true, reason: verdict.reason };
      if (verdict.startCursor > startLine) startLine = verdict.startCursor;
    }
    return { startLine };
  } catch {
    return { deferred: true, reason: DeferReason.UNAVAILABLE };
  }
}
