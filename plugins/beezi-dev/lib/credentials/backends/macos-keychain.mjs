// Owns the macOS keychain backend, driven through /usr/bin/security.
import { BACKENDS, readResult, runRead, withGet } from './process.mjs';

// Absolute path, never a bare name, so a relative PATH entry cannot resolve it against the cwd.
const SECURITY = '/usr/bin/security';
// security -i reads a command into a 4096-byte buffer and runs any overflow as a second command, so longer lines are refused.
const SECURITY_LINE_MAX = 4000;
// security -i unescapes \\ and \" inside a double-quoted word.
const securityWord = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

export function macBackend(run) {
  return withGet({
    name: BACKENDS.KEYCHAIN,
    kind: 'os',
    available: () => true, // `security` ships with macOS
    read(entry, options) {
      return readResult(runRead(
        run, SECURITY, ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w'],
        undefined, options,
      ));
    },
    set(entry, secret) {
      // The command goes to `security -i` on stdin, so the secret never reaches argv; a line break would start another command.
      if ([entry.service, entry.account, secret].some((w) => /[\r\n\0]/.test(String(w)))) return false;
      const line = `add-generic-password -U -s ${securityWord(entry.service)} -a ${securityWord(entry.account)} -w ${securityWord(secret)}\n`;
      if (Buffer.byteLength(line, 'utf-8') > SECURITY_LINE_MAX) return false;
      return run(SECURITY, ['-i'], line).ok ? 'the macOS keychain' : false;
    },
    delete(entry) {
      run(SECURITY, ['delete-generic-password', '-s', entry.service, '-a', entry.account]);
    },
  });
}
