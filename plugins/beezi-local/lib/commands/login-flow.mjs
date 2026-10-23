// login-flow.mjs: /beezi-local-login's steps in as few calls as its questions allow. Each call runs from the sign-in (or
// `--from <step>`) up to the next question, printing each step's output as a block and `next=<step>[ account=<key>]` last.
import { getAccount, getDefaultKey, parseAccountFlag } from '../accounts/index-store.mjs';
import { pluginRoot } from '../config/plugin-root.mjs';
import { isMultiTenant, tenantsOf } from '../workspace/tenants.mjs';
import { newFoldersOf } from '../workspace/targets.mjs';
import { createRouteContext, routeKeyForDir } from '../workspace/route-key.mjs';
import { routeForDir } from '../workspace/routing.mjs';
import { choiceDir, currentSessionWorkspace } from '../workspace/session-routes.mjs';
import { pastSessions } from '../history/past-sessions.mjs';
import { UserError, friendlyMessage } from '../core/errors.mjs';
import { workspaceLines } from '../ux/workspace-lines.mjs';
import { machineLine } from '../ux/machine-lines.mjs';
import { createRunner } from './setup/runner.mjs';
import { signInResult } from './setup/sign-in.mjs';
import { machineValue } from './setup/plan.mjs';
import { setupOptions } from './setup/routing.mjs';
import { joined } from './workspace/joined.mjs';
import { routes } from './workspace/routes.mjs';
import { rules } from './workspace/rules.mjs';

const FROM_STEPS = ['setup', 'here', 'plan', 'default', 'joined', 'routes'];
const USAGE = `Usage: login-flow.mjs [--account <ref> --from <${FROM_STEPS.join('|')}>]`;

function block(tag, result) {
  const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  console.log([`<${tag}>`].concat(text === '' ? [] : [text], [`</${tag}>`]).join('\n'));
}

// An in-process workspace.mjs listing as a block; one that throws keeps its ✗ line there and returns null.
async function listing(tag, key, print) {
  console.log(`<${tag} account="${key}">`);
  let result = null;
  try {
    result = await print();
  } catch (error) {
    console.log(`✗ ${friendlyMessage(error)}`);
    result = null;
  }
  console.log(`</${tag}>`);
  return result;
}

function next(step, key) {
  console.log(key == null ? `next=${step}` : machineLine([['next', step], ['account', key]]));
}

// The one question for an account in several workspaces: its W. lines, the counts, then the options. A count that fails
// prints its ✗ line and the options without counts: the question still stands.
function setupQuestion(row, count) {
  const lines = workspaceLines(row);
  let history = null;
  try {
    history = count(row);
    lines.push(machineLine([['sessions', history.sessions], ['places', history.places]]));
  } catch (error) {
    history = null;
    lines.push(`✗ ${friendlyMessage(error)}`);
  }
  const workspaces = tenantsOf(row).map((t) => ({ name: t.name ? t.name : t.id }));
  setupOptions(workspaces, history).forEach((option, i) => lines.push(`O${i + 1}. ${option.label} — ${option.description}`));
  console.log([`<setup account="${row.key}">`].concat(lines, ['</setup>']).join('\n'));
}

// Under Ask me, this session's folder with no rule is asked about next; decided from the routing itself, not the here: line.
async function hereStops(row, deps) {
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return false;
  const dir = deps.hereDir();
  const ctx = createRouteContext();
  if (routeKeyForDir(dir, ctx) == null || routeForDir(row, dir, ctx) != null) return false;
  return (await listing('rules', row.key, async () => { await deps.lists.rules(['--account', row.key]); return true; })) === true;
}

// The plan capture; true when Copilot or VS Code's GitHub account had no plan, so the skill asks for it.
async function planStops(row, deps) {
  const capture = await deps.run('billing-capture', ['--from-copilot', '--via', 'login', '--account', row.key]);
  block('capture', capture);
  return capture.code === 0 && (machineValue(capture.stdout, 'plan-source') === 'none' || machineValue(capture.stdout, 'vscode-plan-source') === 'none');
}

// Each step's stop test, in the order the skill runs them; a step that stops has printed what its question needs.
const STOPS = {
  setup: async (row, deps) => {
    if (!isMultiTenant(row) || newFoldersOf(row).set) return false;
    setupQuestion(row, deps.pastSessions);
    return true;
  },
  here: hereStops,
  plan: planStops,
  // login.mjs names the analytics reader exactly when it is another account.
  default: async (row) => (await getDefaultKey()) !== row.key,
  joined: async (row, deps) => (await listing('joined', row.key, () => deps.lists.joined(['--account', row.key]))) > 0,
  routes: async (row, deps) => (await listing('routes', row.key, () => deps.lists.routes(['--account', row.key]))) > 0,
};

// From `from` on, the first step that needs a question; 'backfill' when none does.
async function fromStep(from, key, deps) {
  const row = await getAccount(key);
  if (row == null) throw new UserError('That account is not linked on this machine. Run /beezi-local-login again.');
  for (const step of FROM_STEPS.slice(FROM_STEPS.indexOf(from))) {
    if (await STOPS[step](row, deps)) return step;
  }
  return 'backfill';
}

// The browser sign-in, streamed inside its block (its ✗ line too); the key it linked, or null.
async function signIn(deps) {
  console.log('<sign-in>');
  const result = await deps.run('login', [], { stream: true });
  console.log('</sign-in>');
  const account = signInResult(result);
  if (account === null) process.exitCode = 1;
  return account === null ? null : account.key;
}

// Child scripts get this session's environment and cwd; stderr joins stdout so a ✗ line stays inside its block.
function defaultRunner() {
  return createRunner({ root: pluginRoot(), env: process.env, sessionKeys: [], cwd: process.cwd(), stdout: process.stdout, stderr: process.stdout });
}

// deps: `run(name, argv, opts)` (a scripts/<name>.mjs child), `lists` (the workspace.mjs handlers), `pastSessions(row)` for the
// setup counts and `hereDir()` (this session's folder).
export async function loginFlow(argv, deps = {}) {
  const all = Object.assign({
    lists: { joined, routes, rules },
    pastSessions: (row) => pastSessions(row),
    hereDir: () => choiceDir(currentSessionWorkspace()),
  }, deps);
  if (all.run == null) all.run = defaultRunner();
  const { account, rest } = await parseAccountFlag(argv);
  if (account == null && rest.length === 0) {
    const key = await signIn(all);
    if (key === null) next('stop');
    else next(await fromStep('setup', key, all), key);
    return;
  }
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || FROM_STEPS.indexOf(rest[1]) === -1) throw new UserError(USAGE);
  next(await fromStep(rest[1], account, all), account);
}
