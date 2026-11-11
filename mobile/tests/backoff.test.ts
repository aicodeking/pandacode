/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { backoff, jitter, jitteredBackoff } from '../src/store/backoff.ts';

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

test('jitter spreads a wait over ±30 % and keeps zero at zero', () => {
  assert.equal(jitter(10_000, 0), 7000);
  assert.equal(jitter(10_000, 0.5), 10_000);
  assert.equal(jitter(10_000, 1), 13_000);
  assert.equal(jitter(0, 1), 0, 'an immediate retry stays immediate');
  assert.equal(jitter(10_000, -5), 7000, 'out-of-range randoms are clamped');
  assert.equal(jitter(10_000, 9), 13_000);
  assert.equal(jitter(10_000, Number.NaN), 10_000);
  for (let i = 0; i < 200; i++) {
    const w = jitter(4000, Math.random());
    assert.ok(w >= 2800 && w <= 5200, `${w} within bounds`);
  }
});

test('jittered backoff keeps the replaced minute as a floor and stops when revoked', () => {
  assert.deepEqual(jitteredBackoff(1000, { opened: false, upMs: 0 }, 0), [700, 2000]);
  assert.deepEqual(jitteredBackoff(1000, { opened: false, upMs: 0 }, 1), [1300, 2000]);
  assert.deepEqual(jitteredBackoff(0, { opened: true, upMs: 60_000 }, 1), [0, 1000]);
  assert.deepEqual(jitteredBackoff(0, { opened: true, upMs: 60_000, code: 4000 }, 0), [60_000, 1000], 'never shorter than a minute');
  assert.deepEqual(jitteredBackoff(0, { opened: true, upMs: 60_000, code: 4000 }, 1), [78_000, 1000]);
  assert.equal(jitteredBackoff(0, { opened: true, upMs: 0, code: 4001 }, 0.5), null);
});
