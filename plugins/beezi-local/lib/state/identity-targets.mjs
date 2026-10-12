// Which targets of one Beezi account each GitHub identity's sessions were queued to (accounts/<key>/identity-targets.json),
// so that identity's quota rows and check-ins reach only the workspaces it works for. Tag '' is the headerless target and
// identity '' the sessions stamped with no GitHub account.
import path from 'path';
import { accountDir } from '../config/paths.mjs';
import { readJson, writeJsonSecure } from '../platform/fs-store.mjs';

const TARGETS_VERSION = 1;

function targetsFile(key) {
  return path.join(accountDir(key), 'identity-targets.json');
}

export function targetTag(tenantId) {
  return typeof tenantId === 'string' ? tenantId : '';
}

export function identityOf(value) {
  return typeof value === 'string' ? value : '';
}

// { <identity>: [<tag>, ...] }; anything malformed reads as nothing learned yet.
function readIdentities(key) {
  let raw = null;
  try { raw = readJson(targetsFile(key), null); } catch { /* reads as empty */ }
  const identities = Object.create(null);
  if (raw == null || raw.version !== TARGETS_VERSION || raw.identities == null || typeof raw.identities !== 'object') return identities;
  for (const identity of Object.keys(raw.identities)) {
    const tags = raw.identities[identity];
    if (Array.isArray(tags)) identities[identity] = tags.filter((tag) => typeof tag === 'string');
  }
  return identities;
}

// Records that a report stamped `identity` was queued to the account's `tenantId` target; writes only a new pair and
// returns true when it did (the moment a check-in for that identity becomes due there). Never throws.
export function rememberIdentityTarget(key, identity, tenantId) {
  try {
    const identities = readIdentities(key);
    const id = identityOf(identity);
    const tag = targetTag(tenantId);
    const tags = identities[id] == null ? [] : identities[id];
    if (tags.indexOf(tag) !== -1) return false;
    identities[id] = tags.concat([tag]);
    return writeJsonSecure(targetsFile(key), { version: TARGETS_VERSION, identities }, { createDir: false }) !== false;
  } catch {
    return false;
  }
}

// False until any report of this account was queued with its identity recorded (an upgrade from a build without the file).
export function knowsAnyIdentity(key) {
  return Object.keys(readIdentities(key)).length > 0;
}

// The identities (identityOf form) whose sessions were queued to this account's `tenantId` target.
export function targetIdentities(key, tenantId) {
  const identities = readIdentities(key);
  const tag = targetTag(tenantId);
  return new Set(Object.keys(identities).filter((identity) => identities[identity].indexOf(tag) !== -1));
}
