/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../connect/types.ts';
import { inboxSections } from '../store/inbox.ts';
import { headline, MAX_ROWS, summarize } from './summary.ts';

const NOW = 1_800_000_000_000;
const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'web', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: NOW - 60_000, lastPromptAt: null, ...extra,
});
const inbox = (tasks: TaskSummary[]) =>
  inboxSections({ hosts: [{ id: 'mac', name: 'Studio' }], tasks: { mac: { tasks, projects: [] } }, live: {}, snoozed: {}, pins: {}, outbox: [], now: NOW });

test('headline counts agents and attention', () => {
  assert.equal(headline(3, 2), '3 active agents · 2 need attention');
  assert.equal(headline(1, 1), '1 active agent · 1 needs attention');
  assert.equal(headline(2, 0), '2 active agents');
  assert.equal(headline(0, 0), 'All done');
});

test('rows: needs, then working; finished tracked tasks stay as Done', () => {
  const first = summarize(inbox([
    task('a', { status: 'waiting', pending: [{ kind: 'approval', requestId: 'r', text: 'ok?' }] }),
    task('q', { status: 'waiting', pending: [{ kind: 'input_request', requestId: 'r2', text: '?' }] }),
    task('w', { status: 'running', chat: true }),
    task('idle'),
  ]), new Set(), '9:41', '');
  assert.deepEqual(first.summary.rows.map(r => [r.key, r.status, r.project]), [['mac/a', 'approval', 'web'], ['mac/q', 'input', 'web'], ['mac/w', 'working', 'Chat']]);
  assert.equal(first.summary.headline, '3 active agents · 2 need attention');
  assert.equal(first.summary.url, 'pandacode://inbox');

  const later = summarize(inbox([task('a'), task('q', { status: 'failed' }), task('w', { status: 'running' }), task('idle')]), first.tracked, '9:42', '');
  assert.deepEqual(later.summary.rows.map(r => [r.key, r.status]), [['mac/w', 'working'], ['mac/a', 'done'], ['mac/q', 'failed']]);
  assert.equal(later.summary.active, 1);
  assert.equal(later.summary.url, 'pandacode://task/mac/w');
});

test('a single task links to it, and rows are capped', () => {
  const one = summarize(inbox([task('x y', { status: 'running' })]), new Set(), '', '');
  assert.equal(one.summary.url, 'pandacode://task/mac/x%20y');
  const many = summarize(inbox(Array.from({ length: 6 }, (_, i) => task(`t${i}`, { status: 'running' }))), new Set(), '', '');
  assert.equal(many.summary.rows.length, MAX_ROWS);
  assert.equal(many.summary.active, 6);
});
