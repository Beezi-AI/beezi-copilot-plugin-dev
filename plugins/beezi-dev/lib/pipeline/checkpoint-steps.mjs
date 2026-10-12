// Checkpoint steps outside the window math: error parking, billing and account binding, server start, name replay, the tail.
import crypto from 'crypto';
import { readBillingConfig } from '../billing/billing-config.mjs';
import { resolveBilling } from '../billing/plan-resolution.mjs';
import { accountStamp } from '../billing/identity-stamp.mjs';
import { readCachedQuota } from '../billing/quota/cache.mjs';
import { establishStart } from '../delivery/coverage.mjs';
import { maybePostUsageSnapshot } from '../delivery/usage-snapshots.mjs';
import { flushPlans } from '../delivery/queue-flush.mjs';
import { countPostable } from '../delivery/flush-guard.mjs';
import { queueDir } from '../config/paths.mjs';
import { resolveSessionIdentity, SessionIdentityStatus } from '../billing/session-identity.mjs';
import { dedupeErrors, deliverErrors, errorKey, isSettledPost, parkErrors, validError } from '../delivery/session-errors.mjs';
import { accountBinding, loadSessionState, saveSessionState } from '../state/session-state.mjs';
import { expandTargets } from '../workspace/targets.mjs';
import { collectErrors } from '../capture/collectors/errors.mjs';
import { buildTimeline } from '../capture/timeline.mjs';
import { readTimelineMarkers } from '../state/timeline-markers.mjs';
import { postSessionTimeline } from '../delivery/timeline-post.mjs';
import { CONTINUE } from './run-skeleton.mjs';

const ERROR_POST_TIMEOUT_MS = 3000;

// An audit reads only the stored usage mode; every cursor-bound field starts empty so it never inherits live progress.
function auditState(loaded) {
  return {
    ...loaded,
    cursorLine: null,
    cursorEvent: null,
    cursorTrail: [],
    lastUsageRowId: 0,
    reportedShutdownLines: [],
    coveredIntervals: [],
    lastReport: null,
    sessionName: null,
    pendingErrors: [],
    timelineHash: null,
    subagents: {},
    reportedCheckpoint: null,
    pendingShutdown: false,
    vscodeEmitted: {},
    errorCursorLine: 0,
  };
}

export function loadRunState(sessionId, live) {
  const loaded = loadSessionState(sessionId);
  return live ? loaded : auditState(loaded);
}

// Reads the run's one billing config; a failed read keeps the engine's starting fields.
export function readBilling(ctx) {
  try { ctx.billing.config = readBillingConfig(); } catch { ctx.errors.push('collector:billing'); }
}

// Resolves fields and identity from the run's config for account (null: the machine's own) at the session's start
// (billing.at) with its BYOK verdict (billing.byok); `omit` stamps no account and keeps only the billing
// source, since the current account's plan would be a guess.
function stampBilling(ctx, account, omit = false) {
  const billing = ctx.billing;
  if (billing.config == null) return;
  try {
    const fields = resolveBilling({ config: billing.config, account, at: billing.at, byok: billing.byok });
    billing.fields = omit ? { billing_source: fields.billing_source } : fields;
    billing.identity = omit ? {} : accountStamp({ sessionId: ctx.sessionId, config: billing.config, account });
  } catch { ctx.errors.push('collector:billing'); }
}

// One billing config per run, stamped by bindAccount once the session's account is known.
export function snapshotBilling(ctx) {
  readBilling(ctx);
  return CONTINUE;
}

// One account per session: a lagging replay's `options.identity` from its live run, else the saved binding, else
// billing/session-identity's answer for `input` (its surface, events, vscodeSession, ownProcess, env; null keeps an audit
// on the machine's account). Only evidence is saved, by a live run; with no evidence the current account stands, unless
// several are known, when the report names none. The answer is kept on ctx.sessionIdentity as { status, key }.
export async function bindAccount(ctx, input) {
  const given = ctx.options == null ? null : ctx.options.identity;
  const saved = ctx.state.accountKey;
  if (given != null) {
    ctx.sessionIdentity = given;
  } else if (saved != null || input == null) {
    ctx.sessionIdentity = { status: saved == null ? SessionIdentityStatus.CURRENT : SessionIdentityStatus.BOUND, key: saved };
  } else {
    ctx.sessionIdentity = await resolveIdentity(ctx, input);
  }
  return stampBilling(ctx, ctx.sessionIdentity.key, ctx.sessionIdentity.status === SessionIdentityStatus.OMIT);
}

