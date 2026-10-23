// Owns the small sentence-building helpers: counted nouns, name lists, ~ paths and display-safe server text. Pure.
import { pathHasPrefix } from './fs-paths.mjs';

const DISPLAY_MAX = 60;
// Control characters, line breaks, quotes, backticks, backslashes and angle brackets become spaces.
const DISPLAY_SPACE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029`"\u201c\u201d\u201e\u201f\\<>]+/g;
// Zero-width, bidi and Unicode tag characters: invisible to a person but read by a model, so dropped.
const DISPLAY_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

// Server-supplied names reach model-visible instructions and CLI output. The result holds no character that can
// close a quoted span or start a line, is at most `max` long (null = uncapped), and is null when nothing is left.
export function displayText(value, max = DISPLAY_MAX) {
  if (typeof value !== 'string') return null;
  let text = value.replace(DISPLAY_INVISIBLE, '').replace(DISPLAY_SPACE, ' ').replace(/\s+/g, ' ').trim();
  if (max != null && text.length > max) text = text.slice(0, max).replace(/[\ud800-\udbff]$/, '').trim();
  return text === '' ? null : text;
}

// "1 session", "2 sessions".
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "A", "A and B", "A, B and C".
export function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// A path under `home` as ~/…; anything else unchanged.
export function displayPath(p, home) {
  return home != null && pathHasPrefix(p, home) ? `~${p.slice(home.length)}` : p;
}
