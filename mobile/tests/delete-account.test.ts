/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteAccount, NOT_CONFIRMED } from '../src/connect/delete-account.ts';

function steps(reply: () => Promise<unknown>) {
  const done: string[] = [];
  return {
    done,
    steps: {
      remove: async () => { done.push('remove'); return reply(); },
      wipe: async () => { done.push('wipe'); },
      signOut: async () => { done.push('signOut'); },
    },
  };
}

test('a confirmed deletion wipes this phone, then signs out', async () => {
  const { done, steps: s } = steps(async () => ({ ok: true }));
  await deleteAccount(s);
  assert.deepEqual(done, ['remove', 'wipe', 'signOut']);
});

test('a relay error leaves the phone signed in with its secrets', async () => {
  const { done, steps: s } = steps(async () => { throw new Error('Could not reach the relay. Check your connection.'); });
  await assert.rejects(deleteAccount(s), /Could not reach/);
  assert.deepEqual(done, ['remove']);
});

test('a reply without ok: true is not a deletion', async () => {
  for (const reply of [null, {}, { ok: 'yes' }, { ok: false }]) {
    const { done, steps: s } = steps(async () => reply);
    await assert.rejects(deleteAccount(s), { message: NOT_CONFIRMED });
    assert.deepEqual(done, ['remove']);
  }
});
