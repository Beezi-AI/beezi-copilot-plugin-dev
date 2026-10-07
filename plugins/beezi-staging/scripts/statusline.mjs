import { spawnSync } from 'child_process';
import { readHookInput } from '../lib/hook-input.mjs';

// Beezi status line: a pass-through wrapper.
//
// Copilot hands the status-line command its session state on stdin. We record the model, context use and
// allow-all state locally and then render the user's own status line unchanged — Beezi adds no text and takes no
// slot away. Nothing is fetched and no token is read, so this capture never leaves the machine.
//
// BEEZI_STATUSLINE_CHAIN names the status line this machine had before Beezi wrapped it; its
// output is passed through byte-for-byte so nobody loses the line they built. With nothing to
// chain we render folder, model and context instead — an absent `statusLine` is a DISABLED status
// line, so printing nothing would leave a configured-but-empty one. BEEZI_STATUSLINE_SILENT=1
// opts out of display entirely and keeps only the capture.
if (process.env.BEEZI_COPILOT_PROBE === '1') process.exit(0);
const raw = readHookInput();

// The capture goes FIRST because this process can be killed, not waited for: every render may abort the one still
// in flight, and a status line slower than the gap between renders (a git-heavy line, anything spawned through npx)
// would lose every observation, silently. Capturing first bounds the exposure to node's own startup instead of the
// user's command. The bookkeeping cannot blank a status bar: it is one small local write, and every failure path
// below is swallowed so the display runs regardless.
(async () => {
  try {
    const { recordStatuslineSnapshot } = await import('../lib/statusline-snapshot.mjs');
    recordStatuslineSnapshot(raw);
  } catch {
    /* best-effort: the status line's job is to render, not to report */
  }

  const chain = process.env.BEEZI_STATUSLINE_CHAIN;
  if (chain) {
    const result = spawnSync(chain, {
      input: JSON.stringify(raw == null ? {} : raw),
      shell: true,
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
  } else if (process.env.BEEZI_STATUSLINE_SILENT !== '1') {
    try {
      const { renderDefaultStatusline } = await import('../lib/statusline-render.mjs');
      const line = renderDefaultStatusline(raw);
      if (line) process.stdout.write(line);
    } catch {
      /* rendering is cosmetic; the capture above already landed */
    }
  }
  // NOT process.exit(): stdout is a pipe here, so a line longer than the pipe buffer is still
  // queued when this line runs and exit() would drop the rest of it. Nothing holds the loop open
  // once the write drains — spawnSync keeps no handle — so a natural exit ends just as promptly.
  process.exitCode = 0;
})();
