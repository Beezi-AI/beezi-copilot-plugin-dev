// Owns the billed-model naming rules shared by the CLI and VS Code readers: the "auto" router never bills by name.

// True for the router placeholder "auto" (any case, padded).
export function isAutoName(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === 'auto';
}

// A model name, or null for an empty value and for the router placeholder "auto", which never bills under its own name.
export function modelName(v) {
  const s = typeof v === 'string' && v !== '' ? v : null;
  return s != null && isAutoName(s) ? null : s;
}
