/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeSecret, fingerprint, fromBase64, MAX_UNPACKED, open, unpack, pairKey, publicKey, seal, toBase64, generateSecret, uuid } from '../src/connect/crypto.ts';

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

test('opens a packed frame the desktop sealed (tests/packed-frame.json, record_packed_fixture)', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('./packed-frame.json', import.meta.url), 'utf8'));
  assert.equal(fromBase64(fixture.body).length < fixture.plain.length / 2, true);
  assert.equal(open(fromBase64(fixture.key), fixture.from, fixture.to, fixture.body), fixture.plain);
});

test('refuses a packed bomb and broken deflate', async () => {
  const { deflateSync } = await import('fflate');
  const key = new Uint8Array(32).fill(7);
  const { xchacha20poly1305 } = await import('@noble/ciphers/chacha.js');
  // `seal` takes text; a packed plaintext is `z` + raw deflate bytes.
  const body = (deflated: Uint8Array) => {
    const nonce = new Uint8Array(24);
    const sealed = xchacha20poly1305(key, nonce, new TextEncoder().encode('a|b')).encrypt(new Uint8Array([0x7a, ...deflated]));
    return toBase64(new Uint8Array([...nonce, ...sealed]));
  };
  assert.equal(open(key, 'a', 'b', body(deflateSync(new TextEncoder().encode('{"ok":true}')))), '{"ok":true}');
  assert.throws(() => open(key, 'a', 'b', body(deflateSync(new Uint8Array(MAX_UNPACKED + 1).fill(32)))), /too large/);
  assert.throws(() => open(key, 'a', 'b', body(new TextEncoder().encode('not deflate'))));
});

test('unpack inflates in slices and stops a bomb at the cap', async () => {
  const { deflateSync } = await import('fflate');
  // Incompressible-ish text spanning many input slices comes back whole.
  const text = Array.from({ length: 40_000 }, (_, i) => (i * 2654435761 >>> 0).toString(36)).join(',');
  assert.equal(new TextDecoder().decode(unpack(deflateSync(new TextEncoder().encode(text)))), text);
  // 64 MB of zeros packs to ~64 KB; it must fail at the 2 MB cap, not after inflating it all.
  const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024));
  const started = Date.now();
  assert.throws(() => unpack(bomb), /too large/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(MAX_UNPACKED, 2 * 1024 * 1024);
});
