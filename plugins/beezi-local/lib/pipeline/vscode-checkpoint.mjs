// The VS Code Local-agent checkpoint: its steps on the shared run skeleton, through the same recipients, queue and flush as the CLI.
import fs from 'fs';
import { git } from '../repo/git.mjs';
import { createRepoContext, localRemote, UNKNOWN_REMOTE } from '../repo/repo-context.mjs';
import { resolveFetch } from '../platform/compat-fetch.mjs';
import { recordIssue } from '../telemetry/recorder.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from '../contract/diagnostic-codes.mjs';
import { BillingSource } from '../contract/billing-vocab.mjs';
import { loadSessionState, saveSessionState } from '../state/session-state.mjs';
import { isUsableSessionId } from '../core/session-id.mjs';
import { projectInstructions } from '../repo/project-instructions.mjs';
import { findVscodeSessionFile } from '../sources/vscode/session-files.mjs';
import { readVscodeSession, hasVscodeActivity } from '../sources/vscode/chat-session.mjs';
import { IdentitySurface } from '../billing/session-identity.mjs';
import {
  requestKey, prefixBase, resumedBase, sessionModels, settledWindow, buildVscodePayload, provisionalRequests, reportedBefore,
  consumeReplaced,
} from '../capture/vscode-requests.mjs';
import { requestError } from '../capture/vscode-signals.mjs';
import { detectTimezone, sessionNameField } from '../capture/payload-header.mjs';
import { sanitizeSessionName } from '../sources/cli/session-name.mjs';
import { settleWaitOf, awaitSettled, isQuiet, quietForMs } from './vscode-settle.mjs';
import { planDelivery } from './delivery-plan.mjs';
import { bindAccount, closeRun, establishFromServer, parkedErrorsPatch, readBilling, settleSessionErrors } from './checkpoint-steps.mjs';
import { acquireRunLock, budgetClock, budgetOf, CONTINUE, createLockHolder, driveRun, newRunResult, stopRun } from './run-skeleton.mjs';

const UNKNOWN_BRANCH = '(unknown)';
const NO_REPO = Object.freeze({ root: null, remote: UNKNOWN_REMOTE, branchAt: () => UNKNOWN_BRANCH });

