// Fallback rendering for machines with no status line of their own.
//
// Chaining exists so a user who already built a status line keeps it byte-for-byte. Someone with
// no `statusLine` at all has nothing to chain — and since an absent setting is a DISABLED status line, printing
// nothing would leave a configured status line that renders empty. So we draw the folder, the model and the
// context window. Copilot's own footer already shows quota, and no cost figure is drawn here (AIU = credit is
// unconfirmed). Set BEEZI_STATUSLINE_SILENT=1 for capture with no display.
//
// Every field here is optional by contract — context values are null early in a session — so each
// segment is dropped rather than defaulted, and an all-empty result returns '' instead of a line of separators.

function basename(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const pct = (value) => (typeof value === 'number' ? `${Math.round(value)}%` : null);

export function renderDefaultStatusline(payload) {
  const segments = [];

  const workspace = payload == null ? undefined : payload.workspace;
  const currentDir = workspace == null ? undefined : workspace.current_dir;
  const dir = basename(currentDir == null ? (payload == null ? undefined : payload.cwd) : currentDir);
  const modelInfo = payload == null ? undefined : payload.model;
  const model = modelInfo == null ? undefined : modelInfo.display_name;
  if (dir && model) segments.push(`${dir} [${model}]`);
  else if (dir) segments.push(dir);
  else if (model) segments.push(`[${model}]`);

  const contextWindow = payload == null ? undefined : payload.context_window;
  const context = pct(contextWindow == null ? undefined : contextWindow.used_percentage);
  if (context) segments.push(`ctx ${context}`);

  return segments.join(' · ');
}
