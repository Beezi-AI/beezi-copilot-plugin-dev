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

// The joined ask (built only when `asking`, so other sessions skip its credential reads) and the history notice,
// each on its own so one failing never drops the other or the folder ask.
async function joinedNotices(joined, input, asking) {
  let joinedPrompt = null;
  let historyNotice = null;
  try {
    if (joined != null && asking && input.source !== 'resume') joinedPrompt = await joined.buildJoinedPrompt(input);
  } catch { /* asked again next session */ }
  try {
    if (joined != null) historyNotice = await joined.buildHistoryNotice(input);
  } catch { /* shown next session */ }
  return { joinedPrompt, historyNotice };
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
  // A -p or autopilot run must stay clean: nobody is there to read a relayed line.
  const attendance = await importHookModule(new URL('../host/attendance.mjs', import.meta.url).href);
  const status = attendance == null ? null : attendance.unattendedStatus({ input, sessionId: input.session_id });
  const attended = status == null || !status.unattended;
  // Only a session known to have ask_user is asked; with no signal the joined line is relayed instead.
  const asking = status != null && status.signal === attendance.UnattendedSignal.ATTENDED;
  const joined = await importHookModule(new URL('../ux/joined-prompt.mjs', import.meta.url).href);
  const { joinedPrompt, historyNotice } = await joinedNotices(joined, input, asking);
  const parts = [];
  // The joined re-pick comes first, so the current-folder question sees its answers.
  if (joinedPrompt != null) parts.push(joinedPrompt);
  else if (joinedNotice != null) notices.push({ text: joinedNotice.text, kind: 'joined', actionable: true });
  if (workspacePrompt != null) parts.push(workspacePrompt);
  if (targetsNotice != null && targetsNotice.context != null) notices.push({ text: targetsNotice.context, kind: 'targets', actionable: false });
  if (targetsNotice != null && targetsNotice.notTracked != null) notices.push({ text: targetsNotice.notTracked, kind: 'not-tracked', actionable: true });
  if (historyNotice != null) notices.push({ text: historyNotice.text, kind: 'history', actionable: true });
  const line = attended ? relayLine(notices) : null;
  // Marked announced only once this notice is the one relayed, so a higher-priority notice doesn't swallow it.
  if (joinedNotice != null && line === joinedNotice.text && failure == null) await joinedNotice.mark();
  if (historyNotice != null && line === historyNotice.text && failure == null) await historyNotice.mark();
  if (line != null) parts.push(relayInstruction(line));
  const result = { additionalContext: parts.length === 0 ? null : parts.join('\n\n') };
  // A failure after the workspace prompt was built still writes the prompt.
  if (failure != null) {
    write({ additionalContext: workspacePrompt });
    throw failure;
  }
  return result;
}
