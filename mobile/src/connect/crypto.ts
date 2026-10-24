// End-to-end encryption between two devices of one account; byte-for-byte the same as
// src-tauri/src/remote/crypto.rs (docs/remote-access.md, "End-to-end encryption").
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const INFO = new TextEncoder().encode('pandacode-remote v1');
const NONCE = 24;
const utf8 = new TextEncoder();

export const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromBase64 = (text: string) => Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const decodeKey = (text: string): Uint8Array | null => {
  try {
    const raw = fromBase64(text);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
};

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A v4 UUID (device ids must be UUIDs for the relay). */
export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A new base64 X25519 private key. */
export const generateSecret = () => toBase64(x25519.utils.randomSecretKey());
export const decodeSecret = decodeKey;
export const publicKey = (secret: Uint8Array) => toBase64(x25519.getPublicKey(secret));

/** First 16 bytes (128 bits) of SHA-256 of the raw public key, hex; '' for a malformed key. */
export function fingerprint(publicKeyBase64: string): string {
  const raw = decodeKey(publicKeyBase64);
  return raw ? hex(sha256(raw).slice(0, 16)) : '';
}

/** HKDF-SHA256 over the X25519 secret, salted with the sorted device ids. */
export function pairKey(mine: Uint8Array, myId: string, theirPublic: string, theirId: string): Uint8Array {
  const theirs = decodeKey(theirPublic);
  if (!theirs) throw new Error("That computer's key is malformed.");
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(mine, theirs);
  } catch {
    throw new Error("That computer's key is unusable.");
  }
  // Rust refuses a non-contributory (all-zero) secret; noble throws on it, but check anyway.
  if (shared.every(b => b === 0)) throw new Error("That computer's key is unusable.");
  const salt = [myId, theirId].sort().join('|');
  return hkdf(sha256, shared, utf8.encode(salt), INFO, 32);
}

const aad = (from: string, to: string) => utf8.encode(`${from}|${to}`);

/** `base64(nonce24 || ciphertext)` with `from|to` as associated data. */
export function seal(key: Uint8Array, from: string, to: string, plaintext: string, nonce = randomBytes(NONCE)): string {
  const sealed = xchacha20poly1305(key, nonce, aad(from, to)).encrypt(utf8.encode(plaintext));
  const out = new Uint8Array(NONCE + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE);
  return toBase64(out);
}

/** Opens a body; throws on anything unreadable or forged. */
export function open(key: Uint8Array, from: string, to: string, body: string): string {
  const bytes = fromBase64(body);
  if (bytes.length < NONCE + 16) throw new Error('Unreadable frame.');
  const plain = xchacha20poly1305(key, bytes.subarray(0, NONCE), aad(from, to)).decrypt(bytes.subarray(NONCE));
  return new TextDecoder().decode(plain);
}
