// Which shell commands move the session's branch or commit, so the PostToolUse hook checkpoints after them.

// `git [-C <dir>] commit|switch|checkout|merge|rebase|pull`, or `gh pr checkout`, anywhere in the command line.
const GIT_CHECKPOINT = /\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+(?:commit|switch|checkout|merge|rebase|pull)\b|\bgh\s+pr\s+checkout\b/;

export function isGitCheckpointCommand(cmd) {
  return typeof cmd === 'string' && GIT_CHECKPOINT.test(cmd);
}
