// The Copilot plan step of the terminal setup: the silent capture from Copilot, never a question.
import { planLabel } from '../../billing/plan-resolution.mjs';
import { lastLine, report } from './output.mjs';

// A machine line's value in the capture output, or null.
function machineValue(text, key) {
  const line = lastLine(text, new RegExp(`^${key}=`));
  return line === null ? null : line.slice(key.length + 1);
}

// The plan the capture settled on, as "Copilot <label>"; null when it found none. Only a failure prints.
export async function capturePlan(ctx, key) {
  const capture = await ctx.run('billing-capture', ['--from-copilot', '--via', 'login', '--account', key]);
  if (capture.code !== 0) {
    report(ctx, capture);
    return null;
  }
  if (machineValue(capture.stdout, 'plan-source') === 'none') return null;
  const label = planLabel(machineValue(capture.stdout, 'plan'));
  return label === null ? null : `Copilot ${label}`;
}
