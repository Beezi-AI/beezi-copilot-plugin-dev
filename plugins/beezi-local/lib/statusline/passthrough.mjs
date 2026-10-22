// Beezi status line: records the session snapshot, then renders the user's own status line unchanged.
import os from 'os';
import { spawnSync } from 'child_process';
import { expandChainCommand } from './shim-script.mjs';

// ` · <badge>` after the last non-empty line, trailing whitespace kept; the badge alone for empty output.
export function appendBadge(text, badge) {
  const out = typeof text === 'string' ? text : '';
  if (!badge) return out;
  const body = out.replace(/\s+$/, '');
  if (body === '') return badge;
  return `${body} · ${badge}${out.slice(body.length)}`;
}

// Copilot hands the status-line command its session state on stdin. We record the model, context use and
// allow-all state locally and then render the user's own status line unchanged — Beezi adds no text and takes no
// slot away, unless the user turned on the Beezi badge, which ends the line. Nothing is fetched and no token is
// read, so this capture never leaves the machine.
//
// BEEZI_STATUSLINE_CHAIN names the status line this machine had before Beezi wrapped it; its
// output is passed through byte-for-byte so nobody loses the line they built. With nothing to
// chain we render folder, model and context instead — an absent `statusLine` is a DISABLED status
// line, so printing nothing would leave a configured-but-empty one. BEEZI_STATUSLINE_SILENT=1
// opts out of display entirely and keeps only the capture.
//
// The capture goes FIRST because this process can be killed, not waited for: every render may abort the one still
// in flight, and a status line slower than the gap between renders (a git-heavy line, anything spawned through npx)
// would lose every observation, silently. Capturing first bounds the exposure to node's own startup instead of the
// user's command. The bookkeeping cannot blank a status bar: it is one small local write, and every failure path
// below is swallowed so the display runs regardless. The opt-in badge comes last, after the line is known, so a
// failing badge leaves the line as it was.
// `badge` is the badge text, or a function giving it (scripts/statusline.mjs computes it only when it is on), or null.
export async function runStatusline(raw, { badge = null } = {}) {
  try {
    const { recordStatuslineSnapshot } = await import('../state/statusline-snapshot.mjs');
    recordStatuslineSnapshot(raw);
  } catch {
    /* best-effort: the status line's job is to render, not to report */
  }

  const silent = process.env.BEEZI_STATUSLINE_SILENT === '1';
  const chain = process.env.BEEZI_STATUSLINE_CHAIN;
  let out = '';
  if (chain) {
    const result = spawnSync(expandChainCommand(chain, { home: os.homedir() }), {
      input: JSON.stringify(raw == null ? {} : raw),
      shell: true,
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.stdout) out = result.stdout;
  } else if (!silent) {
    try {
      const { renderDefaultStatusline } = await import('./render.mjs');
      out = renderDefaultStatusline(raw) || '';
    } catch {
      /* rendering is cosmetic; the capture above already landed */
    }
  }
  if (!silent) {
    try {
      out = appendBadge(out, typeof badge === 'function' ? await badge() : badge);
    } catch {
      /* the badge is cosmetic too */
    }
  }
  if (out) process.stdout.write(out);
  // NOT process.exit(): stdout is a pipe here, so a line longer than the pipe buffer is still
  // queued when this line runs and exit() would drop the rest of it. Nothing holds the loop open
  // once the write drains — spawnSync keeps no handle — so a natural exit ends just as promptly.
  process.exitCode = 0;
}
