// accounts.mjs list | use <ref>: the linked accounts and which one /beezi-staging-analytics reads from.
import { AccountStatus, getDefaultKey, listAccounts, resolveAccountRef, setDefault } from '../accounts/index-store.mjs';
import { describeAccount } from '../accounts/refs.mjs';
import { UserError } from '../core/errors.mjs';
import { checkInteractive } from '../host/mode-guard.mjs';
import { withFields } from '../ux/machine-lines.mjs';

async function list() {
  const accounts = await listAccounts();
  const def = await getDefaultKey();
  if (accounts.length === 0) {
    console.log('Beezi: this machine is not linked. Run /beezi-staging-login to link an account.');
    return;
  }
  accounts.forEach((a, i) => {
    const flags = [a.key === def ? 'default' : null, a.status === AccountStatus.REVOKED ? 'revoked' : null].filter(Boolean);
    console.log(withFields(`${i + 1}. ${describeAccount(a)}${flags.length ? ` [${flags.join(', ')}]` : ''}`, [['key', a.key]]));
  });
  if (def == null) console.log('No default account is set — /beezi-staging-analytics has nothing to read from.');
}

async function use(ref) {
  const key = await resolveAccountRef(ref);
  const row = (await listAccounts()).find((a) => a.key === key);
  if (row.status === AccountStatus.REVOKED) throw new UserError(`${describeAccount(row)} is revoked — run /beezi-staging-login and sign in as it first.`);
  // Changing the default persists an answer, so an unattended session must not reach the write.
  const verdict = await checkInteractive({ purpose: 'changing the default account', requireWrite: true });
  if (verdict != null && verdict.ok === false) {
    console.log(`✗ ${verdict.message}`);
    return;
  }
  await setDefault(key);
  console.log(`✓ /beezi-staging-analytics now reads from ${describeAccount(row)}.`);
  console.log('  If the analytics tools look wrong after switching workspaces, start a new Copilot session.');
}

export async function runAccounts(argv) {
  const [cmd, ref] = argv;
  if (cmd === 'list' || cmd == null) { await list(); return; }
  if (cmd === 'use') {
    if (!ref) throw new UserError('Usage: accounts.mjs use <key|email|n>');
    await use(ref);
    return;
  }
  throw new UserError(`Unknown command "${cmd}". Usage: accounts.mjs list | use <key|email|n>`);
}
