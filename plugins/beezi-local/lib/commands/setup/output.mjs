// Reading the plugin scripts' output for the terminal setup: lines, key=value fields, and what a person sees.
const MACHINE_LINES = [/^[\w-]+=/, /^[A-Z]\d*\. .* account=/, /-command=/, /^\s*[{[]/];
const STOPPED = '✗ That step stopped unexpectedly.';

export function outputLines(text) {
  return String(text || '').split(/\r?\n/);
}

export function lastLine(text, pattern) {
  const matches = outputLines(text).filter((line) => pattern.test(line));
  return matches.length ? matches[matches.length - 1] : null;
}

export function token(line, name) {
  const found = new RegExp(`(?:^| )${name}=(\\S*)`).exec(line);
  return found ? found[1] : null;
}

// Non-empty lines with trailing spaces trimmed.
export function printable(text) {
  return outputLines(text).map((line) => line.trimEnd()).filter((line) => line !== '');
}

// The printable lines a person reads: no key=value, listing, command or JSON lines.
export function humanLines(text) {
  return printable(text).filter((line) => !MACHINE_LINES.some((pattern) => pattern.test(line)));
}

function reportFailure(ctx, result) {
  if (result.stderr.trim() !== '') {
    printable(result.stderr).forEach((line) => ctx.print(line));
    return;
  }
  const human = humanLines(result.stdout);
  if (human.length === 0) human.push(STOPPED);
  human.forEach((line) => ctx.print(line));
}

// A run's first stdout line on success; on failure its stderr, else its human stdout lines, else one ✗ line.
export function report(ctx, result) {
  if (result.code !== 0) {
    reportFailure(ctx, result);
    return;
  }
  const lines = printable(result.stdout);
  if (lines.length) ctx.print(lines[0]);
}

// Every human stdout line on success; a failure as report prints it.
export function reportAll(ctx, result) {
  if (result.code !== 0) {
    reportFailure(ctx, result);
    return;
  }
  humanLines(result.stdout).forEach((line) => ctx.print(line));
}
