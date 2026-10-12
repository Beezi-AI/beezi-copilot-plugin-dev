// Owns the hook payload timestamp rule: epoch seconds or milliseconds, or a date string, to an ISO instant.

// Epoch values below 1e11 are seconds, above are milliseconds.
export function hookTimeIso(value) {
  let ms = NaN;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string') ms = Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}
