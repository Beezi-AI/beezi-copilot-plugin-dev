// The tracking step of the terminal setup: the one question from `workspace setup`, its tick lists and their writes.
import { offerLine } from '../../ux/setup/style.mjs';
import { lastLine, outputLines, printable, report, token } from './output.mjs';

const LABEL_END = /\), \d+ sessions?\b/;
const PLAIN_PLACE = /^(.*?), \d+ sessions?\b/;
const SESSIONS = /, (\d+) sessions?$/;
const NO_FOLDER = /^\d+ other past sessions? ha(?:s|ve) no recorded folder and (?:is|are) not sent\.$/;
const CHECKLIST_OPEN = '<checklist>';
const CHECKLIST_CLOSE = '</checklist>';
const NOT_TRACKED = 'none';
const NO_RULE = 'default';
const TRACKING_ALL = '✓ Tracking every repo and folder you work in';

export function parseWorkspaces(text) {
  return outputLines(text).filter((line) => /^W\. /.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    return { name: line.slice(3, at), tenant: token(line.slice(at), 'tenant') };
  });
}

// Splits "<short> (<label>), <k> sessions…" by walking back from the label's closing parenthesis.
function describePlace(body) {
  const end = body.search(LABEL_END);
  if (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i -= 1) {
      if (body[i] === ')') depth += 1;
      if (body[i] === '(') depth -= 1;
      if (depth === 0) return { short: body.slice(0, i).replace(/ $/, ''), label: body.slice(i + 1, end) };
    }
  }
  const plain = PLAIN_PLACE.exec(body);
  return { short: plain ? plain[1] : body, label: null };
}

// The listing's T lines; match= is the last field and runs to the line's end.
export function parsePlaces(text) {
  return outputLines(text).filter((line) => /^T\d+\. /.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    const fields = line.slice(at);
    const body = line.slice(0, at).replace(/^T\d+\. /, '');
    const matchFrom = fields.indexOf(' match=') + ' match='.length;
    const place = describePlace(body);
    const sessions = SESSIONS.exec(body);
    return {
      kind: token(fields, 'kind'),
      match: fields.slice(matchFrom),
      now: token(fields, 'now'),
      name: place.label !== null ? place.label : place.short,
      sessions: sessions ? Number(sessions[1]) : 0,
    };
  });
}

// `workspace setup` output: the checklist, workspaces, places, the no-folder sentence and the last setup= line.
export function parseListing(text) {
  const lines = outputLines(text);
  const open = lines.indexOf(CHECKLIST_OPEN);
  const close = lines.indexOf(CHECKLIST_CLOSE);
  const last = lastLine(text, /^setup=/);
  return {
    checklist: open !== -1 && close > open ? lines.slice(open + 1, close) : [],
    workspaces: parseWorkspaces(text),
    places: parsePlaces(text),
    noFolder: lastLine(text, NO_FOLDER),
    workspaceCount: last === null ? 0 : Number(token(last, 'workspaces')),
    chosen: last !== null && token(last, 'chosen') === 'yes',
  };
}

function targetArgs(place) {
  return place.kind === 'outside' ? ['--outside'] : [`--${place.kind}`, place.match];
}

// rule add in the order the listing prints it: <target> --account <key> <tenants>.
export function ruleArgv(place, key, tenants) {
  return ['rule', 'add'].concat(targetArgs(place), ['--account', key, tenants]);
}

// Runs one write; false, with its failure shown, unless it ends with its saved line (a refused write still exits 0).
async function write(ctx, argv, saved) {
  const result = await ctx.run('workspace', argv);
  const lines = printable(result.stdout);
  if (result.code === 0 && saved.test(lines[lines.length - 1] || '')) return true;
  report(ctx, result);
  return false;
}

function everything(ctx, key, tenants) {
  return write(ctx, ['setup', 'everything', '--account', key].concat(tenants), /^setup=everything$/);
}

function letMeChoose(ctx, key) {
  return write(ctx, ['setup', 'chosen', '--account', key], /^setup=chosen$/);
}

function names(list) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function trackingLine(tracked, total, suffix) {
  const count = tracked === total ? `all ${total}` : `${tracked} of ${total}`;
  return `✓ Tracking ${count} repos and folders${suffix}`;
}

