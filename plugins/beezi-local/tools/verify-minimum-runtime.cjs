// The runtime gate: every lib/** and scripts/** module parses, every lib/** module imports, the walk still sees
// at least as many modules as the plugin has, and no Node 13.2-incompatible construct appears outside the allowlist.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
// Floors per folder, so a walk that misses moved or nested modules fails instead of passing on fewer files.
const MIN_MODULES = { lib: 229, scripts: 28 };
// Matched against code with comments and literal bodies blanked; each names the Node 13.2 floor rule it enforces.
const BANNED = [
  ['optional chaining ?.', /\?\.(?!\d)/g],
  ['nullish ?? or ??=', /\?\?/g],
  ['logical assignment ||= or &&=', /\|\|=|&&=/g],
  ['.replaceAll()', /\.replaceAll\b/g],
  ['Object.hasOwn', /\bObject\.hasOwn\b/g],
  ['fs.rmSync', /\brmSync\b/g],
  ['new AbortController()', /\bnew\s+AbortController\b/g],
  ['globalThis.fetch', /\bglobalThis\.fetch\b/g],
  ['structuredClone', /\bstructuredClone\b/g],
  ['.at()', /\.at\s*\(/g],
  ['findLast or findLastIndex', /\bfindLast(?:Index)?\b/g],
  ['AbortSignal static', /\bAbortSignal\s*\.\s*[A-Za-z_$]/g],
  ['randomUUID', /\brandomUUID\b/g],
];
// Guarded uses: each feature-detects or falls back, so Node 13.2 never reaches the banned call. `hits` is exact.
const ALLOWED = [
  { file: 'lib/platform/compat-fetch.mjs', rule: 'globalThis.fetch', hits: 2, reason: 'used only when it is a function; else the http shim' },
  { file: 'lib/platform/fs-store.mjs', rule: 'fs.rmSync', hits: 2, reason: 'removePath feature-detects it and falls back to unlink/rmdir' },
  { file: 'lib/platform/sqlite.mjs', rule: 'node: specifier', hits: 1, reason: 'guarded dynamic node:sqlite import, silent fallback' },
];
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const BLOCK_OWNERS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);
const IDENT = /[A-Za-z0-9_$]/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((all, entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return all.concat(walk(full));
    return entry.name.endsWith('.mjs') ? all.concat(full) : all;
  }, []);
}

// Regex or division: a `/` after an operand divides, anywhere else it opens a regex literal.
function regexAllowed(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) !== -1 || REGEX_AFTER_WORD.has(prev);
}

// Index of a regex literal's closing slash, or -1 when the line ends first (then it was a division).
function regexEnd(source, start) {
  let inClass = false;
  for (let k = start + 1; k < source.length && source[k] !== '\n'; k++) {
    if (source[k] === '\\') k++;
    else if (source[k] === '[') inClass = true;
    else if (source[k] === ']') inClass = false;
    else if (source[k] === '/' && !inClass) return k;
  }
  return -1;
}

