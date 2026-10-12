// Owns the Windows DPAPI backend: user-bound ciphertext in a 0600 file; reads a plaintext file older builds wrote here.
import { POWERSHELL } from '../../platform/windows-paths.mjs';
import { readJson, writeJsonSecure } from '../../platform/fs-store.mjs';
import { BACKENDS, powershell, readResult, runRead, withGet } from './process.mjs';
import { fileDelete } from './plain-file.mjs';

const DPAPI_ENC = "$in=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.Security;"
  + "$b=[Text.Encoding]::UTF8.GetBytes($in);"
  + "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
  + '[Convert]::ToBase64String($e)';
const DPAPI_DEC = "$in=[Console]::In.ReadToEnd().Trim();Add-Type -AssemblyName System.Security;"
  + "$b=[Convert]::FromBase64String($in);"
  + "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
  + '[Text.Encoding]::UTF8.GetString($d)';

export function dpapiFileBackend(run) {
  return withGet({
    name: BACKENDS.DPAPI_FILE,
    kind: 'file',
    available: () => true, // PowerShell ships with Windows; set refuses when DPAPI fails
    read(entry, options) {
      const obj = readJson(entry.file);
      if (!obj) return { token: null, timedOut: false };
      if (typeof obj.enc === 'string') {
        return readResult(runRead(
          run, POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_DEC], obj.enc, options,
        ));
      }
      // plaintext written by an older build when DPAPI was down
      return { token: typeof obj.token === 'string' ? obj.token : null, timedOut: false };
    },
    // DPAPI down (e.g. Constrained Language Mode) refuses, so the chain's plaintext tail stores it and is named as such.
    set(entry, secret) {
      const r = powershell(run, DPAPI_ENC, secret);
      if (!r.ok || !r.stdout.trim()) return false;
      writeJsonSecure(entry.file, { enc: r.stdout.trim() });
      return 'Windows DPAPI (encrypted at rest)';
    },
    delete(entry) { fileDelete(entry.file); },
  });
}
