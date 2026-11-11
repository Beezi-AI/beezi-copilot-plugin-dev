// login-flow.mjs: /beezi-dev-login's steps up to the tracking question, then (`--from finish`) the rest, as blocks ending in `next=<step>[ account=<key>]`.
import { parseAccountFlag } from '../accounts/index-store.mjs';
import { pluginRoot } from '../config/plugin-root.mjs';
import { UserError } from '../core/errors.mjs';
import { machineLine } from '../ux/machine-lines.mjs';
import { NO_PLAN, closingLines } from '../ux/setup/finale.mjs';
import { createStyle } from '../ux/setup/style.mjs';
import { applyDefaults, uploadPast } from './setup/finish.mjs';
import { report } from './setup/output.mjs';
import { capturePlan } from './setup/plan.mjs';
import { parseListing, settled } from './setup/routing.mjs';
import { createRunner } from './setup/runner.mjs';
import { signInResult } from './setup/sign-in.mjs';

const USAGE = 'Usage: login-flow.mjs [--account <ref> [--from finish]]';
const PLAIN = createStyle({ enabled: false });

function block(tag, lines) {
  console.log([`<${tag}>`].concat(lines, [`</${tag.split(' ')[0]}>`]).join('\n'));
}

function next(step, key) {
  console.log(key == null ? `next=${step}` : machineLine([['next', step], ['account', key]]));
}

// A ctx for the setup helpers that collects what they print.
function collector(run, lines) {
  return { run, print: (line) => { lines.push(line); } };
}

// The silent capture: the plan found, or the line saying it was not, after any failure the capture printed.
async function planStep(key, run) {
  const lines = [];
  const plan = await capturePlan(collector(run, lines), key);
  block('plan', lines.concat([plan === null ? NO_PLAN : `✓ Plan found: ${plan}`]));
}

// Prints the listing and resolves null when the agent asks the question; else what the finish step shows first.
async function trackStep(key, run) {
  const lead = [];
  const ctx = collector(run, lead);
  const result = await run('workspace', ['setup', '--account', key]);
  if (result.code !== 0) {
    report(ctx, result);
    return { lead, upload: false, pastFailed: true };
  }
  if (await settled(ctx, key, parseListing(result.stdout))) return { lead, upload: false, pastFailed: false };
  block(`track account="${key}"`, [result.stdout.trim()]);
  return null;
}

// The lines the agent shows verbatim: the lead, the upload line, then the closing lines.
async function finish(key, run, start) {
  const lines = start.lead.slice();
  const ctx = collector(run, lines);
  if (start.upload) await uploadPast(ctx, key);
  const on = await applyDefaults(ctx);
  const closing = closingLines({ style: PLAIN, crash: on.crash, statusline: on.statusline, planFound: true, pastFailed: start.pastFailed });
  block('finish', lines.length === 0 ? closing.slice(1) : lines.concat(closing));
  next('done', key);
}

async function fromPlan(key, run) {
  await planStep(key, run);
  const done = await trackStep(key, run);
  if (done === null) next('track', key);
  else await finish(key, run, done);
}

// The browser sign-in, streamed inside its block (its ✗ line too), then the plan and the listing.
async function signIn(run) {
  console.log('<sign-in>');
  const result = await run('login', [], { stream: true });
  console.log('</sign-in>');
  const account = signInResult(result);
  if (account !== null) return fromPlan(account.key, run);
  process.exitCode = 1;
  next('stop');
}

// Child scripts get this session's environment and cwd; stderr joins stdout so a ✗ line stays inside its block.
function defaultRunner() {
  return createRunner({ root: pluginRoot(), env: process.env, sessionKeys: [], cwd: process.cwd(), stdout: process.stdout, stderr: process.stdout });
}

// deps: `run(name, argv, opts)`, a scripts/<name>.mjs child.
export async function loginFlow(argv, deps = {}) {
  const run = deps.run == null ? defaultRunner() : deps.run;
  const { account, rest } = await parseAccountFlag(argv);
  if (account == null && rest.length === 0) return signIn(run);
  if (account != null && rest.length === 0) return fromPlan(account, run);
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || rest[1] !== 'finish') throw new UserError(USAGE);
  return finish(account, run, { lead: [], upload: true, pastFailed: false });
}
