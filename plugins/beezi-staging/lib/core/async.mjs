// Small wait helpers: bounded concurrency, a macrotask yield, a timed sleep and its blocking twin.

// Run `worker` over `items` with at most `limit` in flight.
export async function mapLimited(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// One macrotask, so a JSON-RPC channel sharing the loop keeps answering between long steps.
export function yieldToLoop() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks the thread for `ms` through Atomics.wait; returns at once where shared memory is unavailable.
export function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no shared memory: retry at once */ }
}
