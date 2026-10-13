// Owns the per-platform backend chain and lookup of a backend by its recorded name.
import { BACKENDS, defaultRun } from './process.mjs';
import { fileBackend } from './plain-file.mjs';
import { macBackend } from './macos-keychain.mjs';
import { secretToolBackend } from './secret-tool.mjs';
import { credManBackend } from './windows-credman.mjs';
import { dpapiFileBackend } from './dpapi-file.mjs';

export { BACKENDS };

// ── backends. Each: { name, kind, available(), read(entry) -> { token, timedOut },
//    get(entry) -> string|null,
//    set(entry, secret) -> where|false, delete(entry) }.

// Preferred backend chain for the platform; the plaintext file is always the tail. `deps.freshProbe` makes an OS store
// re-check its reachability instead of trusting a recorded no (writes and deletes).
export function backendsFor(deps = {}) {
  const run = deps.run == null ? defaultRun : deps.run;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const file = fileBackend();
  if (platform === 'darwin') return [macBackend(run), file];
  if (platform === 'linux') {
    return [secretToolBackend(run, deps.env == null ? process.env : deps.env, { fresh: deps.freshProbe === true }), file];
  }
  if (platform === 'win32') return [credManBackend(run), dpapiFileBackend(run), file];
  return [file];
}

// The named backend when this platform's chain offers it, else null.
export function backendByName(name, deps = {}) {
  for (const b of backendsFor(deps)) {
    if (b.name === name) return b;
  }
  return null;
}
