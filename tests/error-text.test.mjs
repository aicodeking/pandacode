import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText, ERROR_TEXT_LIMIT } from '../src/error-text.ts';

test('Error gives its message', () => assert.equal(errorText(new Error('boom')), 'boom'));
test('Error with an empty message falls back', () => assert.equal(errorText(new Error('')), 'Something went wrong.'));
test('strings are trimmed; blank strings fall back', () => {
  assert.equal(errorText('  nope \n'), 'nope');
  assert.equal(errorText('   ', 'custom'), 'custom');
});
test('objects use message, then error', () => {
  assert.equal(errorText({ message: 'tauri failed' }), 'tauri failed');
  assert.equal(errorText({ error: 'denied' }), 'denied');
  assert.equal(errorText({ message: '', error: 'second' }), 'second');
});
test('plain objects, null and undefined fall back, never [object Object]', () => {
  assert.equal(errorText({ code: 1 }), 'Something went wrong.');
  assert.equal(errorText({ message: 5 }, 'x'), 'x');
  assert.equal(errorText(null), 'Something went wrong.');
  assert.equal(errorText(undefined, 'custom'), 'custom');
});
test('numbers and booleans stringify', () => {
  assert.equal(errorText(404), '404');
  assert.equal(errorText(false), 'false');
});
test('long text is bounded with an ellipsis', () => {
  const out = errorText('x'.repeat(ERROR_TEXT_LIMIT + 50));
  assert.equal(out.length, ERROR_TEXT_LIMIT);
  assert.ok(out.endsWith('…'));
});
