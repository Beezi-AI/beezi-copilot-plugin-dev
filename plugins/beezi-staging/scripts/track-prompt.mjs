import { normalizeHookInput } from '../lib/host/hook-input.mjs';
import { readHookStdin } from '../lib/host/hook-stdin.mjs';
import { runHook, importHookModule } from '../lib/host/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/contract/diagnostic-codes.mjs';

// UserPromptSubmit hook: stores the mode the prompt was typed in (for the interactive skills' guard) and
// nudges the quota cache. Prints nothing: UserPromptSubmit output reaches the model.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookStdin());
if (input == null) process.exit(0);
runHook(DIAGNOSTIC_SOURCES.TRACK_PROMPT, async () => {
  // A slash command's own commands run after this hook, so what it stores is what they see.
  if (input.agent_mode != null || input.permission_mode != null) {
    const guard = await importHookModule(new URL('../lib/host/mode-guard.mjs', import.meta.url).href);
    if (guard != null) {
      guard.recordModeObservation(input.session_id, {
        fields: { agent_mode: input.agent_mode, permission_mode: input.permission_mode },
        at: input.timestamp,
      });
    }
  }
  // Never waits and never starts the Copilot runtime inline: it only spawns the detached worker when the cache is stale.
  const quota = await importHookModule(new URL('../lib/billing/quota/refresh.mjs', import.meta.url).href);
  if (quota != null) quota.maybeRefreshQuotaInBackground();
});
