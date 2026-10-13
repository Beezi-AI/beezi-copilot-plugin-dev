// Owns the per-model usage buckets: token normalization and one tally into a model and its effort bucket.

// The server's effort column is varchar(50); a longer key 400s the whole segment.
const MAX_EFFORT_KEY = 50;

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// The value when it is a positive finite number, else 0.
export function positive(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

// True when the host sent the field at all: a measured 0 differs from a value it never reported.
export function isReported(v) {
  return typeof v === 'number' && isFinite(v);
}

export function clampInt(v) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(v)));
}

export function bucket() {
  return { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0 };
}

export function effortKey(e) {
  return typeof e === 'string' && e !== '' ? e.slice(0, MAX_EFFORT_KEY) : 'unknown';
}

// inputTokens is the whole prompt including cache reads and writes, so uncached input is the remainder; output already includes reasoning.
export function normalize(input, output, cacheRead, cacheWrite) {
  const prompt = positive(input);
  const cr = positive(cacheRead);
  const cw = positive(cacheWrite);
  return { input: Math.max(0, prompt - cr - cw), output: positive(output), cacheRead: cr, cacheWrite: cw, prompt };
}

// One tally for the model and its effort bucket, so the buckets always partition the model. A null `nano` or
// `premium` means the host never reported that measure; a number, even 0, is a measured value and is kept.
export function tally(models, model, effort, t) {
  if (!own(models, model)) models[model] = bucket();
  const m = models[model];
  if (m.by_effort == null) m.by_effort = {};
  if (!own(m.by_effort, effort)) m.by_effort[effort] = bucket();
  for (const b of [m, m.by_effort[effort]]) {
    b.token_input += t.input;
    b.token_output += t.output;
    b.token_cache_read += t.cacheRead;
    b.token_cache_creation += t.cacheWrite;
    b.requests += t.requests;
  }
  if (t.reasoning != null) {
    for (const b of [m, m.by_effort[effort]]) b.token_reasoning_output = (b.token_reasoning_output == null ? 0 : b.token_reasoning_output) + t.reasoning;
  }
  // Auto routing slice: counted only for calls the plugin could judge (per_call rows), so absent means unmeasured.
  if (t.auto != null) {
    for (const b of [m, m.by_effort[effort]]) {
      b.auto_requests = (b.auto_requests == null ? 0 : b.auto_requests) + t.auto.requests;
      if (t.auto.nano != null) b.auto_ai_credits_nano = (b.auto_ai_credits_nano == null ? 0 : b.auto_ai_credits_nano) + t.auto.nano;
    }
  }
  if (t.nano != null) m.ai_credits_nano = (m.ai_credits_nano == null ? 0 : m.ai_credits_nano) + t.nano;
  if (t.premium != null) m.premium_requests = (m.premium_requests == null ? 0 : m.premium_requests) + t.premium;
}
