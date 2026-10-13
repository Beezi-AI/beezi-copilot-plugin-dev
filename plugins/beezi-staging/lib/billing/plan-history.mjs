// The dated plan history in billing.json: each superseded observed plan with the instant it stopped applying, per
// GitHub account, so a late or backfilled report resolves the plan its session ran on. Pure.
import { isPlain, str } from '../core/guards.mjs';

const MAX_ENTRIES = 24;

function instantMs(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

function validEntry(entry) {
  return isPlain(entry) && str(entry.plan) != null && Number.isFinite(Date.parse(entry.to)) ? { plan: entry.plan, to: entry.to } : null;
}

// { [key]: [{ plan, to }] } oldest first; a key with no valid entry is dropped.
export function normalizePlanHistory(raw) {
  const history = {};
  if (!isPlain(raw)) return history;
  for (const key of Object.keys(raw)) {
    if (!Array.isArray(raw[key])) continue;
    const entries = raw[key].map(validEntry).filter((e) => e != null).sort((a, b) => Date.parse(a.to) - Date.parse(b.to));
    if (entries.length > 0) history[key] = entries.slice(-MAX_ENTRIES);
  }
  return history;
}

// Two normalized histories as one: per key, every distinct { plan, to } oldest first, the newest MAX_ENTRIES kept.
export function mergePlanHistory(a, b) {
  const merged = {};
  for (const source of [a, b]) {
    if (!isPlain(source)) continue;
    for (const key of Object.keys(source)) if (Array.isArray(source[key])) merged[key] = (merged[key] || []).concat(source[key]);
  }
  for (const key of Object.keys(merged)) {
    const seen = new Set();
    merged[key] = merged[key].filter((e) => {
      const id = isPlain(e) ? `${e.plan}|${e.to}` : null;
      if (id == null || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return normalizePlanHistory(merged);
}

// The history with key's `plan` closed at `to`; the newest MAX_ENTRIES are kept.
export function closePlan(history, key, plan, to) {
  const entries = Array.isArray(history[key]) ? history[key] : [];
  return { ...history, [key]: entries.concat([{ plan, to }]).slice(-MAX_ENTRIES) };
}

// The observed plan in force at `at` (ISO or ms): the first history entry `at` precedes, else the current entry. An instant
// before every entry gets the earliest known plan. → { plan, since } (since null when its start is unknown) or null.
export function observedAt(current, entries, at) {
  const atMs = at == null ? NaN : instantMs(at);
  const list = Array.isArray(entries) ? entries : [];
  if (Number.isFinite(atMs)) {
    for (let i = 0; i < list.length; i += 1) {
      if (atMs < Date.parse(list[i].to)) return { plan: list[i].plan, since: i === 0 ? null : list[i - 1].to };
    }
  }
  return isPlain(current) ? { plan: current.plan, since: str(current.capturedAt) } : null;
}
