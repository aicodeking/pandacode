import test from 'node:test';
import assert from 'node:assert/strict';
import { TailText } from '../src/tail-text.ts';

test('a tail buffer reads exactly what per-chunk slicing kept', () => {
  const cap = 10, buffer = new TailText(cap);
  let expected = '';
  for (const chunk of ['abc', '', 'defgh', 'ijklmnopq', 'r', 'stuvwxyz0123456789', 'A', 'BCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    buffer.append(chunk); expected = (expected + chunk).slice(-cap);
    assert.equal(buffer.value, expected);
  }
  // Unread appends fold on their own and still keep the same tail.
  for (let i = 0; i < 50; i++) { buffer.append(String(i)); expected = (expected + i).slice(-cap); }
  assert.equal(buffer.value, expected);
  buffer.set('');
  assert.equal(buffer.value, '');
  buffer.append('x');
  assert.equal(buffer.value, 'x');
});