function askedLine(ctx) {
  return `  ${ctx.style.dim('New repos: Beezi asks the first time you work in one.')}`;
}

function notTracked(ctx, places) {
  if (places.length > 0) ctx.print(`  ${ctx.style.dim(`Not tracked: ${places.map((p) => p.name).join(', ')}`)}`);
}

// Whether a list starts with a place ticked: "Don't track" never, a ruled place for its workspaces, else when no earlier list ticked it.
function startsTicked(place, tenant, earlier) {
  if (place.now === NOT_TRACKED) return false;
  if (place.now === NO_RULE) return earlier === 0;
  return place.now.split(',').indexOf(tenant) !== -1;
}

function sameTargets(now, target) {
  return now.split(',').sort().join(',') === target.split(',').sort().join(',');
}

// One rule write per place whose routing changes (one workspace: only the unticked, with none), then setup chosen; false at the first failure.
async function writeRules(ctx, key, places, targets, single) {
  for (let i = 0; i < places.length; i += 1) {
    const keep = single ? targets[i] !== NOT_TRACKED : sameTargets(places[i].now, targets[i]);
    if (!keep && !(await write(ctx, ruleArgv(places[i], key, targets[i]), /^rule=\d+$/))) return false;
  }
  return letMeChoose(ctx, key);
}

const NOTHING_WRITTEN = Object.freeze({ tracked: false, trailer: [] });

function tickOptions(places) {
  const digits = String(Math.max(...places.map((p) => p.sessions))).length;
  return places.map((p) => ({ label: p.name, description: `${String(p.sessions).padStart(digits)} session${p.sessions === 1 ? '' : 's'}` }));
}

// Everything: existing rules stay, so a "Don't track" place is still left out.
async function trackEverything(ctx, key, listing, chosen) {
  const tracked = listing.places.filter((p) => p.now !== NOT_TRACKED);
  if (!(await everything(ctx, key, listing.workspaceCount > 1 ? [chosen.map((w) => w.tenant).join(',')] : []))) return NOTHING_WRITTEN;
  const suffix = listing.workspaceCount > 1 ? ` in ${ctx.style.bold(names(chosen.map((w) => w.name)))}` : '';
  ctx.print(trackingLine(tracked.length, listing.places.length, suffix));
  notTracked(ctx, listing.places.filter((p) => p.now === NOT_TRACKED));
  return { tracked: tracked.length > 0, trailer: [] };
}

// A "Don't track" place is not a row: it stays untracked and counts in M and in Not tracked.
async function chooseOne(ctx, key, listing) {
  const offered = listing.places.filter((p) => p.now !== NOT_TRACKED);
  const tenant = listing.workspaces[0].tenant;
  const picked = offered.map((p, i) => i);
  const ticked = offered.length === 0 ? [] : await ctx.ask.chooseMany('Which repos and folders should Beezi track?', tickOptions(offered), { picked });
  if (ticked === null) return null;
  if (!(await writeRules(ctx, key, offered, offered.map((p, i) => (ticked.indexOf(i) === -1 ? NOT_TRACKED : tenant)), true))) return NOTHING_WRITTEN;
  const tracked = offered.filter((p, i) => ticked.indexOf(i) !== -1);
  if (tracked.length === 0) {
    ctx.print('– Nothing is tracked yet. /beezi-dev-settings adds repos and folders.');
    return { tracked: false, trailer: [] };
  }
  ctx.print(trackingLine(tracked.length, listing.places.length, ''));
  notTracked(ctx, listing.places.filter((p) => tracked.indexOf(p) === -1));
  return { tracked: true, trailer: [`  ${ctx.style.dim('New repos are tracked. Leave one out in /beezi-dev-settings.')}`] };
}

