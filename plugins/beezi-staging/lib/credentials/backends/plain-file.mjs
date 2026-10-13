// Owns the plaintext 0600 file backend, the always-available tail of every platform chain.
import fs from 'fs';
import { readJson, writeJsonSecure } from '../../platform/fs-store.mjs';
import { BACKENDS, withGet } from './process.mjs';

// ── file store: the always-available fallback, and where the Windows DPAPI
//    ciphertext is kept (0600; on Windows the user profile ACL also applies). ──

export function fileDelete(file) {
  try { fs.unlinkSync(file); } catch { /* already absent */ }
}

export function fileBackend() {
  return withGet({
    name: BACKENDS.FILE,
    kind: 'file',
    available: () => true,
    read(entry) {
      const obj = readJson(entry.file);
      return { token: obj && typeof obj.token === 'string' ? obj.token : null, timedOut: false };
    },
    set(entry, secret) { writeJsonSecure(entry.file, { token: secret }); return 'a restricted local file'; },
    delete(entry) { fileDelete(entry.file); },
  });
}
