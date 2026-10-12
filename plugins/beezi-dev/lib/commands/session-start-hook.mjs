// The SessionStart hook body: workspace prompt, session-start notices and the one relayed line, as additionalContext.
import { importHookModule as _importHookModule } from '../host/hook-runner.mjs';
import { relayLine, relayInstruction } from '../host/session-start-output.mjs';

// Notices from the workspace prompt module, appended after runSessionStart's own.
async function promptNotices(prompt, input) {
  let workspacePrompt = null;
  let targetsNotice = null;
  let joinedNotice = null;
  try {
    // Re-binds on every source with the workspaces runSessionStart just refreshed; asks only on startup or new.
    if (prompt != null) workspacePrompt = await prompt.buildWorkspacePrompt(input);
    if (prompt != null && input.source !== 'resume') targetsNotice = await prompt.buildTargetsNotice(input);
    if (prompt != null && input.source !== 'resume') joinedNotice = await prompt.buildJoinedNotice();
  } catch { /* the ask is best-effort; the session still starts */ }
  return { workspacePrompt, targetsNotice, joinedNotice };
}

// Resolves to { additionalContext }; on a runSessionStart failure writes the workspace prompt through `write` and rethrows.
// `deps.importHookModule` stands in for the runner's loader.
export async function runSessionStartHook(input, { budgetMs, write }, deps = {}) {
  const importHookModule = deps.importHookModule == null ? _importHookModule : deps.importHookModule;
  // Bound before the network work, so a killed or failed start still leaves the checkpoint its hold file.
  let prompt = null;
  try {
    prompt = await importHookModule(new URL('../ux/workspace-prompt.mjs', import.meta.url).href);
    if (prompt != null) await prompt.markPendingWorkspace(input);
  } catch { /* the ask is best-effort; the session still starts */ }
  const mod = await importHookModule(new URL('./session-start.mjs', import.meta.url).href);
  let notices = [];
  let failure = null;
  try {
    if (mod != null) notices = (await mod.runSessionStart(input, { budgetMs })).notices;
  } catch (error) { failure = error; }
  const { workspacePrompt, targetsNotice, joinedNotice } = await promptNotices(prompt, input);
  if (targetsNotice != null && targetsNotice.context != null) notices.push({ text: targetsNotice.context, kind: 'targets', actionable: false });
  if (targetsNotice != null && targetsNotice.notTracked != null) notices.push({ text: targetsNotice.notTracked, kind: 'not-tracked', actionable: true });
  if (joinedNotice != null) notices.push({ text: joinedNotice.text, kind: 'joined', actionable: true });
  const parts = workspacePrompt == null ? [] : [workspacePrompt];
  // A -p or autopilot run must stay clean: nobody is there to read a relayed line.
  const attendance = await importHookModule(new URL('../host/attendance.mjs', import.meta.url).href);
  const attended = attendance == null || !attendance.unattendedStatus({ input, sessionId: input.session_id }).unattended;
  const line = attended ? relayLine(notices) : null;
  // Marked announced only once this notice is the one relayed, so a higher-priority notice doesn't swallow it.
  if (joinedNotice != null && line === joinedNotice.text && failure == null) await joinedNotice.mark();
  if (line != null) parts.push(relayInstruction(line));
  const result = { additionalContext: parts.length === 0 ? null : parts.join('\n\n') };
  // A failure after the workspace prompt was built still writes the prompt.
  if (failure != null) {
    write({ additionalContext: workspacePrompt });
    throw failure;
  }
  return result;
}
