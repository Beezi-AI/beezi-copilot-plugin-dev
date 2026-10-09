import fs from 'fs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { recordIssue } from './telemetry.mjs';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './telemetry-codes.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { resolveBilling, BillingSource } from './billing.mjs';
import { accountStamp } from './identity-stamp.mjs';
import { acquireSessionLock, isUsableSessionId, loadSessionState, saveSessionState } from './session-state.mjs';
import { projectInstructions } from './project-instructions.mjs';
import { establishStart as _establishStart } from './session-coverage.mjs';
import { findVscodeSessionFile, readVscodeSession, hasVscodeActivity } from './vscode-chat-session.mjs';
import { resolveVscodeAccount } from './vscode-account.mjs';
import { planDelivery, flushPlans, localRemote, UNKNOWN_REMOTE, clamp, BRANCH_MAX, detectTimezone } from './checkpoint.mjs';

// VS Code Local-agent sessions through the same recipients, queue and flush as the Copilot CLI checkpoint.
// One segment per settled request: line n is the n-th request reported, so a re-emit after a kill repeats the same segmentId.

export const VSCODE_USAGE_SOURCE = 'vscode_request';
const CLIENT_SURFACE = 'vscode';
const DEFAULT_ORIGINATOR = 'GitHub.copilot-chat';
const ORIGINATOR_MAX = 100;
const CLI_VERSION_MAX = 50;
const SESSION_NAME_MAX = 500;
// A completed request whose closing save (elapsedMs) never landed is settled once the file has been quiet this long.
const SETTLE_IDLE_MS = 5 * 60 * 1000;
const SETTLE_POLL_MS = 500;

