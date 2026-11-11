/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedGone, missingKeys, withDeleted } from '../src/store/gone.ts';

const none = { deleted: {}, archived: {} };

test('a task missing from the list window is not gone without a confirmed delete or archive', () => {
  assert.equal(confirmedGone('d/s', false, none), false, 'fell out of the 200 most recent');
  assert.equal(confirmedGone('d/s', false, { deleted: { 'd/other': true }, archived: { 'd/x': 1 } }), false);
});

test('a delete or archive from this phone closes it once it leaves the list', () => {
  assert.equal(confirmedGone('d/s', false, { deleted: { 'd/s': true }, archived: {} }), true);
  assert.equal(confirmedGone('d/s', false, { deleted: {}, archived: { 'd/s': 0 } }), true, 'archived at time 0 still counts');
});

test('a listed task never closes, marks or not', () => {
  assert.equal(confirmedGone('d/s', true, { deleted: { 'd/s': true }, archived: { 'd/s': 5 } }), false);
});

test('withDeleted adds new keys and keeps the object when nothing is new', () => {
  const start = { 'd/a': true as const };
  assert.equal(withDeleted(start, ['d/a']), start);
  assert.equal(withDeleted(start, []), start);
  assert.deepEqual(withDeleted(start, ['d/a', 'd/b', 'd/c']), { 'd/a': true, 'd/b': true, 'd/c': true });
  assert.deepEqual(start, { 'd/a': true }, 'not mutated');
});

test('only ids the host explicitly reports missing, and that were asked about, count as deleted', () => {
  assert.deepEqual(missingKeys('d', ['a', 'x', 'a', 7, null], ['a', 'b']), ['d/a']);
  assert.deepEqual(missingKeys('d', undefined, ['a']), [], 'older hosts send no list: nothing is deleted');
  assert.deepEqual(missingKeys('d', 'a', ['a']), []);
  assert.deepEqual(missingKeys('d', [], ['a']), [], 'absent from tasks alone proves nothing');
});
