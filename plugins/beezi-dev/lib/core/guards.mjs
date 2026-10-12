// Owns the shape guards for untrusted JSON: plain objects, non-empty strings, finite numbers and id lists. Pure.

export function isPlain(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// The plain object itself, else an empty one.
export function objectOr(value) {
  return isPlain(value) ? value : {};
}

// The string itself when it is non-empty, else null.
export function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// Whether the value is a string with something besides whitespace.
export function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The number itself when it is finite, else null.
export function finiteNumber(value) {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

// The non-empty string entries of an array, else null for a non-array.
export function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}
