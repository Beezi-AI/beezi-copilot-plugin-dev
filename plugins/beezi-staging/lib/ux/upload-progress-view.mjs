// Past-session upload progress: the bar, plain and done lines, and the follower that polls the worker's records.

const BAR_CELLS = 14;
const GLYPHS = { done: '▓', left: '░' };
const ASCII_GLYPHS = { done: '#', left: '-' };
const POLL_MS = 1000;
const FRESH_SLACK_MS = 5000;
const FOLLOW_STALE_MS = 120000;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_SPINNER_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_COLUMNS = 2;
const FINISHING_PLAIN = 'Beezi: all sessions read, finishing upload…';

export const REST_LINE = 'Beezi: the rest keeps uploading in the background';

export function progressBar(processed, total, { ascii = false } = {}) {
  const glyphs = ascii ? ASCII_GLYPHS : GLYPHS;
  const done = total > 0 ? Math.round((BAR_CELLS * processed) / total) : 0;
  return glyphs.done.repeat(done) + glyphs.left.repeat(BAR_CELLS - done);
}

// Cut to `width` columns when given: the workspace name is shortened with '…', and a line still too long is cut at the width.
function fitted(lineFor, workspace, width) {
  const name = Array.from(String(workspace));
  const full = lineFor(name.join(''));
  const over = Array.from(full).length - width;
  if (width == null || over <= 0) return full;
  const keep = name.length - over - 1;
  if (keep > 0) return lineFor(`${name.slice(0, keep).join('')}…`);
  return Array.from(lineFor('…')).slice(0, Math.max(width, 0)).join('');
}

export function barLine(record, { ascii, width } = {}) {
  const bar = progressBar(record.processed, record.total, { ascii });
  return fitted((name) => `Uploading past sessions to ${name}  ${bar}  ${record.processed}/${record.total}`, record.workspace, width);
}

// Every session is read and the last uploads are still running.
const isFinishing = (record) => record.total > 0 && record.processed >= record.total;

// The bar line, or the finishing line once every session is read, behind a spinner frame that moves with `tick`.
export function liveLine(record, { ascii, width, tick = 0 } = {}) {
  const frames = ascii ? ASCII_SPINNER_FRAMES : SPINNER_FRAMES;
  const bodyWidth = width == null ? width : width - SPINNER_COLUMNS;
  const body = isFinishing(record)
    ? fitted((name) => `Finishing upload to ${name}`, `${record.workspace}…`, bodyWidth)
    : barLine(record, { ascii, width: bodyWidth });
  return `${frames[tick % frames.length]} ${body}`;
}

export function plainLine(record) {
  return isFinishing(record) ? FINISHING_PLAIN : `Beezi: ${record.processed}/${record.total} sessions read…`;
}

export function doneLine(record) {
  const noun = record.sent === 1 ? 'past session' : 'past sessions';
  return `✓ ${record.sent} ${noun} uploaded to ${record.workspace}`;
}

function isFresh(record, sinceMs) {
  return record != null && Date.parse(record.startedAt) >= sinceMs - FRESH_SLACK_MS;
}

// `read` and `isLive` come from lib/history/upload-progress.mjs, which ux may not import.
export async function followUploads({
  key, tenantIds, sinceMs, capMs = Infinity, shouldStop = () => false, onUpdate, onTick = () => {}, onDone, read, isLive, now = Date.now, sleep,
}) {
  const finished = [];
  const startMs = now();
  let lastSeenMs = startMs;
  let lastProcessed = null;
  let tick = 0;
  while (finished.length < tenantIds.length) {
    if (shouldStop()) return { finished, timedOut: false, stopped: true };
    const nowMs = now();
    if (nowMs - startMs >= capMs) return { finished, timedOut: true, stopped: false };
    const record = read(key, tenantIds[finished.length]);
    const fresh = isFresh(record, sinceMs);
    // A run that didn't end clean ends the follow: the caller prints the rest line and never marks it reported.
    if (fresh && record.finishedAt != null && record.failed === true) return { finished, timedOut: false, stopped: true, failed: true };
    if (fresh && record.finishedAt != null) {
      onDone(record);
      finished.push(record);
      lastSeenMs = nowMs;
      lastProcessed = null;
      continue;
    }
    if (fresh && isLive(record, nowMs)) {
      lastSeenMs = nowMs;
      if (record.processed !== lastProcessed) onUpdate(record);
      onTick(record, tick);
      tick += 1;
      lastProcessed = record.processed;
    }
    if (nowMs - lastSeenMs >= FOLLOW_STALE_MS) return { finished, timedOut: false, stopped: true };
    await sleep(POLL_MS);
  }
  return { finished, timedOut: false, stopped: false };
}
