// Owns reading one VS Code Local-agent chat session into per-request usage.
import fs from 'fs';
import path from 'path';
import { isUsableSessionId } from '../../core/session-id.mjs';
import { modelName as billedModelName } from '../../core/model-names.mjs';
import { SESSION_FILE, sessionFileLocation } from './session-files.mjs';
import { replaySessionText, sessionReplayer, promptTokensSeenOf } from './patch-replay.mjs';
import { scanLines } from '../../platform/log-scan.mjs';
import { isPlain, str } from '../../core/guards.mjs';

const MODEL_PREFIX = /^copilot\//i;
const EDIT_PART = 'textEditGroup';

function finiteMs(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}

function count(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function nonNeg(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
}

// The session's full state rebuilt from the file, or null: .jsonl streamed line by line, the legacy .json parsed whole.
// A .json past Node's string limit fails to decode and is unreadable like any other.
export function replayVscodeSession(file) {
  try {
    if (/\.json$/i.test(file)) return replaySessionText(fs.readFileSync(file, 'utf8'), true);
    const replay = sessionReplayer();
    scanLines(file, (text) => replay.line(text));
    return replay.result();
  } catch {
    return null;
  }
}

// A billed model name: never the "auto" router and never with the "copilot/" vendor prefix.
function modelName(v) {
  return billedModelName(typeof v === 'string' ? v.replace(MODEL_PREFIX, '') : v);
}

function multiplierOf(details) {
  const m = typeof details === 'string' ? /•\s*(\d+(?:\.\d+)?)x\s*$/.exec(details) : null;
  return m == null ? null : nonNeg(Number(m[1]));
}

function requestOf(raw, index) {
  const r = isPlain(raw) ? raw : {};
  const result = isPlain(r.result) ? r.result : {};
  const meta = isPlain(result.metadata) ? result.metadata : {};
  const rounds = Array.isArray(meta.toolCallRounds) ? meta.toolCallRounds.filter(isPlain) : null;
  const lastRound = rounds != null && rounds.length > 0 ? rounds[rounds.length - 1] : null;
  const state = isPlain(r.modelState) ? r.modelState : {};
  const agent = isPlain(r.agent) ? r.agent : {};
  const message = isPlain(r.message) ? r.message : {};
  const completedAtMs = finiteMs(state.completedAt);
  const roundModel = lastRound == null ? null : modelName(lastRound.modelId);
  const promptTokens = count(r.promptTokens);
  return {
    index,
    requestId: str(r.requestId),
    startedAtMs: finiteMs(r.timestamp),
    completedAtMs,
    // Terminal, success or not: modelState 1 is done, 3 is failed or cancelled; both carry completedAt.
    completed: completedAtMs != null,
    state: typeof state.value === 'number' ? state.value : null,
    hasMessage: typeof message.text === 'string' && message.text.trim() !== '',
    model: modelName(meta.resolvedModel) || roundModel || modelName(r.modelId),
    roundModel,
    outputTokens: count(r.completionTokens),
    promptTokens: promptTokens != null ? promptTokens : count(meta.promptTokens),
    credits: nonNeg(r.copilotCredits),
    // The premium-request multiplier from a trailing "• 1x" in result.details; anchored so "• 0.3 credits" never matches.
    multiplier: multiplierOf(result.details),
    // Written in the same save as the final usage, after it: its presence means the counters are final.
    elapsedMs: nonNeg(r.elapsedMs),
    calls: rounds == null ? null : rounds.length,
    extensionVersion: str(agent.extensionVersion),
    agentId: str(agent.id),
    roundTimesMs: rounds == null ? [] : rounds.map((x) => finiteMs(x.timestamp)).filter((t) => t != null),
    // The replayed request itself, for the signal readers; every promptTokens value it held, in file order.
    raw: isPlain(raw) ? raw : null,
    promptTokensSeen: promptTokensSeenOf(raw),
  };
}

// A serialized VS Code URI's local path: fsPath, else path without the slash before a drive letter.
function uriPathOf(uri) {
  if (!isPlain(uri)) return null;
  return str(uri.fsPath) || (str(uri.path) == null ? null : uri.path.replace(/^\/(?=[A-Za-z]:)/, ''));
}

// Paths of the files the session's requests edited (editedFileEvents and applied edit groups).
function editedPathsOf(requests) {
  const out = [];
  for (const r of requests) {
    if (!isPlain(r)) continue;
    const events = Array.isArray(r.editedFileEvents) ? r.editedFileEvents : [];
    const groups = Array.isArray(r.response) ? r.response.filter((p) => isPlain(p) && p.kind === EDIT_PART) : [];
    for (const item of events.concat(groups)) {
      const p = isPlain(item) ? uriPathOf(item.uri) : null;
      if (p != null) out.push(p);
    }
  }
  return out;
}

// The account label VS Code stored with the selected model ("auth.accountLabel"), or null.
function accountLabelOf(root) {
  const input = isPlain(root.inputState) ? root.inputState : {};
  const selected = isPlain(input.selectedModel) ? input.selectedModel : {};
  const meta = isPlain(selected.metadata) ? selected.metadata : {};
  const auth = isPlain(meta.auth) ? meta.auth : {};
  return str(auth.accountLabel);
}

// One Local-agent session, usage per request; null for an unusable file. Never throws.
export function readVscodeSession(file) {
  try {
    if (typeof file !== 'string' || file === '') return null;
    const root = replayVscodeSession(file);
    if (root == null) return null;
    const m = SESSION_FILE.exec(path.basename(file));
    const sessionId = str(root.sessionId) || (m == null ? null : m[1]);
    if (!isUsableSessionId(sessionId)) return null;
    const where = sessionFileLocation(file, editedPathsOf(root.requests));
    return {
      sessionId,
      file: path.resolve(file),
      product: where.product,
      title: str(root.customTitle),
      createdAtMs: finiteMs(root.creationDate),
      folder: where.folder,
      workspaceFile: where.workspaceFile,
      accountLabel: accountLabelOf(root),
      requests: root.requests.map(requestOf),
    };
  } catch {
    return null;
  }
}

// True when at least one request carries a user message.
export function hasVscodeActivity(session) {
  return session != null && Array.isArray(session.requests) && session.requests.some((r) => r != null && r.hasMessage === true);
}
