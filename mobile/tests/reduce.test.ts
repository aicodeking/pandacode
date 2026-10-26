/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEvent, ended, fromList, fromSubscribe, idleLive, mergeMessages, staleLists, withHostActivity, type Live } from '../src/store/reduce.ts';
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
const T = 1_800_000_000_000;
const run = (events: AgentEvent[], start: Live = idleLive(), now = T) => events.reduce((live, e) => applyEvent(live, e, now), start);

test('live state follows text, tools, approvals and done', () => {
  let live = run([ev('text', { text: 'Hel' }), ev('text', { text: 'lo' })]);
  assert.equal(live.status, 'running');
  assert.deepEqual(live.items, [{ kind: 'text', text: 'Hello' }]);
  const tool = { id: 't1', name: 'Bash', status: 'running' as const, input: 'ls', output: '' };
  live = run([ev('tool', { tool }), ev('tool', { tool: { ...tool, status: 'completed' } }), ev('message_start'), ev('text', { text: 'Done' })], live);
  assert.equal(live.items.length, 3);
  assert.deepEqual(live.items[1], { kind: 'tool', tool: { ...tool, status: 'completed' }, startedAt: T, endedAt: T });
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
  assert.equal(live.status, 'waiting'); // a malformed subagent changes nothing
});

test('the host\'s raw done keeps the live reply until run.finished copies the messages', () => {
  const live = run([ev('text', { text: 'Final answer' })]);
  const after = applyEvent(live, ev('done', { text: 'Turn complete' }));
  assert.equal(after.items, live.items); // unchanged: no flicker before the final message arrives
  assert.equal(after.status, 'running');
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

const agent = (id: string, status: string, updatedAt: number, extra: object = {}) => ({ id, name: 'Explore', prompt: 'Find the upload retry', status, response: '', tools: [], startedAt: 10, updatedAt, ...extra });

test('tools keep when they started and ended, for their duration', () => {
  const tool = { id: 't', name: 'Bash', status: 'running' as const, input: 'ls', output: '' };
  let live = run([ev('tool', { tool })], idleLive(), 1000);
  live = run([ev('tool', { tool: { ...tool, output: 'a' } })], live, 2000);
  live = run([ev('tool', { tool: { ...tool, status: 'completed' } })], live, 5000);
  live = run([ev('tool', { tool: { ...tool, status: 'completed', output: 'b' } })], live, 9000);
  assert.deepEqual(live.items.map(i => i.kind === 'tool' && [i.startedAt, i.endedAt]), [[1000, 5000]]);
  assert.equal(live.startedAt, 1000);
  assert.equal(live.lastEventAt, 9000);
});

test('subagents upsert by id, newer snapshots win, malformed ones are dropped', () => {
  let live = run([ev('subagent', { data: agent('a', 'running', 1, { tools: [{ id: 'x', name: 'Read', status: 'running', input: 'f' }, { bad: true }] }) })]);
  assert.equal(live.status, 'idle'); // a subagent alone doesn't start a run, as on the desktop
  assert.deepEqual(live.subagents?.map(a => [a.id, a.status, a.tools.length]), [['a', 'running', 1]]);
  live = run([ev('subagent', { data: agent('b', 'running', 2) }), ev('subagent', { data: agent('a', 'completed', 3) }), ev('subagent', { data: agent('a', 'running', 2) })], live);
  assert.deepEqual(live.subagents?.map(a => [a.id, a.status]), [['a', 'completed'], ['b', 'running']]);
  assert.equal(run([ev('subagent', { data: { id: 'c', status: 'bogus' } })], live).subagents, live.subagents);
});

test('a todo tool becomes the run\'s checklist; thinking shows until text or a tool', () => {
  const todos = { id: 'p', name: 'TodoWrite', status: 'completed' as const, output: '', input: JSON.stringify({ todos: [{ content: 'Read the test', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }] }) };
  let live = run([ev('status', { text: 'Thinking' })]);
  assert.equal(live.thinking, 'Thinking');
  live = run([ev('tool', { tool: todos })], live);
  assert.equal(live.thinking, undefined);
  assert.deepEqual(live.todos, [{ text: 'Read the test', status: 'completed' }, { text: 'Fix it', status: 'in_progress' }]);
  // Codex's update_plan replaces it in place; another tool keeps it.
  live = run([ev('tool', { tool: { ...todos, id: 'p2', name: 'update_plan', input: JSON.stringify({ plan: [{ step: 'Ship', status: 'pending' }] }) } }), ev('tool', { tool: { ...todos, id: 'z', name: 'Bash', input: 'ls' } })], live);
  assert.deepEqual(live.todos, [{ text: 'Ship', status: 'pending' }]);
});

test('a limit outlives its run end and clears when the next run starts', () => {
  const limited = run([ev('text', { text: 'x' }), ev('limited', { text: 'Limit reached', data: { resetsAt: 99 } })]);
  const after = ended(limited, 'failed');
  assert.deepEqual([after.status, after.limited, after.items.length], ['failed', { text: 'Limit reached', resetsAt: 99 }, 0]);
  assert.equal(fromSubscribe(limited, 'idle').limited?.resetsAt, 99);
  assert.equal(run([ev('text', { text: 'again' })], after).limited, undefined);
});

test('host activity fields fill in times and subagents; older hosts change nothing', () => {
  const live = { ...idleLive(), status: 'running', lastEventAt: 500 };
  assert.equal(withHostActivity(live, {}), live);
  assert.equal(withHostActivity(live, undefined), live);
  const merged = withHostActivity(live, { lastEventAt: 2_000_000_000_000, runStartedAt: 1_700_000_000, subagents: [agent('a', 'running', 1), 'junk'] });
  assert.equal(merged.lastEventAt, 2_000_000_000_000);
  assert.equal(merged.startedAt, 1_700_000_000_000); // seconds scaled to ms
  assert.deepEqual(merged.subagents?.map(a => a.id), ['a']);
  assert.equal(withHostActivity(merged, { lastEventAt: 1 }).lastEventAt, 2_000_000_000_000); // never goes back
  // tasks.list seeds a running task the phone hasn't seen only when the host says something about it.
  assert.equal(fromList(undefined, 'running'), undefined);
  assert.equal(fromList(undefined, 'running', [], { runStartedAt: 1_800_000_000_000 })?.startedAt, 1_800_000_000_000);
  assert.equal(fromSubscribe(idleLive(), 'running', undefined, { subagents: [agent('b', 'waiting', 1)] }).subagents?.[0].id, 'b');
});

test('a whole copy replaces a held message the host had cut', () => {
  const cut = { ...m(2), content: 'm2 (cut)', cut: true };
  const held = [m(1), cut];
  assert.equal(mergeMessages(held, [{ ...m(2), cut: true }]), held, 'still cut: unchanged');
  const merged = mergeMessages(held, [m(2), m(3)]);
  assert.deepEqual(merged.map(x => [x.id, x.content, x.cut]), [[1, 'm1', undefined], [2, 'm2', undefined], [3, 'm3', undefined]]);
  assert.deepEqual(held[1], cut, 'not mutated');
  const whole = [m(1), m(2)];
  assert.equal(mergeMessages(whole, [{ ...m(2), content: 'other' }]), whole, 'whole messages are never replaced');
});
