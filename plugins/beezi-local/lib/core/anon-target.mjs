import { displayText } from './text.mjs';
import { PRIVATE_MARK, anonymizeReport } from './anonymize-payload.mjs';

const ANON_KEY = /^[0-9a-f]{64}$/;
const PAST_SKIP = 'skip';
const PAST_OFFER = 'offer';

export const ANON_KINDS = Object.freeze(['repos', 'branches', 'sessions', 'hosts', 'accounts']);

// A kinds map with a missing or non-boolean key reads as every kind on.
function parseKinds(raw) {
  const valid = raw != null && typeof raw === 'object' && ANON_KINDS.every((k) => typeof raw[k] === 'boolean');
  const kinds = {};
  for (const k of ANON_KINDS) kinds[k] = valid ? raw[k] : true;
  return kinds;
}

export function parseAnonymization(raw, tenantId) {
  if (raw == null) return null;
  return {
    tenantId: tenantId == null ? null : tenantId,
    kinds: parseKinds(raw.kinds),
    key: typeof raw.key === 'string' && ANON_KEY.test(raw.key) ? raw.key : null,
    machineName: displayText(raw.machineName),
  };
}

export function parsePastSessions(raw) {
  const block = raw != null && typeof raw === 'object' ? raw : {};
  return {
    choice: block.choice === PAST_SKIP ? PAST_SKIP : PAST_OFFER,
    changedAt: typeof block.changedAt === 'string' && Number.isFinite(Date.parse(block.changedAt)) ? block.changedAt : null,
  };
}

function fieldOf(holder, field) {
  return holder == null || holder[field] == null ? null : holder[field];
}

// The entry for tenantId, else the top level when its block names that tenant.
function namedField(session, tenants, tenantId, field) {
  const entry = tenants == null ? null : tenants.find((t) => t != null && t.id === tenantId);
  if (fieldOf(entry, field) != null) return fieldOf(entry, field);
  const top = fieldOf(session, 'anonymization');
  return tenantId != null && top != null && top.tenantId === tenantId ? fieldOf(session, field) : null;
}

// Headerless resolves as its single entry's tenant id, else reads the top level.
function resolveFor(session, tenantId, field) {
  if (session == null) return null;
  const tenants = Array.isArray(session.tenants) ? session.tenants : null;
  if (tenantId != null) return namedField(session, tenants, tenantId, field);
  if (tenants == null || tenants.length !== 1) return fieldOf(session, field);
  return namedField(session, tenants, tenants[0] == null ? null : tenants[0].id, field);
}

export function anonymizationFor(session, tenantId) {
  return resolveFor(session, tenantId, 'anonymization');
}

export function pastSessionsFor(session, tenantId) {
  return parsePastSessions(resolveFor(session, tenantId, 'pastSessions'));
}

export function kindsOf(block) {
  if (block == null) return [];
  const kinds = parseKinds(block.kinds);
  return ANON_KINDS.filter((k) => kinds[k]);
}

export function hasKind(block, kind) {
  return kindsOf(block).indexOf(kind) !== -1;
}

function kindsMapOf(on) {
  const map = {};
  for (const k of ANON_KINDS) map[k] = on.indexOf(k) !== -1;
  return map;
}

// A missing block becomes a keyless one, so every reader fails closed.
function overlaid(block, tenantId, kinds) {
  if (block == null) return { tenantId, kinds: kindsMapOf(kinds), key: null, machineName: null };
  return { ...block, kinds: kindsMapOf(unionOf(kindsOf(block), kinds)) };
}

function targetIdOf(session, tenantId) {
  if (tenantId != null) return tenantId;
  const tenants = session.tenants;
  return Array.isArray(tenants) && tenants.length === 1 && tenants[0] != null ? tenants[0].id : null;
}

// Writes into the tenant's entry, else the top level when it names that tenant or is empty, else a new entry.
function withBlock(session, tenantId, block) {
  const tenants = Array.isArray(session.tenants) ? session.tenants : null;
  const at = tenants == null ? -1 : tenants.findIndex((t) => t != null && t.id === tenantId);
  if (at !== -1) return { ...session, tenants: tenants.map((t, i) => (i === at ? { ...t, anonymization: block } : t)) };
  const top = fieldOf(session, 'anonymization');
  if (tenantId == null || top == null || top.tenantId === tenantId) return { ...session, anonymization: block };
  return { ...session, tenants: (tenants == null ? [] : tenants).concat([{ id: tenantId, anonymization: block }]) };
}

export function withHiddenKinds(session, tenantId, kinds) {
  if (kinds.length === 0) return session;
  const id = targetIdOf(session, tenantId);
  return withBlock(session, id, overlaid(anonymizationFor(session, tenantId), id, kinds));
}

export function anonymizationScope(row) {
  const scope = {};
  if (row != null && row.tenants != null) scope.tenants = row.tenants;
  if (row != null && row.anonymization != null) scope.anonymization = row.anonymization;
  if (row != null && row.pastSessions != null) scope.pastSessions = row.pastSessions;
  return scope;
}

function tenantOf(tenantId, block) {
  return tenantId != null ? tenantId : (block == null ? null : block.tenantId);
}

// The kinds in either list, in ANON_KINDS order.
export function unionOf(a, b) {
  return ANON_KINDS.filter((k) => a.indexOf(k) !== -1 || b.indexOf(k) !== -1);
}

function ownKinds(map, id) {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : [];
}

function withKinds(map, id, kinds) {
  const merged = unionOf(ownKinds(map, id), kinds);
  if (merged.length > 0) map[id] = merged;
  return map;
}

export function privateKinds(plans) {
  const byTenant = {};
  for (const p of plans) {
    for (const t of p.targets.concat(p.hold)) {
      const block = anonymizationFor(p.session, t);
      const id = tenantOf(t, block);
      if (id != null) withKinds(byTenant, id, kindsOf(block));
    }
  }
  return byTenant;
}

// The legacy array marker lists tenant ids and reads as every kind on for each.
function markerOf(payload) {
  const mark = payload[PRIVATE_MARK];
  const byTenant = {};
  if (Array.isArray(mark)) {
    for (const id of mark) withKinds(byTenant, id, ANON_KINDS);
  } else if (mark != null && typeof mark === 'object') {
    for (const id of Object.keys(mark)) withKinds(byTenant, id, Array.isArray(mark[id]) ? mark[id] : ANON_KINDS);
  }
  return byTenant;
}

function unmarked(payload) {
  const out = { ...payload };
  delete out[PRIVATE_MARK];
  return out;
}

export function markPrivate(payload, kindsByTenant) {
  const merged = markerOf(payload);
  for (const id of Object.keys(kindsByTenant)) withKinds(merged, id, kindsByTenant[id]);
  const out = unmarked(payload);
  if (Object.keys(merged).length > 0) out[PRIVATE_MARK] = merged;
  return out;
}

function unionFor(payload, block, tenantId) {
  const id = tenantOf(tenantId, block);
  return unionOf(id == null ? [] : ownKinds(markerOf(payload), id), kindsOf(block));
}

export function unionKinds(payload, session, tenantId) {
  return unionFor(payload, anonymizationFor(session, tenantId), tenantId);
}

export function reportForWire(payload, session, tenantId) {
  const block = anonymizationFor(session, tenantId);
  const kinds = unionFor(payload, block, tenantId);
  if (kinds.length === 0) return unmarked(payload);
  return block == null || block.key == null ? null : anonymizeReport(payload, block.key, kinds);
}