function nonEmpty(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function isFile(p) {
  try { return typeof p === 'string' && p !== '' && fs.statSync(p).isFile(); } catch { return false; }
}

// The session id, transcript hint, budget and clock of the run, normalised from the hook or audit input.
function readInput(ctx) {
  const inp = ctx.input != null && typeof ctx.input === 'object' ? ctx.input : {};
  ctx.inp = inp;
  ctx.sessionId = inp.sessionId != null ? inp.sessionId : inp.session_id;
  ctx.hint = inp.transcriptPath != null ? inp.transcriptPath : inp.transcript_path;
  ctx.budgetMs = budgetOf(inp.budgetMs);
  ctx.live = ctx.options.persistState !== false;
  ctx.clock = budgetClock(ctx.budgetMs);
  return isUsableSessionId(ctx.sessionId) ? CONTINUE : stopRun('failed', 'unnamed-session', false);
}

// The chat session file: the caller's, the one stored for this id, else a lookup by id; a missing one stops after the
// recipients are planned, so its tail still flushes the account's queue like the CLI's.
function locateChat(ctx) {
  const { sessionId, inp } = ctx;
  const stored = loadSessionState(sessionId).vscode;
  let file = null;
  for (const candidate of [inp.file, stored == null ? null : stored.file]) {
    if (isFile(candidate)) { file = candidate; break; }
  }
  if (file == null) file = findVscodeSessionFile(sessionId, nonEmpty(ctx.hint));
  const session = file == null ? null : readVscodeSession(file);
  const found = session != null && session.sessionId === sessionId;
  Object.assign(ctx, { stored, file, session: found ? session : null });
  return CONTINUE;
}

// The requests before endCursor only: a lagging recipient's replay stops where the other recipients start.
function boundedSession(session, endCursor) {
  return Number.isInteger(endCursor) && endCursor >= 0 && endCursor < session.requests.length
    ? { ...session, requests: session.requests.slice(0, endCursor) }
    : session;
}

// A session with no model anywhere has nothing billable yet: nothing uploads and no state is kept.
async function settleChat(ctx) {
  const storedCwd = ctx.stored == null ? null : ctx.stored.cwd;
  if (ctx.session == null) {
    ctx.cwd = nonEmpty(ctx.inp.cwd) || storedCwd;
    return CONTINUE;
  }
  const settled = await awaitSettled(ctx.session, ctx.file, settleWaitOf({ settleWaitMs: ctx.inp.settleWaitMs, budgetMs: ctx.budgetMs, trigger: ctx.inp.trigger }));
  const session = boundedSession(settled, ctx.options.endCursor);
  const modelOf = sessionModels(session.requests);
  if (!hasVscodeActivity(session) || modelOf == null) return stopRun('deferred', 'no-activity', false);
  ctx.session = session;
  ctx.modelOf = modelOf;
  ctx.cwd = session.folder || nonEmpty(ctx.inp.cwd) || storedCwd;
  return CONTINUE;
}

async function planRecipients(ctx) {
  const cwd = ctx.cwd;
  // A session whose chat file is missing has nothing to bind a workspace for.
  const beforeBind = ctx.session == null ? async () => false : null;
  const delivery = await planDelivery(ctx.sessionId, { deps: ctx.deps, options: ctx.options, bindCwd: () => cwd, beforeBind });
  if (delivery.stop != null) {
    if (delivery.stop === 'tracking-gated') ctx.out.gated = true;
    return stopRun('deferred', delivery.stop, false);
  }
  ctx.delivery = delivery;
  return CONTINUE;
}

// The billing config and the repo map, read once before the lock; VS Code never touches the lock during git calls.
function openRun(ctx) {
  readBilling(ctx);
  ctx.repo = createRepoContext(ctx.gitImpl, () => {}, { fastRoot: ctx.deps.runCache == null ? null : ctx.deps.runCache.fastRoot });
  return CONTINUE;
}

function requireChat(ctx) {
  return ctx.session == null ? stopRun('failed', 'no-transcript', true) : CONTINUE;
}

async function lockSession(ctx) {
  const keepLock = await acquireRunLock(ctx.lock, ctx.sessionId, ctx.budgetMs);
  return keepLock == null ? stopRun('deferred', 'session-busy', false) : CONTINUE;
}

// The stored VS Code chat state and provisional credits (none for an audit), the session's account (the same order
// as the CLI's for a Local chat session) and its billing stamp at the session's start.
async function bindSession(ctx) {
  const loaded = loadSessionState(ctx.sessionId);
  ctx.state = loaded;
  ctx.chatState = ctx.live ? loaded.vscode : null;
  ctx.emittedCredits = ctx.live ? loaded.vscodeEmitted : {};
  ctx.billing.at = ctx.session.createdAtMs;
  await bindAccount(ctx, { surface: IdentitySurface.VSCODE, vscodeSession: ctx.session });
  return CONTINUE;
}

// Where reporting resumes: the requests already reported and the last line used.
async function placeBase(ctx) {
  const { session, options, chatState, live } = ctx;
  const requested = Number.isInteger(options.startCursor) && options.startCursor >= 0 ? options.startCursor : null;
  let base;
  if (!live) {
    base = prefixBase(session.requests, requested == null ? 0 : requested);
  } else if (chatState != null) {
    base = resumedBase(session.requests, chatState, requested);
  } else {
    const start = requested == null ? await establishFromServer(ctx) : requested;
    if (start == null) return stopRun('deferred', 'unestablished', true);
    base = prefixBase(session.requests, start);
  }
  if (base == null) {
    ctx.out.skipped.cursorMismatch = true;
    if (live) recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
    return stopRun('deferred', 'cursor-mismatch', true);
  }
  ctx.base = base;
  return CONTINUE;
}

// Repository and branch from the session's folder: root, then reflog and HEAD, then the remote fallback chain.
function lookupRepo(ctx) {
  const repo = ctx.repo;
  const root = repo.repoRootOf(ctx.cwd);
  const headBranch = repo.headBranchOf(root);
  const remote = repo.resolveRemote(root) || localRemote(root == null ? ctx.cwd : root) || UNKNOWN_REMOTE;
  const branchAt = (ms) => {
    const b = repo.branchAt(root, ms);
    return b && b !== UNKNOWN_BRANCH ? b : headBranch;
  };
  return { root, remote, branchAt };
}

// The fields every request's report shares; the chat title goes through the CLI's one title rule.
function payloadHeader(ctx, repo, hasWindow) {
  let instructions = null;
  try { instructions = hasWindow ? projectInstructions(repo.root) : null; } catch { instructions = null; }
  const timezone = detectTimezone();
  const title = ctx.session.title;
  const sessionName = title == null ? (ctx.chatState == null ? null : ctx.chatState.sessionName) : sessionNameField(sanitizeSessionName(title));
  return { sessionId: ctx.sessionId, remote: repo.remote, billingFields: ctx.billing.fields, identity: ctx.billing.identity, sessionName, timezone, instructions };
}

// Queues one segment per window request; a failed write stops the window there, so the cursor covers only what is on disk.
function emitRequests(ctx, window, header, repo) {
  let line = ctx.base.cursor;
  const reported = ctx.base.reported.slice();
  let lastPayload = null;
  for (const r of window) {
    const payload = buildVscodePayload(r, header, { line, branch: repo.branchAt(r.startedAtMs), model: ctx.modelOf[r.index] });
    ctx.lock.current().touch();
    try { ctx.delivery.emit(payload); } catch {
      ctx.out.skipped.emitFailed += 1;
      break;
    }
    line += 1;
    reported.push(requestKey(r));
    lastPayload = payload;
    ctx.out.segmentsQueued += 1;
  }
  return { line, reported, lastPayload };
}

// The newest request billed before it settles at the line it will settle on, so its later emits upsert one segment;
// only when every earlier request is reported. Sets ctx.provisional { requestKey: { credits, input, line } } for the commit.
function emitProvisional(ctx, candidates, header, repo) {
  const { line, reported } = ctx.emitted;
  ctx.provisional = {};
  for (const { request, credits, input } of candidates) {
    if (!reportedBefore(ctx.session.requests, request.index, reported) || reported.indexOf(requestKey(request)) !== -1) continue;
    const payload = buildVscodePayload(request, header, { line, branch: repo.branchAt(request.startedAtMs), model: ctx.modelOf[request.index] });
    ctx.lock.current().touch();
    try { ctx.delivery.emit(payload); } catch {
      ctx.out.skipped.emitFailed += 1;
      continue;
    }
    ctx.provisional[requestKey(request)] = { credits, input, line };
    ctx.out.segmentsQueued += 1;
  }
}

// The quota, rate-limit, billing and auth failures of the first `count` window requests, the ones this run reported.
function reportedErrors(window, count) {
  const out = [];
  for (const r of window.slice(0, count)) {
    const e = r.raw == null ? null : requestError(r.raw, r.completedAtMs != null ? r.completedAtMs : r.startedAtMs);
    if (e != null) out.push(e);
  }
  return out;
}

// Provisional emits are live only: an audit's upload would make the server prefix pass a request still open.
function emitWindow(ctx) {
  ctx.base = consumeReplaced(ctx.base, ctx.session.requests, ctx.emittedCredits);
  const window = settledWindow(ctx.session.requests, ctx.base.reported, isQuiet(ctx.file));
  const provisional = ctx.live ? provisionalRequests(ctx.session.requests, ctx.emittedCredits, quietForMs(ctx.file)) : [];
  const billable = window.length > 0 || provisional.length > 0;
  const repo = billable ? lookupRepo(ctx) : NO_REPO;
  const header = payloadHeader(ctx, repo, billable);
  ctx.sessionName = header.sessionName;
  ctx.emitted = emitRequests(ctx, window, header, repo);
  ctx.requestErrors = reportedErrors(window, ctx.emitted.line - ctx.base.cursor);
  if (window.length > 0 && ctx.emitted.lastPayload == null) return stopRun('failed', 'emit-failed', true);
  emitProvisional(ctx, provisional, header, repo);
  return CONTINUE;
}

// A new title alone re-sends the last report (same segmentId, so an upsert) and saves the name even when that write fails.
function replayTitle(ctx) {
  const { chatState: state, sessionName } = ctx;
  const replay = ctx.emitted.lastPayload == null && sessionName != null && state != null && state.lastReport != null && sessionName !== state.sessionName;
  if (replay) {
    try { ctx.delivery.emit({ ...state.lastReport, session_name: sessionName }); } catch { /* retried next checkpoint */ }
  }
  return replay;
}

// Provisional emits still open: a request now reported settled for good and leaves; this run's provisional ones overwrite.
function provisionalAfter(current, reported, fresh) {
  const settled = new Set(reported);
  const out = {};
  for (const key of Object.keys(current)) if (!settled.has(key)) out[key] = current[key];
  return { ...out, ...fresh };
}

// The cursor patch, only after every queue file of the run is complete on disk.
function commitState(ctx) {
  if (!ctx.live) return CONTINUE;
  ctx.lock.current().touch();
  const { chatState: state, sessionName, emitted } = ctx;
  const replayed = replayTitle(ctx);
  const saved = saveSessionState(ctx.sessionId, (cur) => ({
    vscode: {
      cursor: emitted.line,
      reported: emitted.reported,
      file: ctx.file,
      cwd: ctx.cwd == null ? null : ctx.cwd,
      lastReport: emitted.lastPayload != null ? emitted.lastPayload : (state == null ? null : state.lastReport),
      sessionName: emitted.lastPayload != null || replayed ? sessionName : (state == null ? null : state.sessionName),
    },
    vscodeEmitted: provisionalAfter(cur.vscodeEmitted, emitted.reported, ctx.provisional),
  }));
  if (saved) return CONTINUE;
  ctx.errors.push('state-write-failed');
  return stopRun('failed', 'internal', true);
}

// The VS Code tail: the reported requests' errors plus parked ones posted (or parked again) under the lock, then closeRun.
async function vscodeTail(ctx) {
  if (ctx.state == null) ctx.state = loadSessionState(ctx.sessionId);
  const settled = await settleSessionErrors(ctx, ctx.requestErrors);
  if (ctx.live && settled.changed) saveSessionState(ctx.sessionId, (cur) => parkedErrorsPatch(cur, settled));
  await closeRun(ctx);
}

// Every stop before the recipients skips the tail; the tail is errors, repo-map save, unlock and flush.
const STEPS = [readInput, locateChat, settleChat, planRecipients, openRun, requireChat, lockSession, bindSession, placeBase, emitWindow, commitState];

function newContext(input, deps, options, out) {
  return {
    input, deps, options, out, errors: out.errors,
    gitImpl: deps.runCache != null ? deps.runCache.git : (deps.gitImpl == null ? git : deps.gitImpl),
    fetchImpl: deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl,
    lock: createLockHolder(),
    // An unread billing config still sends billing_source "unknown".
    billing: { fields: { billing_source: BillingSource.UNKNOWN }, identity: {}, config: null, at: null, byok: null },
    chatState: null, sessionName: null, emittedCredits: {}, provisional: {}, state: null, requestErrors: [],
    // The engine a lagging recipient's replay runs on.
    engine: runVscodeCheckpoint, lagging: [], sessionIdentity: null,
  };
}

// One segment per settled request: line n is the n-th request reported, so a re-emit after a kill repeats the same segmentId.
// Same contract as runCheckpoint: never rejects; options.sessions/sink/skipFlush/persistState:false/startCursor/skipLiveTrackingGate
// /endCursor drive the audit. input: { sessionId, file?, transcriptPath? (VS Code's own hook transcript, used only to find the file), cwd?, budgetMs?,
// settleWaitMs? (SessionEnd: re-read while the request that just ended has not written its closing save; ignored on Stop),
// trigger? }.
export async function runVscodeCheckpoint(input, deps = {}, options = {}) {
  const out = newRunResult();
  return driveRun(STEPS, newContext(input, deps, options, out), vscodeTail);
}
