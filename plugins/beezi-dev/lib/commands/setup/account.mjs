// The start of the terminal setup: preflight's verdict, then a linked account or a sign-in.
import { outputLines, printable, report } from './output.mjs';
import { signIn } from './sign-in.mjs';

export const ACCOUNT_QUESTION = 'This machine is already linked to Beezi. Which account should setup use?';
const KEEP_ACCOUNT = 'Keep this account; no browser sign-in';
const LINK_ANOTHER = { label: 'Link another account', description: 'Sign in through your browser' };
const ACCOUNT_LINE = /^\d+\. (.+?)(?: \[([^\]]+)\])? key=(\S+)$/;

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

// A linked account the user picks, else a fresh sign-in; null stops setup.
export async function chooseAccount(ctx) {
  const listing = await ctx.run('accounts', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  const usable = usableAccounts(listing.stdout);
  // The default account first, then the rest in listed order.
  const accounts = usable.filter((a) => a.isDefault).concat(usable.filter((a) => !a.isDefault));
  if (accounts.length === 0) return signIn(ctx);
  const options = accounts.map((a) => ({ label: `Continue with ${a.description}`, description: KEEP_ACCOUNT })).concat([LINK_ANOTHER]);
  const choice = await ctx.ask.choose(ACCOUNT_QUESTION, options, { defaultIndex: 0 });
  if (choice === null) return null;
  if (choice === accounts.length) return signIn(ctx);
  return { key: accounts[choice].key, readsElsewhere: false };
}
