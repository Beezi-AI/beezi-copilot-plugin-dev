import fs from 'fs';
import path from 'path';
import { isUsableSessionId } from './session-state.mjs';
import { copilotSessionFile } from './copilot-paths.mjs';
import { beeziHome } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { findSessionFile } from './transcript-index-copilot.mjs';
import { findVscodeSessionFile } from './vscode-chat-session.mjs';

const SHELL_TOOLS = ['bash', 'powershell'];

export function isGitCheckpointCommand(cmd) {
  return typeof cmd === 'string' && /git\s+(commit|switch|checkout)\b/.test(cmd);
}

// Parse the hook's JSON payload from stdin (fd 0). Returns null on any read/parse
// failure so the caller can exit quietly — a hook must never throw on bad input.
export function readHookInput(fd = 0) {
  try {
    return JSON.parse(fs.readFileSync(fd, 'utf-8'));
  } catch {
    return null;
  }
}

const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// snake_case wins; the camelCase twin fills in when the snake_case key is absent.
function pick(raw, snake, camel) {
  if (raw[snake] != null) return raw[snake];
  return camel != null && raw[camel] != null ? raw[camel] : null;
}

const textOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null);
const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);

// camelCase payloads carry epoch ms (values below 1e11 are seconds), PascalCase ones ISO strings.
function isoTime(value, now) {
  let ms = NaN;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string') ms = Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : now).toISOString();
}

// An object parsed from a JSON string; the string itself when it is not JSON (or not an object).
function toolInputOf(value) {
  if (typeof value !== 'string') return value == null ? null : value;
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

// The error as { message, name, stack } (each string or null), or the bare string a payload may carry.
function errorOf(value) {
  if (typeof value === 'string') return value;
  if (!isPlain(value)) return null;
  return { message: textOrNull(value.message), name: textOrNull(value.name), stack: textOrNull(value.stack) };
}

// A subagent's hook may carry its own id with the parent's events.jsonl; then the file's directory names the owning session.
function owningSessionId(sessionId, transcriptPath) {
  if (transcriptPath == null || path.basename(transcriptPath) !== 'events.jsonl') return sessionId;
  const dirId = path.basename(path.dirname(transcriptPath));
  return isUsableSessionId(dirId) ? dirId : sessionId;
}

// Hook payload (either casing) → one snake_case shape, or null when it is unusable or its session id is not a safe path segment.
// Tool results and assistant messages are never copied: nothing downstream needs a tool's output.
export function normalizeHookInput(raw, { now = Date.now() } = {}) {
  if (!isPlain(raw)) return null;
  const payloadId = pick(raw, 'session_id', 'sessionId');
  if (!isUsableSessionId(payloadId)) return null;
  const payloadPath = textOrNull(pick(raw, 'transcript_path', 'transcriptPath'));
  const sessionId = owningSessionId(payloadId, payloadPath);
  const agentId = textOrNull(pick(raw, 'agent_id', 'agentId'));
  const prompt = pick(raw, 'prompt', 'initialPrompt');
  const reason = pick(raw, 'reason', 'stopReason');
  return {
    hook_event_name: textOrNull(pick(raw, 'hook_event_name', 'hookEventName')),
    session_id: sessionId,
    timestamp: isoTime(raw.timestamp, now),
    cwd: textOrNull(raw.cwd),
    // A payload without a path (SessionStart, SessionEnd, UserPromptSubmit, PostToolUse, PermissionRequest, ErrorOccurred) gets the session file derived from its id.
    transcript_path: payloadPath != null ? payloadPath : copilotSessionFile(sessionId),
    transcript_path_derived: payloadPath == null,
    source: textOrNull(raw.source),
    reason: textOrNull(reason),
    prompt: typeof prompt === 'string' ? prompt : null,
    tool_name: textOrNull(pick(raw, 'tool_name', 'toolName')),
    tool_input: toolInputOf(pick(raw, 'tool_input', 'toolArgs')),
    // A rerouted payload's own id is the subagent's, kept when the payload named no agent.
    agent_id: agentId == null && sessionId !== payloadId ? payloadId : agentId,
    agent_type: textOrNull(pick(raw, 'agent_type', 'agentType')),
    agent_name: textOrNull(pick(raw, 'agent_name', 'agentName')),
    agent_display_name: textOrNull(pick(raw, 'agent_display_name', 'agentDisplayName')),
    error: errorOf(raw.error),
    error_context: textOrNull(pick(raw, 'error_context', 'errorContext')),
    recoverable: boolOrNull(raw.recoverable),
    trigger: textOrNull(raw.trigger),
    stop_hook_active: boolOrNull(pick(raw, 'stop_hook_active', 'stopHookActive')),
    notification_type: textOrNull(pick(raw, 'notification_type', 'notificationType')),
    // Mode fields are copied through as found (V-04/V-14); nothing here infers a mode.
    permission_mode: textOrNull(pick(raw, 'permission_mode', 'permissionMode')),
    agent_mode: textOrNull(pick(raw, 'agent_mode', 'agentMode')),
    raw_casing: raw.session_id != null || raw.sessionId == null ? 'snake' : 'camel',
  };
}

// False for a path-less payload whose derived session file does not exist (a subagent's own id): such a hook has no transcript to checkpoint.
export function hasSessionFile(input) {
  if (input == null || !input.transcript_path_derived) return true;
  try { return fs.statSync(input.transcript_path).isFile(); } catch { return false; }
}

// True for a VS Code Local-agent hook, decided by the payload alone: it names a transcript that is not events.jsonl and no
// Copilot CLI session file exists for the id. Such a hook never reaches the Copilot CLI checkpoint, chat session file or not.
export function isVscodeHookPayload(input) {
  try {
    if (input == null || !isUsableSessionId(input.session_id)) return false;
    if (input.transcript_path == null || path.basename(input.transcript_path) === 'events.jsonl') return false;
    return findSessionFile(input.session_id) == null;
  } catch {
    return false;
  }
}

// The chat session file of a VS Code Local-agent hook once VS Code has written it, else null (VS Code's own transcript only locates it).
export function vscodeSessionFileFor(input) {
  try {
    return isVscodeHookPayload(input) ? findVscodeSessionFile(input.session_id, input.transcript_path) : null;
  } catch {
    return null;
  }
}

// The command of a shell tool call, or '' for any other tool.
export function shellCommandOf(input) {
  if (!isPlain(input) || typeof input.tool_name !== 'string') return '';
  if (SHELL_TOOLS.indexOf(input.tool_name.toLowerCase()) === -1) return '';
  const args = input.tool_input;
  if (typeof args === 'string') return args;
  if (!isPlain(args)) return '';
  if (typeof args.command === 'string') return args.command;
  return typeof args.cmd === 'string' ? args.cmd : '';
}

const hooksSeenFile = () => path.join(beeziHome(), 'hooks-seen.json');

// { <event>: <iso> } of the hooks that fired on this machine; read by the status report. Best effort, one small atomic write.
export function recordHookSeen(event, { now = Date.now() } = {}) {
  try {
    const seen = readHooksSeen();
    seen[event] = new Date(now).toISOString();
    writeJsonSecure(hooksSeenFile(), seen);
  } catch { /* a hook never fails over bookkeeping */ }
}

export function readHooksSeen() {
  const raw = readJson(hooksSeenFile(), null);
  const out = {};
  if (!isPlain(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'string' && Number.isFinite(Date.parse(raw[key]))) out[key] = raw[key];
  }
  return out;
}
