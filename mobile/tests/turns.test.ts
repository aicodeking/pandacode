/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { attachments, changesOf, duration, reuseRows, turnRows } from '../src/store/turns.ts';
import { modelLabel } from '../src/ui/model-label.ts';

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

test('a system note shows outside the fold, after the reply it follows', () => {
  const rows = turnRows([m(1, 'user'), m(2, 'tool'), m(3, 'assistant'), m(4, 'system')]);
  assert.deepEqual(rows.map(r => r.id), ['u1', 'w2', 'r3', 'n4']);
  const work = rows[1];
  assert.ok(work.kind === 'work');
  assert.deepEqual(work.steps.map(s => s.id), [2]);
});

test('a refetch keeps the objects of unchanged rows, so memoized rows stay put', () => {
  const list = [m(1, 'user'), m(2, 'tool'), m(3, 'assistant', 1000)];
  const before = turnRows(list);
  const copies = list.map(message => ({ ...message }));
  assert.equal(reuseRows(before, turnRows(copies)), before, 'the same messages give the same array');

  const grown = reuseRows(before, turnRows([...copies, m(4, 'user')]));
  assert.deepEqual(grown.map(r => r.id), ['u1', 'w2', 'r3', 'u4']);
  assert.equal(grown[0], before[0]);
  assert.equal(grown[1], before[1]);
  assert.equal(grown[2], before[2]);

  const edited = reuseRows(before, turnRows([copies[0], { ...copies[1], content: 'changed' }, copies[2]]));
  assert.equal(edited[0], before[0]);
  assert.notEqual(edited[1], before[1], 'a changed step gives a new work row');
  assert.equal(edited[2], before[2]);
});

test('model ids read as names when the host list has none', () => {
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('gpt-5.1-codex'), 'GPT-5.1 Codex');
  assert.equal(modelLabel('claude-opus-4-8'), 'Claude Opus 4.8');
  assert.equal(modelLabel('kimi-k2'), 'Kimi K2');
});

test('a turn with attributed changes gets a row after its reply; older hosts and empty turns get none', () => {
  const changed = { ...m(3, 'assistant'), turnChanges: { attributed: true, files: [{}, {}, {}], additions: 6, deletions: 2 } };
  const rows = turnRows([m(1, 'user'), m(2, 'tool'), changed, m(4, 'user')]);
  assert.deepEqual(rows.map(r => r.id), ['u1', 'w2', 'r3', 'c3', 'u4']);
  assert.deepEqual(changesOf(changed), { files: 3, additions: 6, deletions: 2 });
  assert.equal(changesOf(m(5, 'assistant')), null);
  assert.equal(changesOf({ ...m(5, 'assistant'), turnChanges: { attributed: false, files: [{}] } }), null);
  assert.equal(changesOf({ ...m(5, 'assistant'), turnChanges: { attributed: true, files: [] } }), null);
});
