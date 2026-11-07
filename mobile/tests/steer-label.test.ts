/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreDraft, steeredAt, steerKey, useDrafts } from '../src/store/draft.ts';

test('a steer labels only its own task, and only messages from then on', () => {
  const steers = { [steerKey('a/1', ' fix it ')]: 100 };
  assert.equal(steeredAt(steers, 'a/1', 'fix it', 100), 100);
  assert.equal(steeredAt(steers, 'a/1', 'fix it', 150), 100);
  assert.equal(steeredAt(steers, 'a/1', 'fix it', 99), undefined);
  assert.equal(steeredAt(steers, 'a/2', 'fix it', 150), undefined);
  assert.equal(steeredAt(steers, 'a/1', 'other', 150), undefined);
});

test('a failed send restores its text only into an empty field', () => {
  restoreDraft('k', 'first');
  assert.equal(useDrafts.getState().text.k, 'first');
  restoreDraft('k', 'second');
  assert.equal(useDrafts.getState().text.k, 'first');
});