// Code with comment, string, template-text and regex bodies turned to spaces (newlines and offsets kept), plus
// every complete string literal by its opening offset, so rules match code only and specifiers stay readable.
function blankLiterals(source) {
  const out = source.split('');
  const strings = new Map();
  const templateDepths = [];
  let depth = 0;
  let prev = '';
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const quotedEnd = (start) => {
    let k = start + 1;
    while (k < source.length && source[k] !== source[start] && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
    return Math.min(k, source.length);
  };
  // Template text from `start` (a backtick or the `}` closing a substitution) up to the next backtick or `${`.
  const template = (start) => {
    let k = start + 1;
    while (k < source.length && source[k] !== '`' && !(source[k] === '$' && source[k + 1] === '{')) k += source[k] === '\\' ? 2 : 1;
    blank(start + 1, k);
    if (source[k] === '`') {
      if (source[start] === '`') strings.set(start, source.slice(start + 1, k));
      prev = 'literal';
      return k + 1;
    }
    templateDepths.push(depth);
    depth += 1;
    prev = '{';
    return k + 2;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const line = source[i + 1] === '/';
      const close = line ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + (line ? 0 : 2);
      blank(i, end);
      i = end;
    } else if (c === '\'' || c === '"') {
      const end = quotedEnd(i);
      blank(i + 1, end);
      strings.set(i, source.slice(i + 1, end));
      prev = 'literal';
      i = end + 1;
    } else if (c === '`') {
      i = template(i);
    } else if (c === '}' && templateDepths[templateDepths.length - 1] === depth - 1) {
      templateDepths.pop();
      depth -= 1;
      i = template(i);
    } else if (c === '/' && regexAllowed(prev)) {
      const end = regexEnd(source, i);
      if (end === -1) {
        prev = c;
        i += 1;
      } else {
        blank(i + 1, end);
        prev = 'literal';
        i = end + 1;
        while (i < source.length && IDENT.test(source[i])) i++;
      }
    } else if (IDENT.test(c)) {
      let end = i;
      while (end < source.length && IDENT.test(source[end])) end++;
      prev = source.slice(i, end);
      i = end;
    } else {
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  return { code: out.join(''), strings: strings };
}

// Offsets of `await` outside every function body (top-level await), tracking brace-less arrow bodies too.
function topLevelAwaits(code) {
  const hits = [];
  const scopes = [];
  const tokens = /[A-Za-z0-9_$]+|=>|\S/g;
  let prev = null;
  let closedOwner = null;
  const closeArrows = () => { while (scopes.length > 0 && scopes[scopes.length - 1].open === '=>') scopes.pop(); };
  for (let match = tokens.exec(code); match !== null; match = tokens.exec(code)) {
    const token = match[0];
    if (prev === '=>' && token !== '{') scopes.push({ open: '=>', fn: true });
    if (token === '(' || token === '[') scopes.push({ open: token, fn: false, owner: prev });
    else if (token === '{') scopes.push({ open: token, fn: prev === '=>' || (prev === ')' && !BLOCK_OWNERS.has(closedOwner)) });
    else if (token === ')' || token === ']' || token === '}') {
      closeArrows();
      const scope = scopes.pop();
      closedOwner = scope == null ? null : scope.owner;
    } else if (token === ',' || token === ';') closeArrows();
    else if (token === 'await' && prev !== '.' && !/^\s*:/.test(code.slice(tokens.lastIndex, tokens.lastIndex + 20))
      && !scopes.some((scope) => scope.fn)) hits.push(match.index);
    prev = token;
  }
  return hits;
}

function specifierRule(specifier) {
  if (specifier.startsWith('node:')) return 'node: specifier';
  if (specifier.startsWith('#')) return '# specifier';
  if (/^\.\.?(\/|$)/.test(specifier) && !/\.(mjs|cjs|js)$/.test(specifier)) return 'extensionless or directory import';
  return null;
}

// Every banned construct in one source file, as { rule, line }.
function scanSource(source) {
  const { code, strings } = blankLiterals(source);
  const hits = [];
  BANNED.forEach(([rule, pattern]) => {
    for (const match of code.matchAll(pattern)) hits.push({ rule: rule, index: match.index });
  });
  for (const match of code.matchAll(/(?<![\w$.])(?:from\s*|import\s*(?:\(\s*)?)['"`]/g)) {
    const quote = match.index + match[0].length - 1;
    const rule = strings.has(quote) ? specifierRule(strings.get(quote)) : null;
    if (rule) hits.push({ rule: rule, index: quote });
  }
  strings.forEach((value, index) => { if (value === 'base64url') hits.push({ rule: '\'base64url\' literal', index: index }); });
  topLevelAwaits(code).forEach((index) => hits.push({ rule: 'top-level await', index: index }));
  return hits.map((hit) => ({ rule: hit.rule, line: source.slice(0, hit.index).split('\n').length }));
}

function bannedFailures(files) {
  const failures = [];
  const allowedHits = new Map(ALLOWED.map((entry) => [entry.file + ' ' + entry.rule, 0]));
  files.forEach((file) => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    scanSource(fs.readFileSync(file, 'utf8')).forEach(({ rule, line }) => {
      const key = rel + ' ' + rule;
      if (allowedHits.has(key)) allowedHits.set(key, allowedHits.get(key) + 1);
      else failures.push('banned ' + rule + ': ' + rel + ':' + line);
    });
  });
  ALLOWED.forEach((entry) => {
    const found = allowedHits.get(entry.file + ' ' + entry.rule);
    if (found !== entry.hits) failures.push('allowlist ' + entry.file + ' ' + entry.rule + ': expected ' + entry.hits + ' guarded use(s), found ' + found);
  });
  return failures;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-copilot-runtime-'));
process.env.BEEZI_COPILOT_HOME = home;
process.env.COPILOT_HOME = path.join(home, 'copilot');
const firstLine = (text) => String(text).trim().split('\n')[0];
const byDir = {};
const failures = [];
Object.keys(MIN_MODULES).forEach((dir) => {
  byDir[dir] = walk(path.join(root, dir)).sort();
  if (byDir[dir].length < MIN_MODULES[dir]) failures.push('module count ' + dir + '/: found ' + byDir[dir].length + ', expected at least ' + MIN_MODULES[dir]);
});
const files = byDir.lib.concat(byDir.scripts);
files.forEach((file) => {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) failures.push('syntax ' + path.relative(root, file) + ': ' + firstLine(checked.stderr));
});
bannedFailures(files).forEach((line) => failures.push(line));
Promise.all(byDir.lib.map((file) => import(pathToFileURL(file).href).then(() => null,
  (error) => 'import ' + path.relative(root, file) + ': ' + firstLine(error && error.message ? error.message : error))))
  .then((results) => {
    results.forEach((result) => { if (result) failures.push(result); });
    failures.forEach((line) => console.error(line));
    console.log(process.version + ': parsed ' + files.length + ' runtime files, imported ' + byDir.lib.length
      + ' library modules, ' + failures.length + ' failure(s)');
    process.exitCode = failures.length ? 1 : 0;
  });
