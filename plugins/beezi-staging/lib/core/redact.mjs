// Owns redaction of free text that leaves the machine: secret shapes, emails and absolute paths become an ellipsis.

const KEY_NAMES = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret';
const SECRETS = [
  // URL userinfo up to its last @, so a password holding an unencoded @ goes too.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s/]*@/gi,
  // Token-only userinfo (https://<token>@host); after the line above, so a password holding an @ never leaves a tail.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi,
  new RegExp(`"[\\w-]*(?:${KEY_NAMES})"\\s*:\\s*(?:"[^"]*"|[^\\s,}]+)`, 'gi'),
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Well-known vendor prefixes (GitLab, Stripe, npm, Hugging Face, PyPI, Google OAuth, Shopify, DigitalOcean), each with its minimum body.
  /\bgl(?:pat|dt|rt|ptt|ft)-[A-Za-z0-9_-]{20,}/g,
  /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})/g,
  /\b(?:npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{50,}|ya29\.[A-Za-z0-9_-]{20,}|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|dop_v1_[a-f0-9]{64})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // A prefixed name (DB_PASSWORD, refresh_token, accessToken) counts; max_tokens and tokenizer do not.
  new RegExp(`\\b[\\w-]*(?:${KEY_NAMES})\\s*[:=]\\s*\\S+`, 'gi'),
  /\b(?:password|passwd|passphrase|pwd)\s+(?:is|was)\s+\S+/gi,
  /\b[0-9a-f]{32,}\b/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  /[A-Za-z0-9+/_=-]{40,}/g,
];

// A URL keeps its host and path; its query and fragment (tokens, codes) are blanked.
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`)\]]*)[?#][^\s"'`)\]]*/gi;

const ROOTS = 'Users|home|root|private|var|tmp|opt|mnt|Volumes|srv|workspaces|etc|data|app|usr';
const PATH_START = [
  '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]',
  '\\\\\\\\[^\\s\\\\]+\\\\',
  `(?<![A-Za-z0-9._~-])\\/(?:${ROOTS})\\/`,
  '(?<=^|[\\s"\'(=`[<])~[\\\\/]',
  '(?<=^|[\\s"\'(=`[<])\\/[A-Za-z0-9._-]+\\/',
].join('|');
// A space continues the path only when the next word reaches another separator (C:\Users\John Smith\x).
const PATH_TAIL = '[^\\s"\'`)\\]]*(?: +[^\\s"\'`)\\]\\\\/]+[\\\\/][^\\s"\'`)\\]]*)*';
const ABSOLUTE_PATH = new RegExp(`(?:${PATH_START})${PATH_TAIL}`, 'g');

// Free text that leaves the machine (a provider's error message): secret shapes, emails and absolute paths blanked, nothing else changed.
export function redactText(raw) {
  if (typeof raw !== 'string') return raw;
  let t = raw.replace(URL_QUERY, '$1…');
  for (const re of SECRETS) t = t.replace(re, '…');
  return t.replace(ABSOLUTE_PATH, '…');
}
