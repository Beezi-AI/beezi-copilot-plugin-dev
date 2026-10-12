import fs from 'fs';
import path from 'path';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';
import { beeziHome } from '../config/paths.mjs';
import { uuid } from '../platform/uuid.mjs';
import { isCorrelationGranted, CORRELATION_CONSENT_VERSION } from './consent.mjs';

const RECORD_VERSION = 1;
// The server expires a binding after 90 days of silence; re-assert it well inside that window so
// an active machine is never quietly unbound.
const REBIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The diagnostic installation ID: a random correlation identifier, never a credential. It lives
// at the root of beeziHome(), beside the credential STORE rather than inside it, so wiping,
// rotating or failing to refresh OAuth credentials never touches it.
//
// Rotation on logout is the whole point of the seam: events recorded after someone signs out
// must not correlate back to the account that just left the machine.
export function installationIdFile() {
  return path.join(beeziHome(), 'installation.json');
}

export function readInstallationRecord() {
  const raw = readJson(installationIdFile());
  if (raw == null || raw.version !== RECORD_VERSION || !UUID_V4.test(String(raw.id))) return null;
  return raw;
}

// Mints on first need, and only behind the correlation grant — a machine that never opted in
// never has an identifier to leak. Returns null when correlation is off or the write fails.
export function ensureInstallationId(now = Date.now()) {
  if (!isCorrelationGranted()) return null;
  const existing = readInstallationRecord();
  if (existing != null) return existing.id;
  const record = {
    version: RECORD_VERSION,
    id: uuid(),
    createdAt: new Date(now).toISOString(),
    boundAt: null,
    consentVersion: CORRELATION_CONSENT_VERSION,
  };
  try {
    writeJsonSecure(installationIdFile(), record);
  } catch {
    return null;
  }
  return record.id;
}

// What an event is stamped with. Deliberately requires a CONFIRMED binding: an installation the
// server has never associated with an account carries no correlation value, and sending it would
// only build a fleet-wide identifier out of nothing.
export function currentInstallationId() {
  if (!isCorrelationGranted()) return null;
  const record = readInstallationRecord();
  return record == null || record.boundAt == null ? null : record.id;
}

// True when authenticated activity should (re)assert the binding: never bound, or bound long
// enough ago that the server's expiry sweep is in sight.
export function needsBinding(now = Date.now()) {
  if (!isCorrelationGranted()) return false;
  const record = readInstallationRecord();
  if (record == null) return true;
  if (record.boundAt == null) return true;
  const boundMs = Date.parse(record.boundAt);
  return !Number.isFinite(boundMs) || now - boundMs > REBIND_AFTER_MS;
}

export function markBound(now = Date.now()) {
  const record = readInstallationRecord();
  if (record == null) return false;
  try {
    writeJsonSecure(installationIdFile(), { ...record, boundAt: new Date(now).toISOString() });
    return true;
  } catch {
    return false;
  }
}

// Discards the current identifier. The next process that needs one mints a fresh one, so a
// missing file is the "rotated" state — there is deliberately nothing to write here. Used by
// logout and by a 409 binding conflict, which must never reassign an ID to a second account.
export function rotateInstallationId() {
  try {
    fs.unlinkSync(installationIdFile());
    return true;
  } catch {
    return false; // never created, or already gone
  }
}
