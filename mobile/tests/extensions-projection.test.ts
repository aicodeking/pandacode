import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyEvent, ended, fromList, idleLive, mergeMessages } from '../src/store/reduce.ts';
import { glanceOf } from '../src/store/inbox.ts';
import type { AgentEvent, Message, TaskSummary } from '../src/connect/types.ts';

const fixture: { task: TaskSummary; messages: Message[]; events: AgentEvent[] } = JSON.parse(readFileSync(new URL('../../tests/fixtures/extensions/mobile-projection.json', import.meta.url), 'utf8'));
test('extension providers and unsupported desktop HTML preserve mobile core history/status', () => {
  assert.equal(fixture.task.provider, 'unknown.publisher/new-harness');
  let live = fromList(idleLive(), fixture.task.status) ?? idleLive();
  live = applyEvent(live, fixture.events[0], 1000);
  const before = live.items;
  live = applyEvent(live, fixture.events[1], 1001);
  assert.equal(live.items, before); // No HTML renderer, script evaluation or replacement transcript.
  live = applyEvent(live, fixture.events[2], 1002);
  assert.equal(live.status, 'running');
  assert.equal(glanceOf(live, fixture.task).activity, 'Working on the host');
  assert.deepEqual(mergeMessages([], fixture.messages), fixture.messages);
  assert.equal(mergeMessages(fixture.messages, fixture.messages).length, 1);
  assert.equal(ended(live, 'idle').status, 'idle');
  assert.equal(fixture.task.provider, 'unknown.publisher/new-harness');
});
