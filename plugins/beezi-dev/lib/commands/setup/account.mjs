// The start of the terminal setup: preflight's verdict, then a linked account or a sign-in, and the signed-in line.
import { outputLines, printable, report, token } from './output.mjs';
import { signIn } from './sign-in.mjs';

const ACCOUNT_LINE = /^\d+\. (.+?)(?: \[([^\]]+)\])? key=(\S+)$/;
const WORKSPACE_SEPARATOR = ' · ';

// preflight.mjs --for login: true unless its first line is a ✗ verdict, which is printed, or the run itself fails.
export async function machineReady(ctx) {
  const result = await ctx.run('preflight', ['--for', 'login']);
  if (result.code !== 0) {
    report(ctx, result);
    return false;
  }
  const first = printable(result.stdout)[0];
  if (first !== undefined && first.indexOf('✗') === 0) {
    ctx.print(first);
    return false;
  }
  return true;
}

// Linked, non-revoked rows of `accounts.mjs list`: "<n>. <description>[ [flags]] key=<key>".
export function usableAccounts(text) {
  const accounts = [];
  outputLines(text).forEach((line) => {
    const found = ACCOUNT_LINE.exec(line);
    if (found === null) return;
    const flags = found[2] ? found[2].split(', ') : [];
    if (flags.indexOf('revoked') === -1) {
      accounts.push({ description: found[1], key: found[3], isDefault: flags.indexOf('default') !== -1 });
    }
  });
  return accounts;
}

async function listAccounts(ctx) {
  const listing = await ctx.run('accounts', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  return usableAccounts(listing.stdout);
}

// The default usable account, else the first one, else a sign-in; null when the sign-in did not finish.
export async function chooseAccount(ctx) {
  const accounts = await listAccounts(ctx);
  const preferred = accounts.find((a) => a.isDefault) || accounts[0];
  if (preferred !== undefined) return preferred;
  const signedIn = await signIn(ctx);
  if (signedIn === null) return null;
  const linked = (await listAccounts(ctx)).find((a) => a.key === signedIn.key);
  return linked !== undefined ? linked : { key: signedIn.key, description: null, isDefault: false };
}

// "✓ Signed in as <email>", with ", workspace <name>" for a one-workspace account, from its `settings keys` row; both bold.
export async function signedInLine(ctx, account) {
  const keys = await ctx.run('settings', ['keys']);
  const row = outputLines(keys.stdout).find((line) => line.startsWith(`account=${account.key} `));
  const email = row === undefined ? null : token(row, 'email');
  const at = account.description === null ? -1 : account.description.indexOf(WORKSPACE_SEPARATOR);
  const one = row !== undefined && token(row, 'workspaces') === '1' && at !== -1;
  const who = email !== null && email !== 'unknown' ? ` as ${ctx.style.bold(email)}` : '';
  return `✓ Signed in${who}${one ? `, workspace ${ctx.style.bold(account.description.slice(at + WORKSPACE_SEPARATOR.length))}` : ''}`;
}
