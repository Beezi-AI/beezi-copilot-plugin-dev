import { ENV_API_BASE, ENV_UPDATE_MANIFEST_URL } from './paths.mjs';

// BEEZI_API_URL overrides for local development; otherwise the variant's baked env.json decides,
// and a plugin without one (source checkout) talks to prod.
export function apiBase() {
  if (process.env.BEEZI_API_URL != null) return process.env.BEEZI_API_URL;
  if (ENV_API_BASE != null) return ENV_API_BASE;
  return "https://beezi-api-prod.azurewebsites.net/api";
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
// lifetime and every later refresh submits nothing (finding 7). Registration and the
// authorization request both send exactly this string.
export const OAUTH_SCOPES = "email profile offline_access";

// The Beezi REST surface, in one place. Paths are relative to apiBase().
export const ENDPOINTS = Object.freeze({
  sessionsReport: "/sessions/report",
  // Chunked backfill of past sessions (runs at the end of /beezi-local-login); duplicates are absorbed by the
  // server's upsert keys, and /complete seals the one-time pull.
  sessionsBackfill: "/sessions/backfill",
  sessionsBackfillComplete: "/sessions/backfill/complete",
  // Repeatable history sync (/beezi-local-sync). /coverage reports how far each session already reaches,
  // and the client resumes from there so a re-send is never narrower than what is stored.
  sessionsSync: "/sessions/sync",
  sessionsCoverage: "/sessions/coverage",
  sessionErrors: "/sessions/errors",
  sessionsTimeline: "/sessions/timeline",
  reposStatus: "/repos/status",
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