// Resolves an unbound session's account and saves a live run's evidence; → { status, key }.
async function resolveIdentity(ctx, input) {
  const resolve = ctx.deps.resolveSessionIdentity == null ? resolveSessionIdentity : ctx.deps.resolveSessionIdentity;
  let found = { status: SessionIdentityStatus.CURRENT, account: null };
  try { found = await resolve({ sessionId: ctx.sessionId, ...input }); } catch { ctx.errors.push('collector:identity'); }
  const key = found.account == null ? null : found.account.key;
  if (found.status === SessionIdentityStatus.BOUND && ctx.live) saveSessionState(ctx.sessionId, accountBinding(key, found.account.source));
  return { status: found.status, key };
}

// Parks the hook's errors in the session state before the lock is taken, so a busy run still keeps them.
export function parkHookErrors(ctx) {
  if (ctx.hookErrors.length > 0 && ctx.live) {
    saveSessionState(ctx.sessionId, (cur) => ({ pendingErrors: parkErrors(cur.pendingErrors, ctx.hookErrors) }));
  }
}

// The start line the server has already covered for a resumed session, or null after pushing the server's reason. Each
// recipient whose own prefix lags it is kept on ctx.lagging for its own replay after the run.
export async function establishFromServer(ctx) {
  const establish = ctx.deps.establishStart == null ? establishStart : ctx.deps.establishStart;
  let est = null;
  try { est = await establish(ctx.sessionId, await ctx.delivery.authorize(), { timeoutMs: ctx.clock.cap(3000) }); } catch { est = null; }
  if (est == null || !Number.isInteger(est.startLine) || est.startLine < 0) {
    if (est != null && typeof est.reason === 'string') ctx.errors.push(est.reason);
    return null;
  }
  ctx.lagging = Array.isArray(est.lagging) ? est.lagging.map((lag) => ({ ...lag, endLine: est.startLine })) : [];
  return est.startLine;
}

const tenantOf = (s) => (s.tenantId == null ? null : s.tenantId);

// Each lagging recipient replays the lines between its own prefix and the run's start into its own queue only, as an
// audit run (no state, no flush) of the same engine once the session lock is free. Best-effort inside the run's budget.
async function replayLagging(ctx) {
  if (!ctx.live || ctx.lagging.length === 0) return;
  const senders = await ctx.delivery.authorize();
  for (const lag of ctx.lagging) {
    const left = ctx.clock.timeLeft();
    if (left != null && left <= 0) return;
    const recipient = senders.find((s) => s.key === lag.key && tenantOf(s) === lag.tenantId);
    if (recipient == null) continue;
    const input = { sessionId: ctx.sessionId, transcriptPath: ctx.transcript, file: ctx.file, budgetMs: left };
    // The replay stamps the live run's account answer, never a fresh one: an omitted account stays omitted.
    const options = { persistState: false, startCursor: lag.startLine, endCursor: lag.endLine, sessions: [recipient], skipFlush: true, identity: ctx.sessionIdentity };
    const out = await ctx.engine(input, ctx.deps, options);
    if (out.outcome !== 'committed') ctx.errors.push(`lagging-replay:${out.reason}`);
  }
}

// Replays the last report when only the session name changed.
export function replayName(ctx) {
  const { state, sessionName } = ctx;
  if (ctx.live && ctx.out.segmentsQueued === 0 && sessionName != null && sessionName !== state.sessionName && state.lastReport != null) {
    try {
      ctx.delivery.emit({ ...state.lastReport, session_name: sessionName });
      ctx.namePatch = sessionName;
    } catch { /* best-effort; retried next checkpoint */ }
  }
  return CONTINUE;
}

// The CLI window's session.error records (an activity-free session's too).
function windowErrors(ctx) {
  try {
    return collectErrors(ctx.consumed || ctx.errorOnly ? ctx.windowEvents : [], {
      sessionId: ctx.sessionId, cwd: ctx.cwd, isSubagent: false, state: ctx.state, allEvents: ctx.events, hookErrors: ctx.hookErrors,
    });
  } catch {
    ctx.errors.push('collector:errors');
    return [];
  }
}

// `found` errors plus parked ones, posted to every live target (an audit collects them instead); credentials are read only
// when there is something to post. → { delivered, undelivered, changed }.
export async function settleSessionErrors(ctx, found) {
  const { sessionId, state } = ctx;
  const fresh = (Array.isArray(found) ? found : []).filter(validError).map((e) => ({ ...e, sessionId }));
  if (ctx.options.collectSessionErrors) {
    ctx.out.sessionErrors.push(...fresh);
  } else if (ctx.live) {
    const candidates = dedupeErrors([...state.pendingErrors, ...fresh]);
    if (candidates.length === 0) return { delivered: new Set(), undelivered: [], changed: false };
    const targets = expandTargets(await ctx.delivery.authorize(), ctx.delivery.workspaceState);
    const { timeLeft, cap } = ctx.clock;
    const { delivered, undelivered } = await deliverErrors(candidates, targets, sessionId, { fetchImpl: ctx.fetchImpl, timeLeft, timeoutMs: () => cap(ERROR_POST_TIMEOUT_MS) });
    const known = new Set(state.pendingErrors.map(errorKey));
    return { delivered, undelivered, changed: delivered.size > 0 || undelivered.some((e) => !known.has(errorKey(e))) };
  }
  return { delivered: new Set(), undelivered: [], changed: false };
}

