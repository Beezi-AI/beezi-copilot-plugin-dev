// The terminal setup flow: preflight, account, plan, tracking, upload, machine defaults, then the closing block.
import { closingLines } from '../../ux/setup/finale.mjs';
import { chooseAccount, machineReady, signedInLine } from './account.mjs';
import { applyDefaults, uploadPast } from './finish.mjs';
import { capturePlan } from './plan.mjs';
import { askTracking } from './routing.mjs';

const MACHINE_LABEL = 'Checking this machine';
const SESSIONS_LABEL = 'Checking past sessions';

// 0 when done, with ctx.notices just before the closing block; 1 when preflight refuses or no account signed in.
export async function runSetup(ctx) {
  ctx.progress(MACHINE_LABEL);
  if (!(await machineReady(ctx))) return 1;
  const account = await chooseAccount(ctx);
  if (account === null) return 1;
  ctx.print(await signedInLine(ctx, account));
  const plan = await capturePlan(ctx, account.key);
  if (plan !== null) ctx.print(`✓ Plan found: ${plan}`);
  ctx.progress(SESSIONS_LABEL);
  const tracking = await askTracking(ctx, account.key);
  if (tracking !== null && tracking.tracked) await uploadPast(ctx, account.key);
  if (tracking !== null) tracking.trailer.forEach((line) => ctx.print(line));
  ctx.progress(MACHINE_LABEL);
  const on = await applyDefaults(ctx);
  ctx.notices.forEach((line) => ctx.print(line));
  const pastFailed = tracking !== null && tracking.failed === true;
  closingLines({ style: ctx.style, crash: on.crash, statusline: on.statusline, planFound: plan !== null, pastFailed })
    .forEach((line) => ctx.print(line));
  return 0;
}
