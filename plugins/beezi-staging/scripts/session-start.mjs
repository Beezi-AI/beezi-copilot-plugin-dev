import { readHookInput, normalizeHookInput, recordHookSeen } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// The only hook that writes to stdout: at most one JSON object, { additionalContext }. The notice channel is the
// degraded one (spec 3.2): whether the CLI shows a hook `systemMessage` or `{"type":"progress"}` lines is open
// (V-06, V-50), so the most important actionable notice rides additionalContext as a line for the model to relay.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const input = normalizeHookInput(readHookInput());
if (input == null) process.exit(0);
recordHookSeen('SessionStart');

// Most important first; `restart`, `joined` and `targets` extend the plan's auth > update > billing > policy > consent > statusline; `not-tracked` (a rule the user set) is the lowest.
const RELAY_ORDER = ['auth', 'restart', 'update', 'billing', 'policy', 'consent', 'joined', 'statusline', 'targets', 'not-tracked'];

function relayLine(notices) {
  for (const kind of RELAY_ORDER) {
    const notice = notices.find((n) => n.kind === kind && n.actionable);
    if (notice != null) return notice.text;
  }
  return null;
}

// The line is quoted for the model, so no quote, backtick or line break may survive in it; inline because a static lib import would load before the probe exit.
function quotable(line) {
  return String(line).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/["`\u201c\u201d\u201e\u201f]/g, '\'');
}

function relayInstruction(line) {
  return `Beezi plugin notice for the user. In your first reply this session, before anything else, quote this line exactly and then continue: "${quotable(line)}"`;
}

function write({ additionalContext }) {
  if (additionalContext) process.stdout.write(JSON.stringify({ additionalContext }));
}

runHook(DIAGNOSTIC_SOURCES.SESSION_START, async () => {
  // Bound before the network work, so a killed or failed start still leaves the checkpoint its hold file.
  let prompt = null;
  try {
    prompt = await importHookModule('./workspace-prompt.mjs');
    if (prompt != null) await prompt.markPendingWorkspace(input);
  } catch { /* the ask is best-effort; the session still starts */ }
  const mod = await importHookModule('./session-start.mjs');
  let notices = [];
  let failure = null;
  try {
    // Nine seconds, not twelve: the sync git calls cannot be preempted and the workspace prompt still runs after it, inside the 15 s hook timeout.
    if (mod != null) notices = (await mod.runSessionStart(input, { budgetMs: 9000 })).notices;
  } catch (error) { failure = error; }
  let workspacePrompt = null;
  let targetsNotice = null;
  let joinedNotice = null;
  try {
    // Re-binds on every source with the workspaces runSessionStart just refreshed; asks only on startup or new.
    if (prompt != null) workspacePrompt = await prompt.buildWorkspacePrompt(input);
    if (prompt != null && input.source !== 'resume') targetsNotice = await prompt.buildTargetsNotice(input);
    if (prompt != null && input.source !== 'resume') joinedNotice = await prompt.buildJoinedNotice();
  } catch { /* the ask is best-effort; the session still starts */ }
  if (targetsNotice != null && targetsNotice.context != null) notices.push({ text: targetsNotice.context, kind: 'targets', actionable: false });
  if (targetsNotice != null && targetsNotice.notTracked != null) notices.push({ text: targetsNotice.notTracked, kind: 'not-tracked', actionable: true });
  if (joinedNotice != null) notices.push({ text: joinedNotice.text, kind: 'joined', actionable: true });
  const parts = workspacePrompt == null ? [] : [workspacePrompt];
  // A -p or autopilot run must stay clean: nobody is there to read a relayed line.
  const workspaceSession = await importHookModule('./workspace-session.mjs');
  const attended = workspaceSession == null
    || !workspaceSession.unattendedStatus({ env: process.env, input, sessionId: input.session_id }).unattended;
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
}, { onResult: write });
