// Owns PATH lookup of helper binaries: absolute PATH entries only, so a relative entry never resolves against the cwd.
import fs from 'fs';
import path from 'path';

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Absolute path of `name` (itself, when already absolute) as the first executable file in an absolute PATH entry, or null.
export function resolveExecutable(name, env = process.env) {
  if (path.isAbsolute(name)) return isExecutableFile(name) ? name : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (isExecutableFile(file)) return file;
  }
  return null;
}
