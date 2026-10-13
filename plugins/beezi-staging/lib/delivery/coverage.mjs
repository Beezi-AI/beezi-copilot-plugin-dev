// Server coverage: the stored-prefix query, the replay eligibility decision and a live session's start line.
import { apiBase, ENDPOINTS } from '../config/api.mjs';
import { postJson } from '../platform/http.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { loadLedger, ledgerDelivered } from '../state/ledger.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { currentBinding, loadCoverageCheckpoints, checkpointLineFor } from '../state/coverage-record.mjs';

// A replay is append-only: it starts at the server's contiguous parent-line prefix or the session is deferred, and "could not ask" (null) is never read as "nothing stored".

// One request answers at most this many session ids.
export const MAX_COVERAGE_IDS = 200;

// A foreground command's budget; the hook budget that shrinks postJson's default does not apply.
const COVERAGE_TIMEOUT_MS = 60000;

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

// → { startLine, lagging } | { deferred: true, reason }: asks each recipient in turn inside one deadline, the first DEFER
// wins, and the highest prefix overlaps nobody. lagging = [{ key, tenantId, startLine }] for each recipient whose own
// prefix is below startLine: the lines between are theirs to replay (a sync for that account), never re-sent to all.
export async function establishStart(sessionId, recipients, { timeoutMs = 5000, postJsonImpl = null } = {}) {
  try {
    if (!isUsableSessionId(sessionId)) return { deferred: true, reason: 'invalid-session-id' };
    if (!Array.isArray(recipients) || recipients.length === 0) return { deferred: true, reason: 'no-recipients' };
    const deadline = Date.now() + timeoutMs;
    const starts = [];
    for (const recipient of recipients) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { deferred: true, reason: DeferReason.UNAVAILABLE };
      const tenantId = recipient.tenantId == null ? null : recipient.tenantId;
      const coverage = await fetchCoverage([sessionId], recipient, { postJsonImpl }, { timeoutMs: remaining });
      const record = loadCoverageCheckpoints(recipient.key, currentBinding(recipient.clientId, tenantId));
      const ledger = loadLedger(recipient.key, recipient.clientId, tenantId);
      const verdict = decideReplay(sessionId, {
        coverage,
        checkpointLine: checkpointLineFor(record, sessionId),
        localCursor: 0,
        ledgerDelivered: ledgerDelivered(ledger, sessionId),
      });
      if (verdict.decision === ReplayDecision.DEFER) return { deferred: true, reason: verdict.reason };
      starts.push({ key: recipient.key, tenantId, startLine: verdict.startCursor });
    }
    const startLine = Math.max.apply(null, starts.map((s) => s.startLine));
    return { startLine, lagging: starts.filter((s) => s.startLine < startLine) };
  } catch {
    return { deferred: true, reason: DeferReason.UNAVAILABLE };
  }
}
