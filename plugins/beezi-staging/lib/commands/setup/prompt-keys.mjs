// The arrow-key questions behind createPrompt: a menu, a tick list and a [Y/n], drawn in place while the terminal is raw.
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HINT_CHOOSE = '↑↓ to move, Enter to choose';
const HINT_TICK = '↑↓ to move, Space to tick, Enter to confirm';
export const QUESTION_INDENT = '  ';
export const OPTION_INDENT = '    ';
const WINDOW_ROWS = 10;
const LABEL_GAP = 3;

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

// The first option row shown, moved only as far as keeps the pointer inside the window.
export function windowTop(top, cursor) {
  if (cursor < top) return cursor;
  if (cursor >= top + WINDOW_ROWS) return cursor - WINDOW_ROWS + 1;
  return top;
}

// The label column: the widest label plus the gap, narrowed for the descriptions but never below half the room.
function labelColumn(options, room) {
  const labels = Math.max(...options.map((option) => width(option.label)));
  const descriptions = Math.max(...options.map((option) => (option.description ? width(option.description) : 0)));
  return Math.min(labels + LABEL_GAP, Math.max(room - descriptions, Math.floor(room / 2)));
}

// An option's label padded to the column and its description cut to what is left of the room.
function optionCells(option, column, room) {
  if (!option.description) return { label: fit(option.label, room), description: '' };
  const label = fit(option.label, column - LABEL_GAP);
  return { label: label + ' '.repeat(column - width(label)), description: fit(option.description, room - column) };
}

// Moves the cursor up over rows lines and clears everything below it.
function erase(rows) {
  return `\x1b[${rows}A\x1b[0J`;
}

function isSubmit(key) {
  return key.name === 'return' || key.name === 'enter';
}

// Pointer after ↑/↓ or k/j, wrapping around; unchanged for any other key.
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

// The lines shown above a question, each through p.format, after one blank row.
export function leadRows(p, lead) {
  const rows = [];
  lead.forEach((line) => { rows.push(...p.format(line).split('\n')); });
  return rows.length ? [''].concat(rows) : rows;
}

export function questionRow(p, question) {
  return `${QUESTION_INDENT}${p.style.accent('◆')} ${p.style.bold(question)}`;
}

// Shows rows() with the cursor hidden, redraws it after each key onKey reports as a change, and erases it all on finish.
// p is the prompt state; p.cancelKeys dismisses the question while it is open.
function keyQuestion(p, rows, onKey) {
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
    function finish(value) {
      p.output.write(erase(drawn));
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

// The lead, the question, a window of option rows and the hint, each option row cut to one terminal row.
export function menuRows(p, menu, cursor, picked, top) {
  const style = p.style;
  const room = (p.output.columns || 80) - 1;
  const optionRoom = room - OPTION_INDENT.length - (picked === null ? 2 : 4);
  const column = labelColumn(menu.options, optionRoom);
  const rows = leadRows(p, menu.lead).concat('', questionRow(p, fit(menu.question, room - QUESTION_INDENT.length - 2)));
  menu.options.slice(top, top + WINDOW_ROWS).forEach((option, k) => {
    const i = top + k;
    const ticked = picked !== null && picked.indexOf(i) !== -1;
    const cells = optionCells(option, column, optionRoom);
    let tone = style.dim;
    if (i === cursor) tone = style.bold;
    else if (ticked) tone = (text) => text;
    const pointer = i === cursor ? style.accent('❯') : ' ';
    let box = '';
    if (picked !== null) box = `${ticked ? style.accent('◉') : style.dim('◯')} `;
    rows.push(`${OPTION_INDENT}${pointer} ${box}${tone(cells.label)}${cells.description ? style.dim(cells.description) : ''}`);
  });
  rows.push(`${OPTION_INDENT}${style.dim(fit(picked === null ? HINT_CHOOSE : HINT_TICK, room - OPTION_INDENT.length))}`);
  return rows;
}

// Esc does nothing: the question cannot be dismissed.
export function keyChoose(p, menu) {
  let cursor = 0;
  let top = 0;
  let run = '';
  return keyQuestion(p, () => menuRows(p, menu, cursor, null, top), (str, key, finish) => {
    if (isSubmit(key)) {
      finish(cursor);
      return false;
    }
    run = isDigit(str) ? nextRun(run, str, menu.options.length) : '';
    let next = step(str, key, cursor, menu.options.length);
    if (isDigit(str)) next = run === '' ? cursor : Number(run) - 1;
    if (next === cursor) return false;
    cursor = next;
    top = windowTop(top, cursor);
    return true;
  });
}

// Unticks a picked row, else ticks it.
export function togglePick(picked, i) {
  return picked.indexOf(i) !== -1 ? picked.filter((j) => j !== i) : picked.concat([i]);
}

export function keyChooseMany(p, menu, initial) {
  let cursor = 0;
  let top = 0;
  let run = '';
  let runStart = [];
  let picked = initial;
  return keyQuestion(p, () => menuRows(p, menu, cursor, picked, top), (str, key, finish) => {
    if (isSubmit(key)) {
      finish(picked.slice().sort((a, b) => a - b));
      return false;
    }
    if (isDigit(str)) {
      run = nextRun(run, str, menu.options.length);
      if (run === '') return false;
      // A run's first digit snapshots the ticks; a longer run re-applies its toggle to that snapshot.
      if (run.length === 1) runStart = picked;
      picked = togglePick(runStart, Number(run) - 1);
      return true;
    }
    run = '';
    if (key.name === 'space') {
      picked = togglePick(picked, cursor);
      return true;
    }
    const next = step(str, key, cursor, menu.options.length);
    if (next === cursor) return false;
    cursor = next;
    top = windowTop(top, cursor);
    return true;
  });
}

export function keyConfirm(p, question, defaultYes) {
  const choices = defaultYes ? '[Y/n]' : '[y/N]';
  let answer = null;
  const rows = () => {
    const room = (p.output.columns || 80) - 1;
    const typed = answer === null ? '' : ` ${p.style.bold(answer ? 'y' : 'n')}`;
    return ['', `${questionRow(p, fit(question, room - QUESTION_INDENT.length - 10))} ${p.style.dim(choices)}${typed}`];
  };
  return keyQuestion(p, rows, (str, key, finish) => {
    if (isSubmit(key)) {
      finish(answer === null ? defaultYes : answer);
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
