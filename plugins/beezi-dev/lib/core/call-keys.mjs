// Owns the per-call stream keys shared by capture and session state. Pure.

// Prefixed so no agent id can collide with the main stream or an inherited property name.
export const MAIN_CALL_KEY = 'm';
