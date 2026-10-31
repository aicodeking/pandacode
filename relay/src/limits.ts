export const MAX_DEVICES = 10;
export const MAX_FRAME_BYTES = 256 * 1024;
/** A rate-limited frame longer than this is rejected unparsed. */
export const RATE_LIMITED_PARSE_CHARS = 4096;
export const RATE_PER_SEC = 20;
export const RATE_BURST = 100;
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_NAME_CHARS = 64;
export const MAX_PLATFORM_CHARS = 32;
export const MAX_REF_CHARS = 64;
/** A socket with no ping answered (or no join) for this long is dead. Clients ping every 30 s. */
export const STALE_MS = 75_000;
/** A push registration's device token is opaque to the relay; bounded and stored as-is. */
export const MAX_PUSH_TOKEN_CHARS = 512;
/** A device keeps at most this many push tokens (a reinstall makes a new one). */
export const MAX_PUSH_TOKENS_PER_DEVICE = 3;
/** A host's notify frame folds into an already-sent push inside this window. */
export const NOTIFY_COALESCE_MS = 30_000;
/** The notify frame's JSON body budget. */
export const MAX_NOTIFY_CHARS = 256;
