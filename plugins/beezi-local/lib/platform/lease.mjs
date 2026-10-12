// A renewable leased lock on a token file under locks/: acquire, renew, verify, release and takeover rules.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beeziHome } from '../config/paths.mjs';
import { writeJsonSecure } from './fs-store.mjs';

const LEASE_CAP_MS = 30 * 60 * 1000;
const LEASE_TAKEOVER_GRACE_MS = 60 * 1000;
const LEASE_UNPARSEABLE_FREE_MS = 15 * 1000;

export function leaseFile(name) {
  return path.join(beeziHome(), 'locks', `${name}.lease`);
}

// Read state of a lease file: missing, unparseable (with its mtime), or a normalized lease.
function inspectLease(name) {
  const file = leaseFile(name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? { state: 'missing' } : { state: 'bad', mtimeMs: Date.now() };
  }
  try {
    const raw = JSON.parse(text);
    if (raw == null || typeof raw !== 'object' || typeof raw.token !== 'string' || raw.token === '') throw new Error('shape');
    return {
      state: 'ok',
      lease: {
        token: raw.token,
        pid: Number.isInteger(raw.pid) ? raw.pid : null,
        hostname: typeof raw.hostname === 'string' ? raw.hostname : null,
        renewedAt: typeof raw.renewedAt === 'number' && isFinite(raw.renewedAt) ? raw.renewedAt : 0,
        leaseMs: typeof raw.leaseMs === 'number' && raw.leaseMs > 0 ? Math.min(raw.leaseMs, LEASE_CAP_MS) : LEASE_CAP_MS,
      },
    };
  } catch {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* vanished */ }
    return { state: 'bad', mtimeMs };
  }
}

// { token, pid, hostname, renewedAt, leaseMs } or null when the file is missing or unreadable.
export function readLease(name) {
  const seen = inspectLease(name);
  return seen.state === 'ok' ? seen.lease : null;
}

// False only for a holder on this host whose pid is gone (ESRCH); EPERM means alive, another host cannot be told.
export function leaseHolderAlive(lease) {
  if (lease == null || lease.pid == null) return false;
  if (lease.hostname !== os.hostname()) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function leaseTakeable(seen, nowMs) {
  if (seen.state === 'missing') return true;
  if (seen.state === 'bad') return nowMs - seen.mtimeMs > LEASE_UNPARSEABLE_FREE_MS;
  // A holder that is gone from this host (a Ctrl-C or a killed shell) frees the lease before it expires.
  if (seen.lease.pid != null && !leaseHolderAlive(seen.lease)) return true;
  const age = nowMs - seen.lease.renewedAt;
  const expired = age > seen.lease.leaseMs || age < -seen.lease.leaseMs;
  if (!expired) return false;
  return !leaseHolderAlive(seen.lease) || age > seen.lease.leaseMs + LEASE_TAKEOVER_GRACE_MS || age < -seen.lease.leaseMs - LEASE_TAKEOVER_GRACE_MS;
}

// Never throws; two takers can interleave unlink and create, and the loser learns on its next renew/verify and stops.
export function acquireLease(name, { leaseMs } = {}) {
  try {
    const file = leaseFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const token = crypto.randomBytes(16).toString('hex');
    const record = () => ({ token, pid: process.pid, hostname: os.hostname(), renewedAt: Date.now(), leaseMs });
    const create = () => {
      try {
        fs.writeFileSync(file, JSON.stringify(record()), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (!create()) {
      if (!leaseTakeable(inspectLease(name), Date.now())) return null;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') return null;
      }
      if (!create()) return null;
    }
    const owned = () => {
      const held = readLease(name);
      return held != null && held.token === token;
    };
    return {
      token,
      renew() {
        if (!owned()) return { ok: false, reason: 'lost' };
        try {
          writeJsonSecure(file, record());
          return { ok: true };
        } catch {
          return { ok: false, reason: 'write-failed' };
        }
      },
      verify() {
        return owned() ? { ok: true } : { ok: false, reason: 'lost' };
      },
      release() {
        try {
          if (owned()) fs.unlinkSync(file);
        } catch { /* best-effort */ }
      },
    };
  } catch {
    return null;
  }
}
