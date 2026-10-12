// The sentences the MCP bridge answers with: link and authorization states, local handshakes and failed requests.
import { AUTH_STATES } from '../contract/auth-states.mjs';

// Whether the CLI re-fetches tools on list_changed is unknown, so the messages that precede a login say how to load the tools.
const RESTART_HINT = ' Then run /restart (or start a new session) to load the Beezi tools.';
const NOT_LINKED_MESSAGE =
  `This machine is not linked to Beezi. Run /beezi-local-login, or /beezi-local-settings account to choose another linked account, then retry.${RESTART_HINT}`;
export const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Run /beezi-local-login to relink.";
// Not linked at all versus temporarily without a token are different answers, and telling a
// user with a perfectly good saved login to run /beezi-local-login is what started a destructive
// relink loop. Only `unlinked` gets the login sentence.
const RETRY_MESSAGE =
  'Beezi is renewing this machine’s authorization. Your login is saved — retry in a moment.';
const REAUTH_MESSAGE =
  'Beezi’s login server no longer accepts this machine’s saved authorization. '
  + 'Run /beezi-local-login to authorize it again, or /beezi-local-settings account to choose another account.';
// The token was kept from a URL outside the API origin its login was pinned to: a new login fixes a moved API, but
// not a BEEZI_MCP_URL override that points elsewhere.
export function originRefusedMessage(mcpUrlOverridden) {
  return mcpUrlOverridden
    ? 'Beezi did not send this machine’s login to the BEEZI_MCP_URL override: it is not the Beezi API this machine signed in to. '
      + 'Unset BEEZI_MCP_URL or point it at that API.'
    : 'This machine’s Beezi login was made for another Beezi API than this plugin now uses. Run /beezi-local-login to authorize it again.';
}
export const HIDDEN_TOOL_MESSAGE = 'Ticket creation, estimation and repository browsing are not part of the Beezi Copilot plugin.';
export const UNLINKED_INSTRUCTIONS = `Beezi tools activate after /beezi-local-login links this machine.${RESTART_HINT}`;
export const UNREACHABLE_INSTRUCTIONS = 'Beezi tools activate once the Beezi server is reachable.';
export const UNREACHABLE_MESSAGE = 'Beezi MCP request failed: the Beezi server is unreachable.';
export const STATUS_FAILED_MESSAGE = 'Beezi could not build the status report.';

export function unavailableMessage(authState) {
  if (authState === AUTH_STATES.REAUTH_REQUIRED) return REAUTH_MESSAGE;
  if (authState === AUTH_STATES.REFRESHING || authState === AUTH_STATES.UNAVAILABLE) return RETRY_MESSAGE;
  return NOT_LINKED_MESSAGE;
}

export async function serverErrorMessage(res) {
  try {
    const body = await res.json();
    // JSON-RPC errors nest under `error`; the portal's HTTP errors put the sentence at the
    // top level with `error` holding only the status name ("Forbidden"). Read both, so a
    // plan or permission refusal reaches the user in the server's own words.
    const err = body == null ? undefined : body.error;
    const errMessage = err == null ? undefined : err.message;
    const message = errMessage == null
      ? (body != null && typeof body.message === 'string' ? body.message : null)
      : errMessage;
    if (message) return `Beezi MCP error: ${message}`;
  } catch {
    /* non-JSON body */
  }
  return `Beezi MCP request failed (HTTP ${res.status}).`;
}

// A request that threw (a timeout or a dead socket), in the error's own words.
export function requestFailedMessage(error) {
  return `Beezi MCP request failed: ${error == null || error.message == null ? String(error) : error.message}`;
}
