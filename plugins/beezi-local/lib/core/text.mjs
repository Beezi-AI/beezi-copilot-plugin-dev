// Owns the small sentence-building helpers: counted nouns, name lists and ~ paths. Pure.
import { pathHasPrefix } from './fs-paths.mjs';

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
