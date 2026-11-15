/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { LOST } from '../src/connect/rpc.ts';
import { followStart, unsentFields } from '../src/connect/start-retry.ts';

const base = { canPoll: () => true, sleep: async () => undefined, now: () => 0, maxMs: 60_000 };

test('a recovered chat.start keeps sent: false, error and projectId from task.startStatus', async () => {
  const reply = await followStart({
    ...base,
    start: async () => { throw new Error(LOST); },
    status: async () => ({ state: 'done' as const, sessionId: 'c1', sent: false, error: 'Could not start claude.', projectId: 'p1' }),
  });
  assert.deepEqual(reply, { sessionId: 'c1', worktree: undefined, note: undefined, sent: false, error: 'Could not start claude.', projectId: 'p1' });
});

test('a recovered start without a project (task.start, older hosts) has no projectId', async () => {
  const reply = await followStart({ ...base, start: async () => { throw new Error(LOST); }, status: async () => ({ state: 'done' as const, sessionId: 's1', projectId: 42 }) });
  assert.equal('projectId' in reply, false);
  assert.equal(reply.sent, undefined);
});

test('unsentFields passes only a not-sent result', () => {
  assert.deepEqual(unsentFields({ sent: false, error: 'busy' }), { sent: false, error: 'busy' });
  assert.deepEqual(unsentFields({ sent: false }), { sent: false, error: 'The computer did not say why.' });
  assert.deepEqual(unsentFields({}), {});
});
