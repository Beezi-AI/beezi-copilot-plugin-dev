// The terminal setup flow: the /beezi-dev-login steps in a terminal, then crash reports and the status line.
import { chooseAccount, machineReady } from './account.mjs';
import { askMachineSettings, offerDefault, uploadHistory } from './finish.mjs';
import { capturePlan } from './plan.mjs';
import { askNewFolders, reviewJoined, reviewRoutes } from './routing.mjs';

export const MACHINE_LABEL = 'Checking this machine…';
export const WORKSPACES_LABEL = 'Checking your workspaces…';
export const PLAN_LABEL = 'Checking your plan…';
export const SESSIONS_LABEL = 'Looking at your past sessions…';
export const SETTINGS_LABEL = 'Saving your settings…';

// 0 when done; 1 when preflight refuses or no account was chosen or signed in. Each phase names the activity line its runs show.
export async function runSetup(ctx) {
  ctx.progress(MACHINE_LABEL);
  if (!(await machineReady(ctx))) return 1;
  const account = await chooseAccount(ctx);
  if (account === null) return 1;
  ctx.progress(WORKSPACES_LABEL);
  await askNewFolders(ctx, account.key);
  ctx.progress(PLAN_LABEL);
  await capturePlan(ctx, account.key);
  await offerDefault(ctx, account);
  ctx.progress(SESSIONS_LABEL);
  await reviewJoined(ctx, account.key);
  await reviewRoutes(ctx, account.key);
  await uploadHistory(ctx, account.key);
  ctx.progress(SETTINGS_LABEL);
  await askMachineSettings(ctx);
  return 0;
}
