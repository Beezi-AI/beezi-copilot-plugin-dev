// Owns atomic JSON writes inside one account's directory that can never recreate a removed account.
import fs from 'fs';
import path from 'path';
import { accountDir } from '../config/paths.mjs';
import { renameSyncRetry } from '../platform/fs-store.mjs';

// Writes JSON inside accounts/<key>/ without ever creating that directory or any ancestor, so a writer
// racing a logout cannot bring a deleted account back. Returns false (never throws) when the account
// directory is gone, the target lies outside it, or the write fails.
export function writeAccountJson(key, filePath, value) {
  try {
    const root = path.resolve(accountDir(key));
    const target = path.resolve(filePath);
    if (target.indexOf(root + path.sep) !== 0) return false;
    // Sub-directories below the account dir, one level at a time and never recursive: a missing account dir is ENOENT here.
    let dir = root;
    for (const part of path.relative(root, path.dirname(target)).split(path.sep)) {
      if (part === '') continue;
      dir = path.join(dir, part);
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') return false;
      }
    }
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* no-op on Windows */ }
      renameSyncRetry(tmp, target);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      return false;
    }
  } catch {
    return false;
  }
}
