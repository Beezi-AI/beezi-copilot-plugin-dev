// Owns the signal-0 liveness probe for a local pid.

// Signal 0 tests the pid without touching it: EPERM means it exists under another user, any other error means gone.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}
