// The last steps of the terminal setup: the consented past-sessions upload and the machine defaults.
import { sleep } from '../../core/async.mjs';
import { isLive, markReported, readProgress } from '../../history/upload-progress.mjs';
import { REST_LINE, barLine, doneLine, followUploads, plainLine } from '../../ux/upload-progress-view.mjs';
import { lastLine, report, token } from './output.mjs';

// Off a terminal (an agent's tool runs /beezi-staging-login) following stops before the tool times out; the worker carries on.
const PIPED_CAP_MS = 100000;
const unwatched = (task) => task(() => false);
const clearBar = (ctx) => { if (ctx.activity) ctx.draw(''); };

// The workspace's done line in place of its bar; marking it reported is best-effort, a lost mark only repeats the line.
function printDone(ctx, key, record) {
  clearBar(ctx);
  ctx.print(doneLine(record));
  try { markReported(key, record.tenantId); } catch { /* best-effort */ }
}

// Follows the worker's records of tenantIds: a bar redrawn in place on a terminal, plain lines otherwise.
async function followPast(ctx, key, tenantIds, sinceMs, now) {
  const ascii = ctx.platform === 'win32';
  const watch = ctx.whileFollowing || unwatched;
  const result = await watch((shouldStop) => followUploads({
    key,
    tenantIds,
    sinceMs,
    capMs: ctx.activity ? Infinity : PIPED_CAP_MS,
    shouldStop,
    onUpdate: (record) => (ctx.activity ? ctx.draw(barLine(record, { ascii, width: ctx.drawColumns })) : ctx.print(plainLine(record))),
    onDone: (record) => printDone(ctx, key, record),
    read: readProgress,
    isLive,
    now,
    sleep: ctx.sleep || sleep,
  }));
  if (!result.stopped && !result.timedOut) return;
  clearBar(ctx);
  ctx.print(REST_LINE);
}

// Owes the consented upload, then follows the worker uploading it; a failure prints its own lines first.
export async function uploadPast(ctx, key) {
  const now = ctx.now || Date.now;
  const sinceMs = now();
  const result = await ctx.run('history-offer', ['--via', 'setup', '--account', key, '--consented']);
  if (result.code !== 0) report(ctx, result);
  const line = lastLine(result.stdout, /^uploading=\d+ /);
  if (line === null || Number(token(line, 'uploading')) === 0) return;
  const tenantIds = (token(line, 'tenants') || '').split(',').filter((id) => id !== '');
  await followPast(ctx, key, tenantIds, sinceMs, now);
}

// The `crash=… statusline=…` line of `settings keys`, or null.
async function machineLine(ctx) {
  const keys = await ctx.run('settings', ['keys']);
  if (keys.code !== 0) report(ctx, keys);
  return lastLine(keys.stdout, /^crash=/);
}

// Crash reports on for an undecided machine and the status line installed when off; resolves what is on afterwards.
export async function applyDefaults(ctx) {
  const telemetry = await ctx.run('telemetry', ['default']);
  if (telemetry.code !== 0) report(ctx, telemetry);
  let line = await machineLine(ctx);
  if (line !== null && token(line, 'statusline') === 'off') {
    // A settings file the installer can't parse is not an error here: the status line just stays off.
    await ctx.run('statusline-install', []);
    line = await machineLine(ctx);
  }
  return {
    crash: line !== null && token(line, 'crash') !== 'off',
    statusline: line !== null && token(line, 'statusline') === 'on',
  };
}
