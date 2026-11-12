// The replay's own scoring: a bug here would hide a lost gold file or a size change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepCauses, stepsOf } from './dig.mjs';
import { emptyGlobSearches, exploreCalls, goldEarned, goldShown, lostEarned, mergeTasks } from './replay.mjs';

const line = value => JSON.stringify(value);

test('explore calls pair with their replies, in order', () => {
  const stream = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__pandacode_architect__pandacode_explore', input: { search: ['x'] } }, { type: 'tool_use', id: 'b', name: 'Read', input: {} }] } }),
    'not json',
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '{"search":[]}' }] }, { type: 'tool_result', tool_use_id: 'b', content: 'file' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'mcp__bench__pandacode_explore', input: { read: ['a.rs'] } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'plain text' }] } }),
  ].join('\n');
  assert.deepEqual(exploreCalls(stream), [
    { args: { search: ['x'] }, reply: '{"search":[]}' },
    { args: { read: ['a.rs'] }, reply: 'plain text' },
  ]);
});

test('gold counts when any reply names it, by full path or its last two parts', () => {
  const gold = ['src/remote/secrets.rs', 'src-tauri/src/a/b.rs', 'missing.ts'];
  assert.deepEqual(goldShown(gold, ['… remote/secrets.rs:3 …', null, 'a/b.rs']), ['src/remote/secrets.rs', 'src-tauri/src/a/b.rs']);
});

test('only searches with a glob and no match count as empty in a glob', () => {
  const reply = value => JSON.stringify(value);
  const calls = [
    { args: { search: ['a', 'b'], glob: ['*.rs'] }, reply: reply({ search: [{ matches: 0, outside_glob: { files: 1, hits: ['x.ts:1:a'] } }, { matches: 0 }] }) },
    { args: { search: ['c'], glob: '*.ts' }, reply: reply({ search: [{ matches: 2 }] }) },
    { args: { search: ['d'] }, reply: reply({ search: [{ matches: 0 }] }) },
    { args: { search: ['e'], glob: ['x'] }, reply: 'Invalid arguments' },
  ];
  assert.deepEqual(emptyGlobSearches(calls), { empty: 2, answered: 1 });
});

test('gold counts as earned only from a call that did not name it itself', () => {
  const gold = ['src/a/b.rs', 'src/c.ts', 'docs/d.md'];
  const calls = [
    { args: { read: ['src/a/b.rs'] }, reply: 'src/a/b.rs 1:x src/c.ts' },
    { args: { search: ['x'], glob: ['docs/**'] }, reply: 'a/b.rs:3' },
    { args: { read: ['docs/d.md'] }, reply: null },
  ];
  assert.deepEqual(goldEarned(gold, calls), ['src/a/b.rs', 'src/c.ts']);
  assert.deepEqual(goldEarned(gold, calls.slice(0, 1)), ['src/c.ts'], 'naming a file and getting it back proves nothing');
});

test('earned gold is compared run by run', () => {
  assert.deepEqual(lostEarned('t', [['a', 'b'], ['a']], [['a'], ['a', 'c']]), ['t run 1: b']);
  assert.deepEqual(lostEarned('t', [['a']], [['a']]), []);
});

test('held-out tasks replay beside the tuned ones, with their repos', () => {
  const merged = mergeTasks({ repos: { a: { prune: ['x'] } }, localization: [{ id: 't' }] }, { repos: { hono: { prune: [] } }, localization: [{ id: 'ho' }] });
  assert.deepEqual(merged.localization.map(task => task.id), ['t', 'ho']);
  assert.deepEqual(Object.keys(merged.repos), ['a', 'hono']);
});

test('dig counts where steps went: kinds, steps after the replies held the answer, rejections, reads of shown files', () => {
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (id, content, error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error: error });
  const events = [
    { type: 'assistant', message: { id: 'm1', content: [use('a', 'mcp__x__pandacode_explore', { search: ['x'], limit: 0 })] } },
    { type: 'user', message: { content: [result('a', 'Invalid arguments: limit: unknown argument.', true)] } },
    { type: 'assistant', message: { id: 'm2', content: [use('b', 'mcp__x__pandacode_explore', { search: ['x'] })] } },
    { type: 'user', message: { content: [result('b', '{"search":[{"text":"src/a.rs\\n@ run 10-20\\n12:x","omitted_lines":3}],"truncated":true}')] } },
    { type: 'assistant', message: { id: 'm3', content: [use('c', 'Read', { file_path: '/t/repo/src/a.rs', offset: 10, limit: 11 })] } },
    { type: 'user', message: { content: [result('c', 'body')] } },
    { type: 'assistant', message: { id: 'm4', content: [{ type: 'text', text: 'src/a.rs' }] } },
  ];
  const steps = stepsOf(events);
  assert.equal(steps.length, 4);
  const causes = stepCauses(steps, ['src/a.rs', 'src/b.rs'], ['src/a.rs']);
  assert.deepEqual(causes.kinds, { explore: 2, Read: 1, answer: 1 });
  assert.equal(causes.afterExploreHeld, 1, 'the Read came after a reply named the answer');
  assert.deepEqual(causes.rejected, ['Invalid arguments: limit: unknown argument.']);
  assert.deepEqual([causes.truncated, causes.omitted, causes.reAsks, causes.reads, causes.readsShown, causes.readsSpan], [1, 1, 1, 1, 1, 1]);
});
