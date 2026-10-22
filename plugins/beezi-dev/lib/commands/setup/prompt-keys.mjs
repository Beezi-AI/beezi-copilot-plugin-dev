// The arrow-key questions behind createPrompt: a menu, a multi-select and a [Y/n], drawn in place while the terminal is raw.
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HINT_CHOOSE = '↑/↓ move · Enter select';
const HINT_SKIP = '↑/↓ move · Enter select · Esc skip';
const HINT_MANY = '↑/↓ move · Space select · Enter confirm (nothing selected = skip)';

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
];

// Terminal columns one character takes: 2 for East Asian Wide and Fullwidth, else 1.
function columnsOf(char) {
  const code = char.codePointAt(0);
  return WIDE_RANGES.some((range) => code >= range[0] && code <= range[1]) ? 2 : 1;
}

function width(text) {
  return Array.from(text).reduce((sum, char) => sum + columnsOf(char), 0);
}

// Cuts text to room columns, ending a cut with ….
function fit(text, room) {
  if (width(text) <= room) return text;
  if (room <= 0) return '';
  let kept = '';
  let used = 0;
  for (const char of Array.from(text)) {
    if (used + columnsOf(char) > room - 1) break;
    kept += char;
    used += columnsOf(char);
  }
  return `${kept}…`;
}

// Moves the cursor up over rows lines and clears everything below it.
function erase(rows) {
  return `\x1b[${rows}A\x1b[0J`;
}

function isSubmit(key) {
  return key.name === 'return' || key.name === 'enter';
}

// Highlight after ↑/↓ or k/j, wrapping around; unchanged for any other key.
function step(str, key, cursor, count) {
  if (key.name === 'up' || str === 'k') return (cursor + count - 1) % count;
  if (key.name === 'down' || str === 'j') return (cursor + 1) % count;
  return cursor;
}

// 0-based option for a typed digit 1-9 within range, else -1.
function digitOption(str, count) {
  if (typeof str !== 'string' || !/^[1-9]$/.test(str)) return -1;
  const n = Number(str);
  return n <= count ? n - 1 : -1;
}

function isDigit(str) {
  return typeof str === 'string' && /^[0-9]$/.test(str);
}

// Digit run after typing str: run+str when that is an option number, else str alone, else ''.
function nextRun(run, str, count) {
  const combined = `${run}${str}`;
  if (run !== '' && Number(combined) <= count) return combined;
  return digitOption(str, count) === -1 ? '' : str;
}

// Shows rows() with the cursor hidden, redraws it after each key onKey reports as a change, and resolves via finish.
// p is the prompt state; p.cancelKeys dismisses the question while it is open.
function keyQuestion(p, question, rows, onKey) {
  return new Promise((resolve, reject) => {
    let drawn = 0;
    function draw() {
      const lines = rows();
      p.output.write(`${drawn > 0 ? erase(drawn) : ''}${lines.join('\n')}\n`);
      drawn = lines.length;
    }
    function stop() {
      p.input.removeListener('keypress', onKeypress);
      p.input.setRawMode(false);
      p.cancelKeys = null;
      p.output.write(SHOW_CURSOR);
    }
    function finish(value, answer) {
      p.output.write(`${erase(drawn)}${p.style.green('✓')} ${p.style.bold(question)} ${answer}\n`);
      stop();
      resolve(value);
    }
    // Restores the terminal if this question is still open, then rejects with error.
    function fail(error) {
      if (p.cancelKeys !== null) stop();
      reject(error);
    }
    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        stop();
        if (p.onInterrupt !== null) p.onInterrupt();
        resolve(null);
        return;
      }
      try {
        if (onKey(str, key, finish)) draw();
      } catch (error) {
        fail(error);
      }
    }
    p.cancelKeys = () => {
      stop();
      resolve(null);
    };
    p.output.write(HIDE_CURSOR);
    try {
      draw();
    } catch (error) {
      fail(error);
      return;
    }
    p.input.on('keypress', onKeypress);
  });
}

