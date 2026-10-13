// The SessionStart relay line: which notice is relayed to the user, and the quoted instruction that carries it.

// Most important first; `restart`, `joined`, `history`, `health` and `targets` extend auth > update > billing > policy > consent > statusline; `not-tracked` (a rule the user set) is the lowest.
export const RELAY_ORDER = ['auth', 'restart', 'update', 'billing', 'policy', 'consent', 'joined', 'history', 'statusline', 'health', 'targets', 'not-tracked'];

export function relayLine(notices) {
  for (const kind of RELAY_ORDER) {
    const notice = notices.find((n) => n.kind === kind && n.actionable);
    if (notice != null) return notice.text;
  }
  return null;
}

// The line is quoted for the model, so no quote, backtick or line break may survive in it.
export function quotable(line) {
  return String(line).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/["`“”„‟]/g, '\'');
}

// The one JSON object the hook prints, or null for none: the Copilot CLI reads the top-level key, VS Code Local chat only
// hookSpecificOutput's.
export function sessionStartOutput(additionalContext) {
  if (typeof additionalContext !== 'string' || additionalContext === '') return null;
  return { additionalContext, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
}

export function relayInstruction(line) {
  return `Beezi plugin notice for the user. In your first reply this session, before anything else, quote this line exactly and then continue: "${quotable(line)}"`;
}
