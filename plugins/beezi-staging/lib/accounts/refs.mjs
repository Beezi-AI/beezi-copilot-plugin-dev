// Owns account display text and the matching of --account references against a list of index rows.
import { UserError } from '../core/errors.mjs';

export function describeAccount(a) {
  if (a == null) return 'unknown account';
  let who;
  if (a.name) who = `${a.name} <${a.email == null ? 'unknown' : a.email}>`;
  else if (a.email) who = a.email;
  else who = 'linked account (details on next session)';
  return a.tenantName ? `${who} · ${a.tenantName}` : who;
}

// A key, an email, or a 1-based position in `accounts` order; returns the matching key.
export function matchAccountRef(accounts, ref) {
  const value = ref == null ? '' : String(ref).trim();
  if (!value) throw new UserError('No account given.');
  const byKey = accounts.find((a) => a.key === value);
  if (byKey) return byKey.key;
  const byEmail = accounts.find((a) => a.email != null && a.email.toLowerCase() === value.toLowerCase());
  if (byEmail) return byEmail.key;
  if (/^\d+$/.test(value)) {
    const row = accounts[Number(value) - 1];
    if (row) return row.key;
  }
  throw new UserError(`No linked account matches "${value}". Run /beezi-staging-settings account to list them.`);
}

// Strips --account <ref> out of argv; `ref` is the raw value or null.
export function splitAccountFlag(argv) {
  const rest = [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--account') {
      ref = argv[++i];
      if (ref == null) throw new UserError('--account needs a value: a key, an email, or a position from /beezi-staging-settings account.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { ref, rest };
}
