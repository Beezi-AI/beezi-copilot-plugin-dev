// Pure pacing of the watcher loop: how many ticks an idle watcher skips and which pass summaries reach the log.

// 20 s ticks: skipping 0, 1, 3 then 5 ticks spaces idle passes 20 s, 40 s, 80 s and at most 2 min apart.
const MAX_IDLE_SKIP = 5;

// A pass that committed, established or ran history did work; anything else (nothing changed, hooks active, sessions held)
// lets the next one wait longer. → ticks to skip before the next pass.
export function nextIdleSkip(previousSkip, summary) {
  const worked = summary.committed + summary.established + summary.history > 0;
  return worked ? 0 : Math.min(MAX_IDLE_SKIP, previousSkip * 2 + 1);
}

export function summaryLine(summary) {
  return `watcher pass: checkpointed=${summary.checkpointed} committed=${summary.committed} established=${summary.established} `
    + `deferred=${summary.deferred} cooling=${summary.cooling} hookActive=${summary.hookActive} errors=${summary.errors}`;
}

// A pass is logged when it committed or established something, or when its counts differ from the last pass's; an all-zero
// pass is never logged.
export function shouldLogPass(summary, line, lastLine) {
  if (summary.committed + summary.established > 0) return true;
  const quiet = summary.checkpointed + summary.deferred + summary.cooling + summary.hookActive + summary.errors === 0;
  return !quiet && line !== lastLine;
}