// One tick list per workspace; nothing is written until the last list is answered.
async function chooseSeveral(ctx, key, listing) {
  const places = listing.places;
  const ticks = places.map(() => []);
  for (const w of listing.workspaces) {
    const picked = places.map((p, i) => i).filter((i) => startsTicked(places[i], w.tenant, ticks[i].length));
    const ticked = await ctx.ask.chooseMany(`Which repos and folders go to ${w.name}?`, tickOptions(places), { picked });
    if (ticked === null) return null;
    ticked.forEach((i) => { ticks[i].push(w.tenant); });
    ctx.print(ticked.length > 0 ? `✓ ${ctx.style.bold(w.name)} gets ${ticked.length} of ${places.length} repos and folders` : `– Nothing goes to ${w.name}.`);
  }
  if (!(await writeRules(ctx, key, places, ticks.map((t) => (t.length > 0 ? t.join(',') : NOT_TRACKED)), false))) return NOTHING_WRITTEN;
  notTracked(ctx, places.filter((p, i) => ticks[i].length === 0));
  return { tracked: ticks.some((t) => t.length > 0), trailer: [askedLine(ctx)] };
}

// "Everything to <name>" per workspace, then one for all of them.
function everythingOptions(workspaces) {
  const all = workspaces.length === 2 ? 'Everything to both' : `Everything to all ${workspaces.length}`;
  return workspaces.map((w) => ({ label: `Everything to ${w.name}` })).concat([{ label: all }]);
}

// The workspaces an Everything row picked.
function everythingTargets(workspaces, choice) {
  return choice < workspaces.length ? [workspaces[choice]] : workspaces;
}

// The checklist, restyled, and the no-folder sentence: shown above the question and folded away with it.
function checklistLead(ctx, listing) {
  return listing.checklist.map((line) => offerLine(ctx.style, line)).concat(listing.noFolder === null ? [] : [listing.noFolder]);
}

// Several workspaces and no past sessions: where new repos go, or ask for each.
async function askNoPlaces(ctx, key, listing) {
  const options = everythingOptions(listing.workspaces).concat([{ label: 'Ask me for each repo' }]);
  const choice = await ctx.ask.choose("Where should this machine's analytics go?", options, { lead: checklistLead(ctx, listing) });
  if (choice === null) return;
  if (choice === options.length - 1) {
    if (await letMeChoose(ctx, key)) ctx.print(askedLine(ctx));
    return;
  }
  if (await everything(ctx, key, [everythingTargets(listing.workspaces, choice).map((w) => w.tenant).join(',')])) ctx.print(TRACKING_ALL);
}

async function askPlaces(ctx, key, listing) {
  const several = listing.workspaceCount > 1;
  const options = several
    ? everythingOptions(listing.workspaces).concat([{ label: 'Let me choose', description: 'tick repos for each workspace' }])
    : [
      { label: 'Everything', description: `all ${listing.places.length}, and new ones as you open them` },
      { label: 'Let me choose', description: 'tick the repos and folders' },
    ];
  const question = several ? 'Where should they go?' : 'What should it track?';
  const choice = await ctx.ask.choose(question, options, { lead: checklistLead(ctx, listing) });
  if (choice === null) return null;
  if (choice < options.length - 1) return trackEverything(ctx, key, listing, everythingTargets(listing.workspaces, choice));
  return several ? chooseSeveral(ctx, key, listing) : chooseOne(ctx, key, listing);
}

// The tracking question from `workspace setup`; { tracked, trailer }, with failed when the listing failed, or null.
export async function askTracking(ctx, key) {
  const result = await ctx.run('workspace', ['setup', '--account', key]);
  if (result.code !== 0) {
    report(ctx, result);
    return { tracked: false, trailer: [], failed: true };
  }
  const listing = parseListing(result.stdout);
  if (await settled(ctx, key, listing)) return null;
  if (listing.places.length > 0) return askPlaces(ctx, key, listing);
  await askNoPlaces(ctx, key, listing);
  return null;
}

// No question for an unknown workspace list, a choice already made, or one workspace with no past sessions (records Everything); else false.
export async function settled(ctx, key, listing) {
  if (listing.workspaceCount === 0) return true;
  if (listing.chosen) {
    ctx.print('✓ Tracking is already set up (/beezi-dev-settings)');
    return true;
  }
  if (listing.places.length > 0 || listing.workspaceCount > 1) return false;
  if (await everything(ctx, key, [])) ctx.print(TRACKING_ALL);
  return true;
}
