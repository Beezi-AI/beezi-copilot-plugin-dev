import { execFileSync } from 'child_process';
import fs from 'fs';
import { POWERSHELL } from './windows-paths.mjs';

// Process identity for the credential lock: a pid alone cannot tell a crashed holder from an
// unrelated process that inherited its number, so the lock records the holder's start time and a
// later waiter compares it with what the OS reports for that pid now. Both sides are epoch seconds.

// Recorded (process.uptime) and probed (ps / proc / Get-Process) start times round differently and
// the probe has its own latency; anything closer than this is the same process.
export const START_TIME_TOLERANCE_S = 3;

// This process's own start, from process.uptime(): no spawn on the acquire path.
export function ownStartTime() {
  return Math.round(Date.now() / 1000 - process.uptime());
}

// Default cap on one probe; a caller with a shorter wait passes its own, since a hook must not block past its lock wait.
export const PROBE_TIMEOUT_MS = 5000;

// stdout of a bounded, shell-less command, or null on any failure.
function defaultRun(file, args, timeoutMs) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch {
    return null;
  }
}

// ps etime is "[[dd-]hh:]mm:ss" of elapsed run time. Elapsed rather than lstart on purpose: lstart
// prints a local wall-clock date whose parse is ambiguous across a DST change, and a wrong answer
// there would reclaim a live holder.
function parseElapsed(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function psStartTime(pid, run, timeoutMs) {
  const out = run('ps', ['-p', String(pid), '-o', 'etime='], timeoutMs);
  const elapsed = out == null ? null : parseElapsed(out);
  return elapsed == null ? null : Math.round(Date.now() / 1000) - elapsed;
}

// /proc/<pid>/stat field 22 is the start time in USER_HZ (always 100) ticks since boot, and
// /proc/stat's btime line is the boot instant in epoch seconds. No spawn.
function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // fields[0] is field 3
    const ticks = Number(fields[19]);
    const btimeLine = fs.readFileSync('/proc/stat', 'utf-8').split('\n').find((l) => l.startsWith('btime '));
    const btime = btimeLine == null ? NaN : Number(btimeLine.slice(6));
    return Number.isFinite(ticks) && Number.isFinite(btime) ? Math.round(btime + ticks / 100) : null;
  } catch {
    return null;
  }
}

// FILETIME is 100ns intervals since 1601-01-01 UTC.
function windowsStartTime(pid, run, timeoutMs) {
  const out = run(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToFileTimeUtc()`,
  ], timeoutMs);
  const filetime = out == null ? NaN : Number(out.trim());
  return Number.isFinite(filetime) ? Math.round(filetime / 1e7 - 11644473600) : null;
}

// Epoch seconds at which `pid` started, or null when it cannot be determined — callers must treat
// null as "possibly the same process". Spawns ps / PowerShell except on Linux with /proc, capped at deps.timeoutMs.
export function processStartTime(pid, deps = {}) {
  const platform = deps.platform == null ? process.platform : deps.platform;
  const run = deps.run == null ? defaultRun : deps.run;
  const timeoutMs = deps.timeoutMs == null ? PROBE_TIMEOUT_MS : deps.timeoutMs;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    const fromProc = procStartTime(pid);
    if (fromProc != null) return fromProc;
  }
  if (platform === 'win32') return windowsStartTime(pid, run, timeoutMs);
  return psStartTime(pid, run, timeoutMs);
}