// The question, one row per option and the hint, each cut to fit one terminal row.
function menuRows(p, question, options, cursor, picked, hint) {
  const style = p.style;
  const room = (p.output.columns || 80) - 1;
  const optionRoom = room - (picked === null ? 2 : 4);
  const rows = [`${style.boldCyan('?')} ${style.bold(fit(question, room - 2))}`];
  options.forEach((option, i) => {
    const active = i === cursor;
    const pointer = active ? style.cyan('❯') : ' ';
    const box = picked === null ? '' : `${picked.indexOf(i) === -1 ? style.dim('◯') : style.green('◉')} `;
    const label = fit(option.label, optionRoom);
    const description = option.description ? fit(` — ${option.description}`, optionRoom - width(label)) : '';
    rows.push(`${pointer} ${box}${active ? style.cyan(label) : label}${description ? style.dim(description) : ''}`);
  });
  rows.push(style.dim(`  ${fit(hint, room - 2)}`));
  return rows;
}

export function keyChoose(p, question, options, defaultIndex) {
  let cursor = defaultIndex === -1 ? 0 : defaultIndex;
  let run = '';
  const hint = defaultIndex === -1 ? HINT_SKIP : HINT_CHOOSE;
  return keyQuestion(p, question, () => menuRows(p, question, options, cursor, null, hint), (str, key, finish) => {
    if (isSubmit(key)) {
      finish(cursor, p.style.cyan(options[cursor].label));
      return false;
    }
    if (key.name === 'escape' && defaultIndex === -1) {
      finish(null, p.style.dim('skipped'));
      return false;
    }
    run = isDigit(str) ? nextRun(run, str, options.length) : '';
    let next = step(str, key, cursor, options.length);
    if (isDigit(str)) next = run === '' ? cursor : Number(run) - 1;
    if (next === cursor) return false;
    cursor = next;
    return true;
  });
}

// New picks after toggling i: a ticked i is removed, an exclusive i stands alone, any other i clears the exclusive ones.
export function togglePick(picked, i, exclusive) {
  if (picked.indexOf(i) !== -1) return picked.filter((j) => j !== i);
  if (exclusive.indexOf(i) !== -1) return [i];
  return picked.filter((j) => exclusive.indexOf(j) === -1).concat([i]);
}

export function keyChooseMany(p, question, options, exclusive) {
  let cursor = 0;
  let run = '';
  let runStart = [];
  let picked = [];
  return keyQuestion(p, question, () => menuRows(p, question, options, cursor, picked, HINT_MANY), (str, key, finish) => {
    if (isSubmit(key)) {
      const chosen = picked.slice().sort((a, b) => a - b);
      const labels = chosen.map((i) => options[i].label).join(', ');
      finish(chosen, chosen.length > 0 ? p.style.cyan(labels) : p.style.dim('skipped'));
      return false;
    }
    if (key.name === 'escape') {
      finish([], p.style.dim('skipped'));
      return false;
    }
    if (isDigit(str)) {
      run = nextRun(run, str, options.length);
      if (run === '') return false;
      // A run's first digit snapshots the ticks; a longer run re-applies its toggle to that snapshot.
      if (run.length === 1) runStart = picked;
      picked = togglePick(runStart, Number(run) - 1, exclusive);
      return true;
    }
    run = '';
    if (key.name === 'space') {
      picked = togglePick(picked, cursor, exclusive);
      return true;
    }
    const next = step(str, key, cursor, options.length);
    if (next === cursor) return false;
    cursor = next;
    return true;
  });
}

export function keyConfirm(p, question, defaultYes) {
  const choices = defaultYes ? '[Y/n]' : '[y/N]';
  let answer = null;
  const row = () => {
    const room = (p.output.columns || 80) - 1;
    const typed = answer === null ? '' : ` ${p.style.cyan(answer ? 'y' : 'n')}`;
    return [`${p.style.boldCyan('?')} ${p.style.bold(fit(question, room - 10))} ${p.style.boldCyan(choices)}${typed}`];
  };
  return keyQuestion(p, question, row, (str, key, finish) => {
    if (isSubmit(key)) {
      const value = answer === null ? defaultYes : answer;
      finish(value, p.style.cyan(value ? 'Yes' : 'No'));
      return false;
    }
    let next = answer;
    if (str === 'y' || str === 'Y') next = true;
    if (str === 'n' || str === 'N') next = false;
    if (next === answer) return false;
    answer = next;
    return true;
  });
}