function nonEmpty(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function isFile(p) {
  try { return typeof p === 'string' && p !== '' && fs.statSync(p).isFile(); } catch { return false; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(ms) {
  return typeof ms === 'number' && isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The request's identity in `reported`; the index stands in only when VS Code wrote no requestId.
export function requestKey(r) {
  return r.requestId != null ? r.requestId : `#${r.index}`;
}

// Billable now: finished, and its usage counters final (the closing save, or a quiet file).
function isSettled(r, idle) {
  return r.completed === true && (r.elapsedMs != null || idle);
}

// True while the newest request is running or its closing save has not landed yet.
function newestUnsettled(session) {
  const last = session.requests.length > 0 ? session.requests[session.requests.length - 1] : null;
  return last != null && !(last.completed === true && last.elapsedMs != null);
}

// The reported prefix of an audit or an established start: the first k requests in file order, or null when k overshoots.
function prefixBase(requests, k) {
  if (k > requests.length) return null;
  return { cursor: k, reported: requests.slice(0, k).map(requestKey) };
}

// The local cursor of a VS Code session (requests reported), or null when none is stored.
export function vscodeCursorOf(sessionId) {
  const v = loadSessionState(sessionId).vscode;
  return v == null ? null : v.cursor;
}

// A request's own model: the last round's, else model (resolved, then the requested modelId with 'copilot/' stripped and 'auto' dropped).
function ownModel(r) {
  return r.roundModel || r.model;
}

// Model per request index, borrowing the nearest earlier request's, else the nearest later one's; null when no request has one.
function sessionModels(requests) {
  const own = requests.map(ownModel);
  const out = new Array(requests.length).fill(null);
  let prev = null;
  for (let i = 0; i < own.length; i++) {
    if (own[i] != null) prev = own[i];
    out[i] = prev;
  }
  let next = null;
  for (let i = own.length - 1; i >= 0; i--) {
    if (own[i] != null) next = own[i];
    if (out[i] == null) out[i] = next;
  }
  return out.length > 0 && out[0] != null ? out : null;
}

function modelUsage(r) {
  const input = r.promptTokens == null ? 0 : r.promptTokens;
  const output = r.outputTokens == null ? 0 : r.outputTokens;
  const usage = {
    token_input: input,
    token_output: output,
    token_cache_read: 0,
    token_cache_creation: 0,
    requests: r.calls != null ? r.calls : (input + output > 0 ? 1 : 0),
  };
  // copilotCredits is in AI credits; the report carries nano AIU, a measured 0 included, an unmeasured one absent.
  if (r.credits != null) usage.ai_credits_nano = Math.min(Number.MAX_SAFE_INTEGER, Math.round(r.credits * 1e9));
  // Without credits, the details multiplier is the premium requests this one user request billed, a measured 0 included.
  else if (r.multiplier != null) usage.premium_requests = r.multiplier;
  return usage;
}

// Same contract as runCheckpoint: never rejects; options.sessions/sink/skipFlush/persistState:false/startCursor/skipLiveTrackingGate
// drive the audit. input: { sessionId, file?, transcriptPath? (VS Code's own hook transcript, used only to find the file), cwd?, budgetMs?,
// settleWaitMs? (turn end: re-read while the request that just ended has not written its closing save) }.
export async function runVscodeCheckpoint(input, deps = {}, options = {}) {
  const gitImpl = deps.gitImpl == null ? git : deps.gitImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const establishStart = deps.establishStart == null ? _establishStart : deps.establishStart;
  const errors = [];
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false, usageHeld: false, cursorMismatch: false };
  const out = { segmentsQueued: 0, flushed: 0, errors, outcome: 'failed', reason: null, sessionErrors: [], skipped, gated: false };
  const finish = (outcome, reason) => {
    out.outcome = outcome;
    out.reason = reason == null ? null : reason;
  };
  let lock = null;
  const unlock = () => {
    if (lock != null) {
      const held = lock;
      lock = null;
      held.release();
    }
  };

  const run = async () => {
    const inp = input != null && typeof input === 'object' ? input : {};
    const sessionId = inp.sessionId != null ? inp.sessionId : inp.session_id;
    const hint = inp.transcriptPath != null ? inp.transcriptPath : inp.transcript_path;
    const budgetMs = typeof inp.budgetMs === 'number' && inp.budgetMs > 0 ? inp.budgetMs : null;
    const live = options.persistState !== false;
    const deadline = budgetMs == null ? null : Date.now() + budgetMs;
    const cap = (ms) => (deadline == null ? ms : Math.max(1, Math.min(ms, deadline - Date.now())));
    if (!isUsableSessionId(sessionId)) {
      finish('failed', 'unnamed-session');
      return;
    }

    // The chat session file: the caller's, the one stored for this id, else a lookup by id.
    const stored = loadSessionState(sessionId).vscode;
    let file = null;
    for (const candidate of [inp.file, stored == null ? null : stored.file]) {
      if (isFile(candidate)) { file = candidate; break; }
    }
    if (file == null) file = findVscodeSessionFile(sessionId, nonEmpty(hint));
    let session = file == null ? null : readVscodeSession(file);
    if (session == null || session.sessionId !== sessionId) {
      finish('failed', 'no-transcript');
      return;
    }
    // A turn-end hook can run before VS Code saves the request it ends; a short re-read bills it now instead of next time.
    const settleWaitMs = typeof inp.settleWaitMs === 'number' && inp.settleWaitMs > 0
      ? Math.min(inp.settleWaitMs, budgetMs == null ? inp.settleWaitMs : budgetMs / 2)
      : 0;
    const settleUntil = Date.now() + settleWaitMs;
    while (newestUnsettled(session) && Date.now() + SETTLE_POLL_MS <= settleUntil) {
      await sleep(SETTLE_POLL_MS);
      const again = readVscodeSession(file);
      if (again != null && again.sessionId === sessionId) session = again;
    }
    // A session with no model anywhere has nothing billable yet: nothing uploads and no state is kept.
    const modelOf = sessionModels(session.requests);
    if (!hasVscodeActivity(session) || modelOf == null) {
      finish('deferred', 'no-activity');
      return;
    }
    const cwd = session.folder || nonEmpty(inp.cwd) || (stored == null ? null : stored.cwd);

    const delivery = await planDelivery(sessionId, { deps, options, bindCwd: () => cwd });
    if (delivery.stop != null) {
      if (delivery.stop === 'tracking-gated') out.gated = true;
      finish('deferred', delivery.stop);
      return;
    }
    const { plans, liveSenders, emit } = delivery;
    let billingConfig = null;
    try { billingConfig = readBillingConfig(); } catch { errors.push('collector:billing'); }
    let mapDirty = false;
    const map = loadRepoMap();

    locked: {
      lock = await acquireSessionLock(sessionId, { waitMs: budgetMs == null ? 10000 : Math.min(2000, budgetMs / 4) });
      if (lock == null) {
        finish('deferred', 'session-busy');
        return;
      }
      const loaded = loadSessionState(sessionId);
      const state = live ? loaded.vscode : null;

      // One account per session: the saved binding, else the Copilot Chat log or state.vscdb answer, saved once by a live run.
      // Unresolved falls back to the account Copilot is signed in as now.
      let accountKey = loaded.accountKey;
      if (accountKey == null) {
        const found = await resolveVscodeAccount(session);
        if (found != null) {
          accountKey = found.key;
          if (live) saveSessionState(sessionId, { accountKey: found.key, accountSource: found.source });
        }
      }
      let billingFields = { billing_source: BillingSource.UNKNOWN };
      let identity = {};
      if (billingConfig != null) {
        try {
          billingFields = resolveBilling({ config: billingConfig, account: accountKey });
          identity = accountStamp({ sessionId, config: billingConfig, account: accountKey });
        } catch { errors.push('collector:billing'); }
      }

      // Where reporting resumes: the requests already reported and the last line used.
      const requests = session.requests;
      const requested = Number.isInteger(options.startCursor) && options.startCursor >= 0 ? options.startCursor : null;
      let base;
      if (!live) {
        base = prefixBase(requests, requested == null ? 0 : requested);
      } else if (state != null) {
        base = { cursor: state.cursor, reported: state.reported.slice() };
        // A server prefix past the local one (a sync landed meanwhile) counts those requests as reported too.
        if (requested != null && requested > state.cursor) {
          const ahead = prefixBase(requests, requested);
          if (ahead == null) base = null;
          else base = { cursor: requested, reported: base.reported.concat(ahead.reported.filter((k) => base.reported.indexOf(k) === -1)) };
        }
      } else {
        let start = requested;
        if (start == null) {
          let est = null;
          try { est = await establishStart(sessionId, liveSenders, { timeoutMs: cap(3000) }); } catch { est = null; }
          if (est == null || !Number.isInteger(est.startLine) || est.startLine < 0) {
            if (est != null && typeof est.reason === 'string') errors.push(est.reason);
            finish('deferred', 'unestablished');
            break locked;
          }
          start = est.startLine;
        }
        base = prefixBase(requests, start);
      }
      if (base == null) {
        skipped.cursorMismatch = true;
        if (live) recordIssue({ code: DIAGNOSTIC_CODES.CURSOR_MISMATCH, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
        finish('deferred', 'cursor-mismatch');
        break locked;
      }

      // The window: unreported requests in file order up to the first one still running or not yet final.
      let idle = false;
      try { idle = Date.now() - fs.statSync(file).mtimeMs > SETTLE_IDLE_MS; } catch { /* keep live */ }
      // A request VS Code never closed (a reload mid-turn) is final once a later one completed: chat runs one request at a time.
      const laterCompleted = [];
      let completedAfter = false;
      for (let i = requests.length - 1; i >= 0; i--) {
        laterCompleted[i] = completedAfter;
        if (requests[i].completed === true) completedAfter = true;
      }
      const reported = new Set(base.reported);
      const window = [];
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i];
        if (reported.has(requestKey(r))) continue;
        if (!isSettled(r, idle) && !laterCompleted[i]) break;
        window.push(r);
      }

      // Repository and branch from the session's folder, through the same git helpers and repo map as the CLI path.
      let root = null;
      let timeline = null;
      let headBranch = '(unknown)';
      let remote = UNKNOWN_REMOTE;
      if (window.length > 0) {
        root = resolveRepoRoot(gitImpl, cwd, new Map(), map);
        if (root != null) {
          try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
          try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
          let r = resolveOriginRemote(gitImpl, root);
          if (!r) r = originFromGitConfig(root);
          if (!r) r = knownOrigin(root, map);
          if (r) { upsertRoot(map, root, r); mapDirty = true; remote = r; }
        }
        if (remote === UNKNOWN_REMOTE) remote = localRemote(root == null ? cwd : root) || UNKNOWN_REMOTE;
      }
      const branchAt = (ms) => {
        const b = timeline != null && timeline.length > 0 && ms != null ? branchAtReflog(timeline, ms) : null;
        return b && b !== '(unknown)' ? b : headBranch;
      };
      let instructions = null;
      try { instructions = window.length > 0 ? projectInstructions(root) : null; } catch { instructions = null; }
      const timezone = detectTimezone();
      const sessionName = session.title == null ? (state == null ? null : state.sessionName) : clamp(session.title, SESSION_NAME_MAX);

      let line = base.cursor;
      const nextReported = base.reported.slice();
      let lastPayload = null;
      for (const r of window) {
        const usage = modelUsage(r);
        const payload = {
          segmentId: `${sessionId}:vsc:${line + 1}-${line + 1}`,
          sessionId,
          remote,
          branch: clamp(branchAt(r.startedAtMs), BRANCH_MAX),
          from_line: line + 1,
          to_line: line + 1,
          ...billingFields,
          ...identity,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(instructions == null ? {} : instructions),
          models: { [modelOf[r.index]]: usage },
          token_total: usage.token_input + usage.token_output,
          token_input: usage.token_input,
          token_output: usage.token_output,
          token_cache: 0,
          duration_sec: r.startedAtMs != null && r.completedAtMs != null ? Math.max(0, Math.round((r.completedAtMs - r.startedAtMs) / 1000)) : 0,
          started_at: iso(r.startedAtMs),
          ended_at: iso(r.completedAtMs != null ? r.completedAtMs : r.startedAtMs),
          ...(usage.ai_credits_nano > 0 ? { ai_credits_nano: usage.ai_credits_nano } : {}),
          usage_source: VSCODE_USAGE_SOURCE,
          source: CLIENT_SURFACE,
          originator: clamp(r.agentId || DEFAULT_ORIGINATOR, ORIGINATOR_MAX),
          ...(r.extensionVersion == null ? {} : { cli_version: clamp(r.extensionVersion, CLI_VERSION_MAX) }),
        };
        lock.touch();
        // A failed write stops the window there; the cursor covers only what is on disk.
        try { emit(payload); } catch {
          skipped.emitFailed += 1;
          break;
        }
        line += 1;
        nextReported.push(requestKey(r));
        lastPayload = payload;
        out.segmentsQueued += 1;
      }
      if (window.length > 0 && lastPayload == null) {
        finish('failed', 'emit-failed');
        break locked;
      }

      // The cursor patch, only after every queue file of the run is complete on disk.
      if (live) {
        lock.touch();
        const replayName = lastPayload == null && sessionName != null && state != null && state.lastReport != null && sessionName !== state.sessionName;
        if (replayName) {
          // Only the title changed: the last segment again under the new name (same segmentId, so an upsert).
          try { emit({ ...state.lastReport, session_name: sessionName }); } catch { /* retried next checkpoint */ }
        }
        const saved = saveSessionState(sessionId, () => ({
          vscode: {
            cursor: line,
            reported: nextReported,
            file,
            cwd: cwd == null ? null : cwd,
            lastReport: lastPayload != null ? lastPayload : (state == null ? null : state.lastReport),
            sessionName: lastPayload != null || replayName ? sessionName : (state == null ? null : state.sessionName),
          },
        }));
        if (!saved) {
          errors.push('state-write-failed');
          finish('failed', 'internal');
          break locked;
        }
      }
      finish('committed', null);
    }

    if (mapDirty && live) {
      try { saveRepoMap(map); } catch { /* best-effort */ }
    }
    unlock();
    if (!options.skipFlush) {
      out.flushed = await flushPlans(plans, { fetchImpl, deadline, getAccessToken: deps.getAccessToken, errors });
    }
  };

  try {
    await run();
  } catch (error) {
    out.outcome = 'failed';
    out.reason = 'internal';
    recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH, source: DIAGNOSTIC_SOURCES.CHECKPOINT, error });
  } finally {
    unlock();
  }
  return out;
}
