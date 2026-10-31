import { STALE_MS } from "./limits.ts";

/** A device id may sign in again only with the key it registered; anything else is a takeover attempt. */
export const keyChanged = (existingPublicKey: string | undefined, publicKey: string): boolean =>
  existingPublicKey !== undefined && existingPublicKey !== publicKey;

/** Tokens issued before the device (re)registered stay dead after a revoke and fresh sign-in. */
export const issuedAfterRegistration = (iat: number, registeredAt: number): boolean => iat >= registeredAt;

/**
 * Tokens carry the device row's `gen` (random, set on a fresh insert, so a revoke + re-register in the same second still kills old tokens).
 * Tokens without one (issued before gen existed) fall back to the iat check.
 */
export const tokenCurrent = (claim: { gen?: number; iat: number }, row: { gen: number; registered_at: number }): boolean =>
  claim.gen === undefined ? issuedAfterRegistration(claim.iat, row.registered_at) : claim.gen === row.gen;

/** A socket is stale when its last ping (or its join, before the first ping) is STALE_MS old or more. */
export const isStale = (lastActivityMs: number, nowMs: number): boolean => nowMs - lastActivityMs >= STALE_MS;

/** A `{kind:"host"}` frame that repeats the stored value writes nothing and broadcasts nothing. */
export const hostChanged = (stored: number | undefined, enabled: boolean): boolean => stored !== (enabled ? 1 : 0);
