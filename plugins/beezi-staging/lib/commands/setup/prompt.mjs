// The terminal setup's questions: arrow-key menus on a raw-capable terminal, typed answers anywhere else.
import fs from 'fs';
import readline from 'readline';
import stream from 'stream';
import tty from 'tty';
import { createStyle } from '../../ux/setup/style.mjs';
import { OPTION_INDENT, QUESTION_INDENT, keyChoose, keyChooseMany, keyConfirm, leadRows, menuRows, questionRow } from './prompt-keys.mjs';

function openDevTty() {
  return new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
}

// stdin when it is a terminal, else /dev/tty off Windows, else null.
export function openTerminal(deps) {
  const d = deps || {};
  const stdin = d.stdin || process.stdin;
  const platform = d.platform || process.platform;
  const openTty = d.openTty || openDevTty;
  if (stdin.isTTY) return stdin;
  if (platform === 'win32') return null;
  try {
    return openTty();
  } catch (error) {
    return null;
  }
}

// "1, 3" → [0, 2]; null when any part is not an option number.
export function parseNumbers(answer, count) {
  const picked = [];
  const parts = answer.split(',').map((part) => part.trim()).filter((part) => part !== '');
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 1 || n > count) return null;
    if (picked.indexOf(n - 1) === -1) picked.push(n - 1);
  }
  return picked;
}

// Feeds the line reader only the chunks that arrive while no key question is open.
function gateLines(input, keyOpen) {
  const lines = new stream.PassThrough();
  const onData = (chunk) => {
    if (!keyOpen()) lines.write(chunk);
  };
  input.prependListener('data', onData);
  input.on('end', () => lines.end());
  input.resume();
  return { lines, detach: () => input.removeListener('data', onData) };
}

function settle(p, value) {
  const resolve = p.waiting;
  p.waiting = null;
  resolve(value);
}

// The shared state: streams, style, the lead-line format, whether keys are still read raw, the open key question's dismiss hook and the line reader.
function promptState(io) {
  const p = {
    input: io.input,
    output: io.output,
    style: io.style || createStyle({ enabled: false }),
    format: io.format || ((line) => line),
    onInterrupt: io.onInterrupt || null,
    keys: Boolean(io.interactive),
    cancelKeys: null,
    gate: null,
    rl: null,
    waiting: null,
    closed: false,
  };
  p.gate = p.keys ? gateLines(p.input, () => p.cancelKeys !== null) : null;
  p.rl = readline.createInterface({ input: p.gate === null ? p.input : p.gate.lines, terminal: false });
  if (p.keys) readline.emitKeypressEvents(p.input);
  p.rl.on('line', (line) => {
    if (p.waiting !== null) settle(p, line.trim());
  });
  p.rl.on('close', () => {
    p.closed = true;
    if (p.waiting !== null) settle(p, null);
    if (p.cancelKeys !== null) p.cancelKeys();
  });
  return p;
}

function ask(p, query) {
  if (p.closed) return Promise.resolve(null);
  p.output.write(query);
  return new Promise((resolve) => { p.waiting = resolve; });
}

function showMenu(p, question, options, lead) {
  const rows = options.map((option, i) => {
    const description = option.description ? p.style.dim(`  ${option.description}`) : '';
    return `${OPTION_INDENT}${i + 1}) ${option.label}${description}`;
  });
  p.output.write(`${leadRows(p, lead).concat('', questionRow(p, question), rows).join('\n')}\n`);
}

// Turns raw mode on for one key question; false, and typed prompts from then on, when keys are off or it throws.
function rawOn(p) {
  if (!p.keys) return false;
  try {
    p.input.setRawMode(true);
    return true;
  } catch (error) {
    p.keys = false;
    return false;
  }
}

// True when count rows fit above the terminal's last row, or its height is unknown.
function fitsScreen(p, count) {
  return !p.output.rows || count < p.output.rows;
}

// Answers the 0-based option; Enter picks the first. opts.lead lines show above it and fold away with it.
async function choose(p, question, options, opts) {
  if (p.closed) return null;
  const menu = { question, options, lead: opts && Array.isArray(opts.lead) ? opts.lead : [] };
  if (fitsScreen(p, menuRows(p, menu, 0, null, 0).length) && rawOn(p)) return keyChoose(p, menu);
  showMenu(p, question, options, menu.lead);
  for (;;) {
    const answer = await ask(p, `${QUESTION_INDENT}${p.style.bold(`Choose 1-${options.length} [1]:`)} `);
    if (answer === null) return null;
    if (answer === '') return 0;
    const picked = parseNumbers(answer, options.length);
    if (picked !== null && picked.length === 1) return picked[0];
    p.output.write(`${QUESTION_INDENT}Enter one number from 1 to ${options.length}.\n`);
  }
}

// Answers the ticked rows, sorted on keys; opts.picked rows start ticked, a typed Enter keeps them and a typed none ticks nothing.
async function chooseMany(p, question, options, opts) {
  if (p.closed) return null;
  if (options.length === 0) return [];
  const initial = opts && opts.picked ? opts.picked : [];
  const menu = { question, options, lead: [] };
  if (fitsScreen(p, menuRows(p, menu, 0, initial, 0).length) && rawOn(p)) return keyChooseMany(p, menu, initial);
  showMenu(p, question, options, []);
  const query = initial.length === 0
    ? 'Choose one or more (for example 1,2), or press Enter for none:'
    : `Choose one or more (for example 1,2), or none [${initial.map((i) => i + 1).join(',')}]:`;
  for (;;) {
    const answer = await ask(p, `${QUESTION_INDENT}${p.style.bold(query)} `);
    if (answer === null) return null;
    if (answer === '') return initial;
    if (answer.toLowerCase() === 'none') return [];
    const picked = parseNumbers(answer, options.length);
    if (picked !== null) return picked;
    p.output.write(`${QUESTION_INDENT}Enter numbers from 1 to ${options.length}, separated by commas.\n`);
  }
}

async function confirm(p, question, defaultYes) {
  if (p.closed) return null;
  if (rawOn(p)) return keyConfirm(p, question, defaultYes);
  const query = `\n${questionRow(p, question)} ${p.style.dim(defaultYes ? '[Y/n]' : '[y/N]')} `;
  for (;;) {
    const answer = await ask(p, query);
    if (answer === null) return null;
    if (answer === '') return defaultYes;
    if (/^(y|yes)$/i.test(answer)) return true;
    if (/^(n|no)$/i.test(answer)) return false;
    p.output.write(`${QUESTION_INDENT}Answer y or n.\n`);
  }
}

// Reads one line in both modes; it arrives trimmed, and an empty one is null.
async function text(p, question) {
  const answer = await ask(p, `\n${questionRow(p, question)} `);
  return answer === null || answer === '' ? null : answer;
}

// Dismisses an open key question, closes the line reader and, in key mode, stops reading the terminal.
function close(p) {
  if (p.cancelKeys !== null) p.cancelKeys();
  p.rl.close();
  if (p.gate !== null) {
    p.gate.detach();
    p.input.pause();
  }
}

export function createPrompt(io) {
  const p = promptState(io);
  return {
    choose: (question, options, opts) => choose(p, question, options, opts),
    chooseMany: (question, options, opts) => chooseMany(p, question, options, opts),
    confirm: (question, defaultYes) => confirm(p, question, defaultYes),
    text: (question) => text(p, question),
    close: () => close(p),
  };
}
