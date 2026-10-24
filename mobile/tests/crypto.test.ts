/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSecret, fingerprint, fromBase64, open, pairKey, publicKey, seal, toBase64, generateSecret, uuid } from '../src/connect/crypto.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// Computed with the same crates as src-tauri/src/remote/crypto.rs (x25519-dalek, hkdf,
// chacha20poly1305): secrets of all 0x01 / 0x02 bytes, nonce of 0x07 bytes.
test('matches the Rust implementation byte for byte', () => {
  const a = new Uint8Array(32).fill(1);
  const b = new Uint8Array(32).fill(2);
  assert.equal(publicKey(a), 'pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=');
  assert.equal(publicKey(b), 'zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=');
  assert.equal(fingerprint(publicKey(b)), 'cfa570c653bd212b10a9cb551fd7a1b4');
  const key = pairKey(a, A, publicKey(b), B);
  assert.equal(hex(key), 'c899f243f803caec44b4ebdb1e920a24e492762031c22c3e0ab9da3a7d508c86');
  const body = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHMGOxXqaPoZtqHa3PeEVUMzZrHV5UT032sJ0M1BXd';
  assert.equal(seal(key, A, B, '{"type":"req"}', new Uint8Array(24).fill(7)), body);
  assert.equal(open(pairKey(b, B, publicKey(a), A), A, B, body), '{"type":"req"}');
});

test('round trips with fresh keys and refuses tampering', () => {
  const a = decodeSecret(generateSecret())!;
  const b = decodeSecret(generateSecret())!;
  const ab = pairKey(a, A, publicKey(b), B);
  assert.deepEqual(ab, pairKey(b, B, publicKey(a), A));
  const body = seal(ab, A, B, 'héllo');
  assert.equal(open(ab, A, B, body), 'héllo');
  assert.throws(() => open(ab, B, A, body));
  const raw = fromBase64(body);
  raw[raw.length - 1] ^= 1;
  assert.throws(() => open(ab, A, B, toBase64(raw)));
  assert.throws(() => open(ab, A, B, 'short'));
  assert.throws(() => pairKey(a, A, toBase64(new Uint8Array(32)), B));
  assert.equal(fingerprint('nope'), '');
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
