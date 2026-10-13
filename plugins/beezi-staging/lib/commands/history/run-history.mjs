// What backfill and sync share: the history run with its progress line, the per-workspace loop, outcome printing and the fatal exit.
import { runAudit } from '../../history/history-run.mjs';
import { progressLine, runHeader } from '../../ux/history-messages.mjs';

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// One history run, printing a progress line per parsed session.
export function runHistory(options) {
  return runAudit({ onProgress: (progress) => { console.log(progressLine(progress)); } }, options);
}

// Prints the outcome's lines, then its error as a ✗ line on stderr; 1 when there was an error, else 0.
export function printOutcome({ lines, error }) {
  for (const line of lines) console.log(line);
  if (error == null) return 0;
  console.error(`✗ ${error}`);
  return 1;
}

// Runs each routed workspace in order under its `— account · workspace —` header.
export async function forEachRun(row, runs, runOne) {
  for (const run of runs) {
    console.log(runHeader(row, run.tenantId));
    await runOne(run);
  }
}
