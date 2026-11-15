/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { toastClearance, withClearance } from '../src/ui/ds/toast-clearance.ts';

test('with nothing registered the fallback clears the composer or tab bar', () => {
  assert.equal(toastClearance({}, 64), 64);
});

test('the tallest registered dock wins; bad heights are ignored', () => {
  assert.equal(toastClearance({ 1: 52, 2: 118 }, 64), 118);
  assert.equal(toastClearance({ 1: 40 }, 64), 40, 'a shorter dock lowers the toast');
  assert.equal(toastClearance({ 1: Number.NaN, 2: -3 }, 64), 64);
});

test('withClearance registers, updates and removes without mutating', () => {
  const empty = {};
  const one = withClearance(empty, 1, 80);
  assert.deepEqual(one, { 1: 80 });
  assert.deepEqual(empty, {});
  assert.equal(withClearance(one, 1, 80), one, 'unchanged height keeps the object');
  assert.deepEqual(withClearance(one, 2, 30), { 1: 80, 2: 30 });
  assert.deepEqual(withClearance(one, 1, null), {});
  assert.equal(withClearance(one, 9, null), one, 'removing an unknown id keeps the object');
});
