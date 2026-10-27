// The last steps of the terminal setup: the default account, the past-sessions offer, crash reports and the status line.
import { usableAccounts } from './account.mjs';
import { humanLines, lastLine, outputLines, report, reportAll, token } from './output.mjs';
import { SYNC_COMMAND } from '../../ux/history-offer-lines.mjs';

export const DEFAULT_UNCHANGED = 'The default account is unchanged. /beezi-local-settings account switches it later.';
export const CRASH_QUESTION = 'How should Beezi crash reports work?';
export const STATUS_LINE_QUESTION = "Show Beezi in the Copilot CLI's status line?";
const OFFER_OPEN = /^<offer account="[^"]*" tenant="([^"]*)">$/;
const OFFER_CLOSE = '</offer>';
const QUESTION = 'question=';
const OFFER_TOKEN = /^accept-command=.* --offer ([0-9a-f]+)(?: |$)/;
export const UPLOAD_OPTIONS = [{ label: 'Upload now' }, { label: 'Not now', description: `run ${SYNC_COMMAND} any time` }];
const CRASH_OPTIONS = [
  { label: 'Correlate (recommended)', description: 'Crash reports with an installation ID, so support can find yours', mode: 'correlate' },
  { label: 'On', description: 'Crash reports without an installation ID', mode: 'on' },
  { label: 'Off', description: 'No crash reports; pending ones are deleted', mode: 'off' },
  { label: 'Anonymous', description: 'Stay on, and delete the installation ID and the reports that carry it', mode: 'anonymous' },
];

// A history-offer scan's output: its <offer> blocks as { tenant, lines, question, token }, and the person's lines outside them.
export function parseOffers(text) {
  const offers = [];
  const outside = [];
  let open = null;
  outputLines(text).forEach((line) => {
    const head = OFFER_OPEN.exec(line);
    if (head !== null) open = { tenant: head[1], lines: [], question: null, token: null };
    else if (open === null) outside.push(line);
    else if (line === OFFER_CLOSE) {
      offers.push(open);
      open = null;
    } else if (line.indexOf(QUESTION) === 0) open.question = line.slice(QUESTION.length);
    else if (OFFER_TOKEN.test(line)) open.token = OFFER_TOKEN.exec(line)[1];
    else if (open.question === null) open.lines.push(line);
  });
  return { offers, notes: humanLines(outside.join('\n')) };
}

// Each offer's summary styled by line shape, then its question as a menu on "Upload now"; only that row accepts, and no answer declines.
export async function uploadHistory(ctx, key) {
  const scan = await ctx.run('history-offer', ['--via', 'setup', '--account', key]);
  if (scan.code !== 0) {
    report(ctx, scan);
    return;
  }
  const { offers, notes } = parseOffers(scan.stdout);
  notes.forEach((line) => ctx.print(line));
  for (const offer of offers) {
    offer.lines.forEach((line) => ctx.printOffer(line));
    const target = ['--account', key, '--tenant', offer.tenant];
    const picked = await ctx.ask.choose(offer.question, UPLOAD_OPTIONS, { defaultIndex: 0 });
    const answer = picked === 0 ? ['accept', ...target, '--offer', offer.token] : ['decline', ...target];
    reportAll(ctx, await ctx.run('history-offer', answer));
  }
}

// login Step 4: asked only when the sign-in left another account as the default reader.
export async function offerDefault(ctx, account) {
  if (!account.readsElsewhere) return;
  const listing = await ctx.run('accounts', ['list']);
  const row = usableAccounts(listing.stdout).find((a) => a.key === account.key);
  const name = row === undefined ? 'the account you just linked' : row.description;
  const yes = await ctx.ask.confirm(`Make ${name} the account /beezi-local-analytics reads from?`, false);
  if (yes === true) reportAll(ctx, await ctx.run('accounts', ['use', account.key]));
  if (yes === false) ctx.print(DEFAULT_UNCHANGED);
}

// The options with the current mode marked as the default.
export function crashChoice(current) {
  const options = CRASH_OPTIONS.map((option) => (option.mode === current
    ? { label: option.label, description: `${option.description}, current setting`, mode: option.mode }
    : option));
  return { options, defaultIndex: CRASH_OPTIONS.findIndex((option) => option.mode === current) };
}

// Runs telemetry.mjs for every answer, the current mode included.
async function askCrashReports(ctx, current) {
  const choice = crashChoice(current);
  const picked = await ctx.ask.choose(CRASH_QUESTION, choice.options, { defaultIndex: choice.defaultIndex });
  if (picked === null) return;
  report(ctx, await ctx.run('telemetry', [choice.options[picked].mode]));
}

// Crash reports, then the status line when it is off, from `settings.mjs keys`.
export async function askMachineSettings(ctx) {
  const keys = await ctx.run('settings', ['keys']);
  if (keys.code !== 0) {
    report(ctx, keys);
    return;
  }
  const line = lastLine(keys.stdout, /^crash=/);
  if (line === null) return;
  await askCrashReports(ctx, token(line, 'crash'));
  if (token(line, 'statusline') !== 'off') return;
  if (await ctx.ask.confirm(STATUS_LINE_QUESTION, true) === true) {
    report(ctx, await ctx.run('statusline-install', []));
  }
}
