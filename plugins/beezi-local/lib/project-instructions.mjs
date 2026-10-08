import fs from 'fs';
import path from 'path';

const CANDIDATES = ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
// The portal rejects a report whose per-file line count exceeds this.
const MAX_FILE_LINES = 1000000;
const UNKNOWN = { project_instructions_status: 'unknown' };
const MISSING = { project_instructions_status: 'missing' };

// wc -l, except a last line without a trailing newline still counts.
function lineCount(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

export function projectInstructions(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) return UNKNOWN;
  try {
    if (!fs.statSync(repoRoot).isDirectory()) return UNKNOWN;
    // `.git` is a directory in a checkout and a file in a worktree or submodule.
    fs.statSync(path.join(repoRoot, '.git'));
  } catch {
    return UNKNOWN;
  }
  const seen = new Set();
  const files = [];
  let present = false;
  let lines = 0;
  for (const rel of CANDIDATES) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch (error) {
      const code = error == null ? null : error.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return UNKNOWN;
    }
    present = true;
    const key = text.replace(/\r\n/g, '\n').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const count = Math.min(lineCount(text), MAX_FILE_LINES);
    lines += count;
    files.push({ path: rel, lines: count });
  }
  return present ? { project_instructions_status: 'present', claude_md_lines: lines, project_instructions_files: files } : MISSING;
}
