// The portal's /sessions/report DTO length caps and the clamp that applies them at the source.

// Server-side DTO caps. One over-long field 400s the whole request (and on the batch route the
// whole 50-session chunk), so clamp at the source. `remote` is deliberately NOT clamped: a
// truncated remote would fabricate a bogus repo key — let it be rejected honestly.
export const clamp = (value, max) =>
  typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
export const BRANCH_MAX = 255;
export const AGENT_NAME_MAX = 200;
export const AGENT_TYPE_MAX = 100;
export const SEGMENT_ID_MAX = 200;
