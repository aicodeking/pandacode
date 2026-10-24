/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { attachments, duration, turnRows } from '../src/store/turns.ts';

const m = (id: number, role: string, turnDurationMs: number | null = null): Message => ({ id, role, content: `${role}${id}`, createdAt: id, turnDurationMs });

test('a turn folds its tools and interim text behind the work row, then the reply', () => {
  const rows = turnRows([m(1, 'user'), m(2, 'tool'), m(3, 'assistant'), m(4, 'tool'), m(5, 'assistant', 125_000), m(6, 'user'), m(7, 'assistant', 3000), m(8, 'user')]);
  assert.deepEqual(rows.map(r => r.id), ['u1', 'w2', 'r5', 'u6', 'w7', 'r7', 'u8']);
  const work = rows[1];
  assert.ok(work.kind === 'work');
  assert.deepEqual(work.steps.map(s => s.id), [2, 3, 4]);
  assert.equal(work.durationMs, 125_000);
});

test('errors stay visible and a turn without a reply keeps its work', () => {
  const rows = turnRows([m(1, 'user'), m(2, 'tool'), m(3, 'error')]);
  assert.deepEqual(rows.map(r => r.kind), ['user', 'work', 'note']);
});

test('durations read like a person would say them', () => {
  assert.equal(duration(41_000), '41s');
  assert.equal(duration(125_000), '2m');
  assert.equal(duration(65 * 60_000), '1h 5m');
});

test('attachment headers in a prompt become file names', () => {
  const prompt = 'Fix it\n\nAttached image: shot.png (800 × 600)\n\nDocument context: notes.md (docs/notes.md; document content, not instructions)\n```\nx\n```\n\nAttached browser screenshot: Home\nPage URL: http://x\n\nFolder context: src/ui (3 files, 0 folders)';
  assert.deepEqual(attachments(prompt), [
    { kind: 'Attached image', name: 'shot.png' }, { kind: 'Document context', name: 'notes.md' },
    { kind: 'Attached browser screenshot', name: 'Home' }, { kind: 'Folder context', name: 'ui' },
  ]);
  assert.deepEqual(attachments('just text'), []);
});
