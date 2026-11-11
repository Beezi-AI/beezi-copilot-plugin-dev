// The terminal setup's header (the Beezi mark) and its closing block.
const MARK = [
  '   ▄▄█',
  '▄███▀▀ ▄▄██▄',
  '▀▀ ▄▄███▀▀',
  '▄███▀▀ ▄▄███',
  '      █▀▀▀',
];

const MARK_WIDTH = 12;
const MARK_GAP = '   ';
const WORD_ROW = 1;
const AGENT_ROW = 2;
const AGENT = 'GitHub Copilot';
const SETTINGS = '(/beezi-staging-settings)';
export const NO_PLAN = "Beezi couldn't detect this machine's plan. Set it in /beezi-staging-settings.";
const PAST_FAILED = "Beezi couldn't check past sessions. Run /beezi-staging-login to choose what to track.";

// The setup's header: the mark with "beezi" and "for GitHub Copilot" beside it, or the plain "Beezi for GitHub Copilot" line when colour is off.
export function headerLines(style) {
  if (!style.enabled) return [`Beezi for ${AGENT}`, ''];
  const side = { [WORD_ROW]: style.bold('beezi'), [AGENT_ROW]: style.dim(`for ${AGENT}`) };
  const rows = MARK.map((row, i) => {
    const art = style.mark(i, row.padEnd(MARK_WIDTH));
    return side[i] === undefined ? `  ${art}` : `  ${art}${MARK_GAP}${side[i]}`;
  });
  return [''].concat(rows, ['']);
}

// What is on after the run, for the closing dim line; null when neither is.
function onPhrase(crash, statusline) {
  if (crash && statusline) return 'Crash reports and the status line are on';
  if (crash) return 'Crash reports are on';
  return statusline ? 'The status line is on' : null;
}

// The closing block: the Ready line, then dim lines for what is on, a plan that was not found and past sessions not checked.
export function closingLines(options) {
  const style = options.style;
  const on = onPhrase(options.crash, options.statusline);
  const lines = ['', `${style.bold('Ready.')} Restart Copilot and keep working.`];
  if (on !== null) lines.push(style.dim(`${on} ${SETTINGS}`));
  if (!options.planFound) lines.push(style.dim(NO_PLAN));
  if (options.pastFailed) lines.push(style.dim(PAST_FAILED));
  return lines;
}
