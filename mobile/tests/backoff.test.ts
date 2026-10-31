/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { backoff } from '../src/store/backoff.ts';

test('the first retry after a stable socket goes at once, then 1 s, 2 s… up to a minute', () => {
  assert.deepEqual(backoff(0, { opened: true, upMs: 60_000 }), [0, 1000]);
  assert.deepEqual(backoff(8000, { opened: true, upMs: 60_000 }), [0, 1000], 'a stable socket resets the backoff');
  assert.deepEqual(backoff(0, { opened: false, upMs: 0 }), [0, 1000], 'the very first attempt failing retries at once');
  assert.deepEqual(backoff(1000, { opened: false, upMs: 0 }), [1000, 2000]);
  assert.deepEqual(backoff(8000, { opened: true, upMs: 5000 }), [8000, 16_000], 'a flapping socket keeps backing off');
  assert.deepEqual(backoff(40_000, { opened: false, upMs: 0 }), [40_000, 60_000]);
});

test('replaced waits a minute; revoked stops', () => {
  assert.deepEqual(backoff(0, { opened: true, upMs: 60_000, code: 4000 }), [60_000, 1000]);
  assert.equal(backoff(0, { opened: true, upMs: 60_000, code: 4001 }), null);
});
