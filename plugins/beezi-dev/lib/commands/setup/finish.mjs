// The last steps of the terminal setup: the consented past-sessions upload and the machine defaults.
import { lastLine, report, token } from './output.mjs';

// Queues the consented upload and says how many sessions are on their way; a failure prints its own lines first.
export async function uploadPast(ctx, key) {
  const result = await ctx.run('history-offer', ['--via', 'setup', '--account', key, '--consented']);
  if (result.code !== 0) report(ctx, result);
  const line = lastLine(result.stdout, /^uploading=\d+ /);
  const n = line === null ? 0 : Number(token(line, 'uploading'));
  if (n === 1) ctx.print('✓ 1 past session is uploading in the background');
  if (n > 1) ctx.print(`✓ ${n} past sessions are uploading in the background`);
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
