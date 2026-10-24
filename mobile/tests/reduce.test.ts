/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, fromList, fromSubscribe, idleLive, mergeMessages, staleLists, type Live } from '../src/store/reduce.ts';
import type { AgentEvent, Message } from '../src/connect/types.ts';

const m = (id: number): Message => ({ id, role: 'assistant', content: `m${id}`, createdAt: id, turnDurationMs: null });

test('message pages merge incrementally and never twice', () => {
  const first = mergeMessages([], [m(1), m(2)]);
  const second = mergeMessages(first, [m(3), m(4)]);
  assert.deepEqual(second.map(x => x.id), [1, 2, 3, 4]);
  // A concurrent copy got there first: the overlap is skipped.
  assert.deepEqual(mergeMessages(second, [m(3), m(4), m(5)]).map(x => x.id), [1, 2, 3, 4, 5]);
  assert.equal(mergeMessages(second, [m(2)]), second);
  assert.deepEqual(first.map(x => x.id), [1, 2]); // inputs are not mutated
});

const ev = (kind: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({ sessionId: 's', kind, text: '', ...extra });
const run = (events: AgentEvent[], start: Live = idleLive()) => events.reduce(applyEvent, start);

test('live state follows text, tools, approvals and done', () => {
  let live = run([ev('text', { text: 'Hel' }), ev('text', { text: 'lo' })]);
  assert.equal(live.status, 'running');
  assert.deepEqual(live.items, [{ kind: 'text', text: 'Hello' }]);
  const tool = { id: 't1', name: 'Bash', status: 'running' as const, input: 'ls', output: '' };
  live = run([ev('tool', { tool }), ev('tool', { tool: { ...tool, status: 'completed' } }), ev('message_start'), ev('text', { text: 'Done' })], live);
  assert.equal(live.items.length, 3);
  assert.deepEqual(live.items[1], { kind: 'tool', tool: { ...tool, status: 'completed' } });
  assert.deepEqual(live.items[2], { kind: 'text', text: 'Done' });

  live = run([ev('approval', { requestId: 'a1', text: 'Run rm?' }), ev('approval', { requestId: 'a1', text: 'dup' })], live);
  assert.equal(live.status, 'waiting');
  assert.equal(live.approvals.length, 1);
  live = applyEvent(live, ev('approval_cancelled', { requestId: 'a1' }));
  assert.equal(live.status, 'running');
  assert.equal(live.approvals.length, 0);

  live = applyEvent(live, ev('input_request', { requestId: 'q1', data: { kind: 'questions', questions: [] } }));
  assert.equal(live.status, 'waiting');
  live = applyEvent(live, ev('subagent'));
  assert.equal(live.status, 'waiting'); // ignored kinds change nothing
});

test('the host\'s raw done keeps the live reply until run.finished copies the messages', () => {
  const live = run([ev('text', { text: 'Final answer' })]);
  const after = applyEvent(live, ev('done', { text: 'Turn complete' }));
  assert.equal(after, live); // unchanged: no flicker before the final message arrives
  assert.deepEqual(after.items, [{ kind: 'text', text: 'Final answer' }]);
});

test('a subscribe reply restores pending requests or ends the run', () => {
  const pending = [{ kind: 'approval', requestId: 'a', text: 'ok?' }];
  assert.equal(fromSubscribe(idleLive(), 'waiting', pending).approvals.length, 1);
  const kept = run([ev('approval', { requestId: 'b' })]);
  assert.equal(fromSubscribe(kept, 'waiting').approvals.length, 1); // older hosts send no pending
  assert.equal(fromSubscribe(kept, 'idle').approvals.length, 0);
  // A task already waiting when opened: both kinds, tool kept, malformed entries dropped.
  const tool = { id: 't', name: 'Bash', status: 'running' as const, input: 'rm x', output: '' };
  const opened = fromSubscribe(idleLive(), 'running', [
    { kind: 'approval', requestId: 'a1', text: 'Run?', tool },
    { kind: 'input_request', requestId: 'q1', text: 'Which?', data: { kind: 'questions', questions: [] } },
    { kind: 'approval', requestId: '', text: 'bad' },
  ]);
  assert.equal(opened.status, 'waiting');
  assert.deepEqual(opened.approvals.map(p => [p.requestId, p.tool?.name]), [['a1', 'Bash']]);
  assert.deepEqual(opened.inputs.map(p => p.requestId), ['q1']);
  assert.equal(run([ev('approval', { requestId: 'a2', tool })]).approvals[0].tool, tool);
});

test('a list settles a run that ended while the phone slept, and keeps newer live state', () => {
  const working: Live = { ...idleLive(), status: 'running', activity: 'Running Bash', items: [{ kind: 'text', text: 'half' }] };
  assert.deepEqual(fromList(working, 'idle'), idleLive());
  assert.equal(fromList(working, 'failed')?.status, 'failed');
  // Still running on the host: events are newer than the list.
  assert.equal(fromList(working, 'running'), working);
  const idle = idleLive();
  assert.equal(fromList(idle, 'running'), idle);
  assert.equal(fromList(undefined, 'idle'), undefined);
  const ask = { kind: 'approval', requestId: 'r1', text: 'Run ls?' };
  const seeded = fromList(undefined, 'running', [ask]);
  assert.equal(seeded?.status, 'waiting');
  assert.deepEqual(seeded?.approvals, [ask]);
});

test('task lists refresh only when missing or old enough', () => {
  assert.deepEqual(staleLists(['a', 'b', 'c'], { a: 1000, b: 9000 }, 10_000, 5000), ['a', 'c']);
  assert.deepEqual(staleLists(['a'], { a: 10_000 }, 10_000, 0), ['a']);
  assert.deepEqual(staleLists([], {}, 10_000, 0), []);
});