// The parked-errors patch after a settlement: errors parked meanwhile by a busy run survive; only what was delivered leaves.
export function parkedErrorsPatch(cur, settled) {
  return settled.changed ? { pendingErrors: parkErrors(cur.pendingErrors.filter((e) => !settled.delivered.has(errorKey(e))), settled.undelivered) } : {};
}

// The whole-session timeline, re-posted only when its content changed; → the hash to remember, or null.
async function postTimeline(ctx) {
  const left = ctx.clock.timeLeft();
  if (!(ctx.withTimeline && ctx.consumed && ctx.live && (left == null || left > 0))) return null;
  const liveSenders = await ctx.delivery.authorize();
  if (liveSenders.length === 0) return null;
  const senders = ctx.delivery.senders;
  try {
    const timeline = buildTimeline(ctx.sessionId, ctx.events, readTimelineMarkers(ctx.sessionId));
    if (timeline == null || !(timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) return null;
    // The sender list is part of the hash so a newly answered workspace still gets the timeline; generated_at never is.
    const senderSig = senders.map((s) => `${s.key}:${s.tenantId}`).sort().join(',');
    const hash = crypto.createHash('sha1')
      .update(JSON.stringify([timeline.periods, timeline.plan_events, timeline.subagents, senderSig]))
      .digest('hex');
    if (hash === ctx.state.timelineHash) return null;
    const results = await Promise.all(liveSenders.map((s) => postSessionTimeline(timeline, s, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.clock.cap(ERROR_POST_TIMEOUT_MS) })));
    // Only remembered once every account has an answer that will not change, so a failed post retries next turn.
    if (liveSenders.length === senders.length && results.every(isSettledPost)) return hash;
  } catch { ctx.errors.push('timeline-failed'); }
  return null;
}

// The monthly quota snapshot; the checkpoint never starts the Copilot runtime inline.
async function postQuota(ctx) {
  const left = ctx.clock.timeLeft();
  if (!(ctx.withQuota && ctx.live && (left == null || left > 1000))) return;
  if ((await ctx.delivery.authorize()).length === 0) return;
  const senders = ctx.delivery.senders;
  try {
    const quota = readCachedQuota();
    await maybePostUsageSnapshot({ sessions: senders, quota, budgetMs: ctx.clock.timeLeft(), fetchImpl: ctx.fetchImpl });
  } catch { ctx.errors.push('quota-failed'); }
}

// An activity-free session's errors are delivered or parked by now, so its error cursor moves past them.
function patchAfterTail(ctx, settled, timelineHash) {
  if (!(ctx.live && (settled.changed || timelineHash != null || ctx.namePatch != null || ctx.errorOnly))) return;
  const lock = ctx.lock.current();
  if (lock != null) lock.touch();
  const namePatch = ctx.namePatch;
  saveSessionState(ctx.sessionId, (cur) => ({
    ...parkedErrorsPatch(cur, settled),
    ...(timelineHash == null ? {} : { timelineHash }),
    ...(namePatch == null ? {} : { sessionName: namePatch }),
    ...(ctx.errorOnly ? { errorCursorLine: Math.max(cur.errorCursorLine, ctx.toLine) } : {}),
  }));
}

// A flush is due when a planned account's queue holds a report; only then are the credentials read.
function flushDue(ctx) {
  return !ctx.options.skipFlush && ctx.delivery.plans.some((p) => countPostable(queueDir(p.session.key)) > 0);
}

// Drains every planned account's queue when a flush is due.
async function flushRun(ctx) {
  if (!flushDue(ctx)) return;
  await ctx.delivery.authorize();
  ctx.out.flushed = await flushPlans(ctx.delivery.plans, { fetchImpl: ctx.fetchImpl, deadline: ctx.clock.deadline, getAccessToken: ctx.deps.getAccessToken, errors: ctx.errors });
}

// The CLI tail every exit with tail:true runs: errors, timeline, quota, second patch, then closeRun.
export async function runTail(ctx) {
  if (ctx.state == null) ctx.state = loadRunState(ctx.sessionId, ctx.live);
  const settled = await settleSessionErrors(ctx, windowErrors(ctx));
  const timelineHash = await postTimeline(ctx);
  await postQuota(ctx);
  patchAfterTail(ctx, settled, timelineHash);
  await closeRun(ctx);
}

// The end of every tail: repo-map save, unlock, the lagging recipients' replays, then the flush unlocked.
export async function closeRun(ctx) {
  if (ctx.live) ctx.repo.persist();
  ctx.lock.release();
  await replayLagging(ctx);
  await flushRun(ctx);
}
