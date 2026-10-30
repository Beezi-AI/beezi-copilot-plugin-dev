// The durable per-account coverage record: the highest parent line this machine confirmed delivered, per session.
import path from 'path';
import { apiBase, storedApiBase } from '../config/api.mjs';
import { accountDir, tenantTag, BEEZI_ENV } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';

const COVERAGE_FILE_VERSION = 1;

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
  if (storedApiBase(record.apiBase) !== (binding.apiBase == null ? null : binding.apiBase)) return false;
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
