import { runShutdownWait } from '../lib/pipeline/shutdown-wait.mjs';
import { isUsableSessionId } from '../lib/core/session-id.mjs';
import { exitClean } from '../lib/platform/exit.mjs';

// Detached from SessionEnd: waits for the session.shutdown Copilot writes after that hook and bills it; argv is the session id only, prints nothing.
async function main() {
  if (process.env.BEEZI_COPILOT_PROBE === '1') return;
  const sessionId = process.argv[2];
  if (!isUsableSessionId(sessionId)) return;
  await runShutdownWait(sessionId);
}

main().catch(() => {}).then(() => exitClean(0)).catch(() => exitClean(0));
