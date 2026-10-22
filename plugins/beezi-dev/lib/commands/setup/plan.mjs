// The Copilot plan steps of the terminal setup: capture from Copilot, then ask where it had none.
import { lastLine, reportAll } from './output.mjs';

export const PLAN_QUESTION = 'Which GitHub Copilot plan pays for your Copilot use on this machine?';
export const PLAN_SKIPPED = 'No plan was saved. Your Beezi link itself succeeded; /beezi-dev-settings refresh sets the plan later.';
const PLANS = [
  { label: 'Copilot Free', value: 'copilot_free' },
  { label: 'Copilot Student', value: 'copilot_student' },
  { label: 'Copilot Pro', value: 'copilot_pro' },
  { label: 'Copilot Pro+', value: 'copilot_pro_plus' },
  { label: 'Copilot Max', value: 'copilot_max' },
  { label: 'Copilot Business', description: 'A seat from your organization', value: 'copilot_business' },
  { label: 'Copilot Enterprise', description: 'A seat from your enterprise', value: 'copilot_enterprise' },
  { label: "I don't know", value: null },
];

export function vscodeQuestion(login) {
  return `VS Code's Copilot is signed in as ${login}, a different GitHub account. Which Copilot plan does ${login} have?`;
}

export function vscodeSkipped(login) {
  return `No plan was saved for ${login}. /beezi-dev-settings refresh sets it later.`;
}

// A machine line's value in the capture output, or null.
export function machineValue(text, key) {
  const line = lastLine(text, new RegExp(`^${key}=`));
  return line === null ? null : line.slice(key.length + 1);
}

// The picked plan value; null for "I don't know" or a dismissal.
async function askPlan(ctx, question) {
  const options = PLANS.map((plan) => (plan.description ? { label: plan.label, description: plan.description } : { label: plan.label }));
  const i = await ctx.ask.choose(question, options);
  return i === null ? null : PLANS[i].value;
}

// login Steps 2, 3 and 3v: the plan from Copilot, then the question for each GitHub account it had no plan for.
export async function capturePlan(ctx, key) {
  const capture = await ctx.run('billing-capture', ['--from-copilot', '--via', 'login', '--account', key]);
  reportAll(ctx, capture);
  if (capture.code !== 0) return;
  if (machineValue(capture.stdout, 'plan-source') === 'none') {
    const value = await askPlan(ctx, PLAN_QUESTION);
    if (value === null) ctx.print(PLAN_SKIPPED);
    else reportAll(ctx, await ctx.run('billing-capture', ['--plan', value, '--via', 'login-user', '--account', key]));
  }
  const login = machineValue(capture.stdout, 'vscode-login');
  const identity = machineValue(capture.stdout, 'vscode-identity');
  if (machineValue(capture.stdout, 'vscode-plan-source') !== 'none' || login === null || identity === null) return;
  const value = await askPlan(ctx, vscodeQuestion(login));
  if (value === null) {
    ctx.print(vscodeSkipped(login));
    return;
  }
  reportAll(ctx, await ctx.run('billing-capture', ['--plan', value, '--github', identity, '--via', 'login-user', '--account', key]));
}
