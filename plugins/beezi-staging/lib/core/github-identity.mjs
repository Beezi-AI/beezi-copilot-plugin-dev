// The GitHub identity key '<host>/<login>' and the bare host it is built from. Pure.
import { nonEmpty } from './guards.mjs';

export const KEY_MAX = 64;

// '<host>/<login>' lowercased, or null when a part is missing or the key would not fit the wire cap.
export function identityKey(host, login) {
  if (typeof host !== 'string' || typeof login !== 'string') return null;
  const h = host.trim();
  const l = login.trim();
  if (h === '' || l === '') return null;
  const key = `${h}/${l}`.toLowerCase();
  return key.length > KEY_MAX ? null : key;
}

// 'https://github.com/' → 'github.com'; null when nothing is left.
export function normalizeHost(host) {
  if (!nonEmpty(host)) return null;
  const clean = host.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  return clean === '' ? null : clean;
}
