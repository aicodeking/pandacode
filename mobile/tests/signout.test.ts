/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetPhoneState, signOutSteps } from '../src/connect/sign-out.ts';

test('sign-out stops the connection, clears the outbox before the token, then resets', async () => {
  const done: string[] = [];
  await signOutSteps({
    stop: () => { done.push('stop'); },
    forgetLocal: async () => { done.push('local'); },
    clearSession: async () => { done.push('session'); },
    reset: () => { done.push('reset'); },
  });
  assert.deepEqual(done, ['stop', 'local', 'session', 'reset']);
});

test('drafts and stored state both go, and a failed erase still finishes', async t => {
  t.mock.method(console, 'warn', () => undefined);
  const done: string[] = [];
  await forgetPhoneState({ clearDrafts: () => { done.push('drafts'); }, clearLocal: async () => { done.push('local'); throw new Error('locked'); } });
  assert.deepEqual(done, ['drafts', 'local']);
});
