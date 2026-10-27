import { BEEZI_ENV, ENV_API_BASE, ENV_UPDATE_MANIFEST_URL } from './paths.mjs';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// True for an https URL or an http one on a loopback host: the only overrides a prod build may send a token to.
export function isSafeApiOverride(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.indexOf(parsed.hostname) !== -1);
  } catch {
    return false;
  }
}

// BEEZI_API_URL overrides for local development (in a prod build only when https or loopback); otherwise the
// variant's baked env.json decides, and a plugin without one (source checkout) talks to prod.
export function apiBase(env = process.env, envName = BEEZI_ENV) {
  const override = env.BEEZI_API_URL;
  if (override != null && (envName !== '' || isSafeApiOverride(override))) return override;
  if (ENV_API_BASE != null) return ENV_API_BASE;
  return "https://api.beezi.ai/api";
}

// Prod logins made before the API moved pinned the old host; both name the same Clerk issuer, so the pin reads as the new one.
export const LEGACY_PRODUCTION_API_ORIGIN = 'https://beezi-api-prod.azurewebsites.net';
export const PRODUCTION_API_ORIGIN = 'https://api.beezi.ai';

// A stored API base as the prod build reads it: the legacy prod base compares as the current prod base, never apiBase().
export function storedApiBase(stored, envName = BEEZI_ENV) {
  return envName === '' && stored === `${LEGACY_PRODUCTION_API_ORIGIN}/api` ? `${PRODUCTION_API_ORIGIN}/api` : stored;
}

// Origin of the API host — the OAuth discovery documents are mounted at the
// root, outside the /api prefix.
export function apiOrigin() {
  return new URL(apiBase()).origin;
}

// BEEZI_UPDATE_MANIFEST_URL overrides for local verification; otherwise the variant's baked
// env.json decides. Unlike apiBase() there is NO hard-coded fallback: a variant built before this
// key existed must stay silent rather than compare itself against another environment's manifest.
export function updateManifestUrl() {
  if (process.env.BEEZI_UPDATE_MANIFEST_URL != null) return process.env.BEEZI_UPDATE_MANIFEST_URL;
  return ENV_UPDATE_MANIFEST_URL;
}

// offline_access is what earns a refresh token: without it the grant lasts one access-token
// lifetime and every later refresh submits nothing. Registration and the
// authorization request both send exactly this string.
export const OAUTH_SCOPES = "email profile offline_access";

// The Beezi REST surface, in one place. Paths are relative to apiBase().
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  // Chunked backfill of past sessions (runs at the end of /beezi-staging-login); duplicates are absorbed by the
  // server's upsert keys, and /complete seals the one-time pull.
  sessionsBackfill: "/sessions/backfill",
  sessionsBackfillComplete: "/sessions/backfill/complete",
  // Repeatable history sync (/beezi-staging-sync). /coverage reports how far each session already reaches,
  // and the client resumes from there so a re-send is never narrower than what is stored.
  sessionsSync: "/sessions/sync",
  sessionsCoverage: "/sessions/coverage",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  whoami: "/me/copilot/whoami",
  machine: "/me/copilot/machine",
  usageSnapshot: "/me/copilot/usage",
  // Vendor-generic on purpose (Codex reports here too): the server reads the vendor off the
  // X-Beezi-Agent header postJson already sends.
  accountSync: "/me/cli-agent/account",
  // Plugin health, not user analytics: separate route, separate table, consent-gated client-side.
  pluginDiagnostics: "/cli-agent/plugin-diagnostics",
  // Authorization-free ingestion: losing OAuth must not also lose the evidence about losing it.
  // Nothing authenticated is ever sent here (see lib/diagnostics-transport.mjs).
  pluginDiagnosticsPublic: "/cli-agent/plugin-diagnostics/public",
  // The one AUTHENTICATED half: associates this installation's random ID with the caller's
  // account, and only after the user opted into correlation separately.
  pluginDiagnosticsInstallation: "/cli-agent/plugin-diagnostics/installation",
});

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
