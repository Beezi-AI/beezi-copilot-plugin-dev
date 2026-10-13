// Owns the Windows Credential Manager backend, reached through advapi32 P/Invoke in PowerShell.
import { POWERSHELL } from '../../platform/windows-paths.mjs';
import { BACKENDS, powershell, readResult, runRead, withGet } from './process.mjs';

// Windows: the primary store is the Credential Manager, reached via a P/Invoke to advapi32
// (CredWrite/CredRead/CredDelete) — the token then appears under Control Panel → Credential
// Manager → Windows Credentials, keyed by the entry's target. The `cmdkey` CLI can *store* but
// not read a secret back, so we call the Win32 API directly through PowerShell. Should that ever
// fail (locked-down box, PowerShell missing) we fall back to DPAPI (user-bound OS crypto) with the
// ciphertext kept in the 0600 file, and finally to a plaintext 0600 file.

// ── Windows Credential Manager via advapi32 P/Invoke (the primary Windows store) ──
// The CREDENTIAL struct is shared by the read and write scripts. CharSet=Unicode marshals
// TargetName/UserName as wide strings; the secret blob is written/read as UTF-16 so it
// round-trips any character (verified against '&', '=', '.'). Target and account names are
// plain [a-z0-9/-] identifiers, safe inside the single-quoted literals below.
const CRED_STRUCT = `
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type;
  public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob;
  public uint Persist; public uint AttributeCount; public IntPtr Attributes;
  public string TargetAlias; public string UserName;
}`;

// Reads the secret from stdin (never an argv element, so it can't leak via the process list),
// writes a GENERIC credential with LOCAL_MACHINE persistence, prints 'OK' on success.
const credWrite = (entry) => `$in=[Console]::In.ReadToEnd()
Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredW {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite([In] ref CREDENTIAL c, uint flags);${CRED_STRUCT}
}
"@
$bytes=[Text.Encoding]::Unicode.GetBytes($in)
$blob=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes,0,$blob,$bytes.Length)
$c=New-Object BeeziCredW+CREDENTIAL
$c.Type=1; $c.TargetName='${entry.target}'; $c.UserName='${entry.account}'
$c.CredentialBlob=$blob; $c.CredentialBlobSize=$bytes.Length; $c.Persist=2
$ok=[BeeziCredW]::CredWrite([ref]$c,0)
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
if($ok){'OK'}else{exit 1}`;

// Reads the GENERIC credential back and writes the plaintext secret to stdout; exits non-zero
// when the target is absent (fresh machine, or token stored by the DPAPI fallback instead).
const credRead = (entry) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredR {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);${CRED_STRUCT}
}
"@
$ptr=[IntPtr]::Zero
if(-not [BeeziCredR]::CredRead('${entry.target}',1,0,[ref]$ptr)){exit 1}
$cred=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[Type][BeeziCredR+CREDENTIAL])
$size=$cred.CredentialBlobSize
if($size -gt 0){
  $bytes=New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob,$bytes,0,$size)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
}
[BeeziCredR]::CredFree($ptr)`;

const credDelete = (entry) => `Add-Type @"
using System; using System.Runtime.InteropServices;
public class BeeziCredD {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
[void][BeeziCredD]::CredDelete('${entry.target}',1,0)`;

// CRED_MAX_CREDENTIAL_BLOB_SIZE (5 × 512 bytes); the blob is UTF-16, two bytes per JS code unit.
export const CRED_BLOB_MAX_BYTES = 2560;

// True when CredWrite would refuse the secret's UTF-16 blob, so set skips the spawn and the chain moves on.
export function exceedsCredBlob(secret) {
  return Buffer.byteLength(String(secret), 'utf16le') > CRED_BLOB_MAX_BYTES;
}

export function credManBackend(run) {
  return withGet({
    name: BACKENDS.CREDENTIAL_MANAGER,
    kind: 'os',
    available: () => true, // advapi32 + PowerShell ship with Windows; failures fall through
    read(entry, options) {
      return readResult(runRead(
        run, POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', credRead(entry)],
        undefined, options,
      ));
    },
    set(entry, secret) {
      if (exceedsCredBlob(secret)) return false;
      const r = powershell(run, credWrite(entry), secret);
      return r.ok && r.stdout.trim() === 'OK' ? 'the Windows Credential Manager' : false;
    },
    delete(entry) {
      powershell(run, credDelete(entry));
    },
  });
}
