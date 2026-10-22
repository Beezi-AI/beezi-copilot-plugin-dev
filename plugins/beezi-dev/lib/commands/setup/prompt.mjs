// The terminal setup's questions: arrow-key menus on a raw-capable terminal, typed answers anywhere else.
import fs from 'fs';
import readline from 'readline';
import stream from 'stream';
import tty from 'tty';
import { createStyle } from '../../ux/setup/style.mjs';
import { keyChoose, keyChooseMany, keyConfirm } from './prompt-keys.mjs';

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

// Numbered option rows with the default mark and the descriptions dimmed.
function styledOptions(options, defaultIndex, style) {
  return options.map((option, i) => {
    const mark = i === defaultIndex ? style.dim(' (default)') : '';
    const description = option.description ? style.dim(` — ${option.description}`) : '';
    return `  ${i + 1}) ${option.label}${mark}${description}`;
  });
}

export function renderOptions(options, defaultIndex) {
  return styledOptions(options, defaultIndex, createStyle({ enabled: false }));
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

// The shared state: streams, style, whether keys are still read raw, the open key question's dismiss hook and the line reader.
function promptState(io) {
  const p = {
    input: io.input,
    output: io.output,
    style: io.style || createStyle({ enabled: false }),
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

function showMenu(p, question, options, defaultIndex) {
  p.output.write(`\n${p.style.bold(question)}\n${styledOptions(options, defaultIndex, p.style).join('\n')}\n`);
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

// True when count menu rows fit above the terminal's last row, or its height is unknown.
function fitsScreen(p, count) {
  return !p.output.rows || count < p.output.rows;
}

async function choose(p, question, options, opts) {
  if (p.closed) return null;
  const defaultIndex = opts && typeof opts.defaultIndex === 'number' ? opts.defaultIndex : -1;
  if (fitsScreen(p, options.length + 2) && rawOn(p)) return keyChoose(p, question, options, defaultIndex);
  showMenu(p, question, options, defaultIndex);
  const range = `1-${options.length}`;
  const query = defaultIndex === -1 ? `Choose ${range}, or press Enter to skip:` : `Choose ${range} [${defaultIndex + 1}]:`;
  for (;;) {
    const answer = await ask(p, `${p.style.boldCyan(query)} `);
    if (answer === null) return null;
    if (answer === '') return defaultIndex === -1 ? null : defaultIndex;
    const picked = parseNumbers(answer, options.length);
    if (picked !== null && picked.length === 1) return picked[0];
    p.output.write(`${p.style.yellow(`Enter one number from 1 to ${options.length}.`)}\n`);
  }
}

// The exclusive index in picked when it sits beside another pick, else -1.
export function mixedExclusive(picked, exclusive) {
  const found = picked.find((i) => exclusive.indexOf(i) !== -1);
  return picked.length > 1 && found !== undefined ? found : -1;
}

async function chooseMany(p, question, options, opts) {
  if (p.closed) return null;
  if (options.length === 0) return [];
  const exclusive = opts && opts.exclusive ? opts.exclusive : [];
  if (fitsScreen(p, options.length + 2) && rawOn(p)) return keyChooseMany(p, question, options, exclusive);
  showMenu(p, question, options, -1);
  for (;;) {
    const answer = await ask(p, `${p.style.boldCyan('Choose one or more (for example 1,2), or press Enter to skip:')} `);
    if (answer === null) return null;
    const picked = parseNumbers(answer, options.length);
    if (picked !== null) {
      const mixed = mixedExclusive(picked, exclusive);
      if (mixed === -1) return picked;
      p.output.write(`${p.style.yellow(`"${options[mixed].label}" can't be combined with other choices.`)}\n`);
    } else {
      p.output.write(`${p.style.yellow(`Enter numbers from 1 to ${options.length}, separated by commas.`)}\n`);
    }
  }
}

async function confirm(p, question, defaultYes) {
  if (p.closed) return null;
  if (rawOn(p)) return keyConfirm(p, question, defaultYes);
  const query = `\n${p.style.bold(question)} ${p.style.boldCyan(defaultYes ? '[Y/n]' : '[y/N]')} `;
  for (;;) {
    const answer = await ask(p, query);
    if (answer === null) return null;
    if (answer === '') return defaultYes;
    if (/^(y|yes)$/i.test(answer)) return true;
    if (/^(n|no)$/i.test(answer)) return false;
    p.output.write(`${p.style.yellow('Answer y or n.')}\n`);
  }
}

// Reads one line in both modes; it arrives trimmed, and an empty one is null.
async function text(p, question) {
  const answer = await ask(p, `\n${p.style.bold(question)} `);
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
