/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTool, diffLines, exitCode, parseFields, parseToolMessage, subagentName, toolKind, type Subagent } from '../src/store/trace.ts';

const t = (name: string, input: unknown, status: 'running' | 'completed' | 'failed' = 'completed') => ({ name, status, input: typeof input === 'string' ? input : JSON.stringify(input) });

test('tools get the desktop\'s kinds', () => {
  assert.deepEqual(['Bash', 'exec_command', 'Read', 'MultiEdit', 'apply_patch', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'update_plan', 'Task', 'Skill', 'mcp__github__get_issue', 'pandacode_title', 'Frobnicate'].map(toolKind),
    ['shell', 'shell', 'read', 'edit', 'edit', 'write', 'search', 'search', 'web', 'fetch', 'todo', 'todo', 'agent', 'skill', 'mcp', 'mcp', 'tool']);
});

test('rows read as sentences: command, file name with +/−, search, MCP', () => {
  assert.deepEqual(describeTool(t('Bash', { command: 'npm test -- upload' }, 'running')), { kind: 'shell', verb: 'Running', chip: 'npm', object: 'test -- upload' });
  assert.equal(describeTool(t('exec_command', '/bin/zsh -lc "git status"\nWorking directory: /x')).chip, 'git');
  const edit = describeTool(t('Edit', { file_path: '/repo/src/auth.ts', old_string: 'a\nb', new_string: 'a\nb\nc' }));
  assert.deepEqual([edit.verb, edit.chip, edit.added, edit.removed], ['Edited', 'auth.ts', 3, 2]);
  assert.deepEqual(describeTool(t('Grep', { pattern: 'retry', path: 'src/upload' })), { kind: 'search', verb: 'Searched', chip: 'upload', object: 'for retry' });
  assert.deepEqual(describeTool(t('mcp__github__get_issue', { query: 'retry bug' })), { kind: 'mcp', verb: 'Used', chip: 'github › get issue', object: 'retry bug' });
  assert.equal(describeTool(t('Read', 'docs/relay.md')).chip, 'relay.md'); // plain-text input
});

test('edit diffs list removed then added lines, across MultiEdit edits', () => {
  assert.deepEqual(diffLines(parseFields(JSON.stringify({ edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '', new_string: 'z' }] }))),
    [{ kind: 'del', text: 'x' }, { kind: 'add', text: 'y' }, { kind: 'add', text: 'z' }]);
});

test('exit codes and stored tool messages', () => {
  assert.deepEqual(exitCode('Exit code: 1\nWall time: 2s\nOutput:\nboom'), { code: 1, body: 'boom' });
  assert.equal(exitCode('{"exitCode":0,"stdout":"ok"}').code, 0);
  assert.deepEqual(parseToolMessage(JSON.stringify({ type: 'tool_activity', version: 1, id: 'i', name: 'Read', status: 'failed', input: 'a', output: 'b' })),
    { id: 'i', name: 'Read', status: 'failed', input: 'a', output: 'b' });
  assert.deepEqual(parseToolMessage('Ran tests\nall passed'), { id: '', name: 'Ran tests', status: 'completed', input: '', output: 'all passed' });
});

test('subagents are named by name, else their prompt', () => {
  const a = { id: 'a', name: 'Explore', prompt: 'Look', status: 'running', response: '', tools: [], startedAt: 0, updatedAt: 0 } as Subagent;
  assert.equal(subagentName(a), 'Explore');
  assert.equal(subagentName({ ...a, name: 'agent', prompt: 'Find the flaky test\nmore' }), 'Find the flaky test');
});

test('tool groups summarize like the desktop', async () => {
  const { summarizeTools } = await import('../src/store/trace.ts');
  const s = (name: string, status: 'running' | 'completed' | 'failed' = 'completed') => ({ name, status });
  assert.equal(summarizeTools([s('Bash'), s('Bash'), s('Read'), s('Edit', 'failed')]), 'Ran 2 commands, read 1 file and edited 1 file · 1 failed');
  assert.equal(summarizeTools([s('Grep'), s('Read', 'running')]), 'Running 1 search and reading 1 file…');
  assert.equal(summarizeTools([s('TodoWrite')]), 'Updated the plan');
});

test('consecutive tools group, five at most, split by other entries', async () => {
  const { groupRuns } = await import('../src/store/trace.ts');
  const runs = groupRuns(['t', 't', 'x', 't', 't', 't', 't', 't', 't'], e => e === 't');
  assert.deepEqual(runs.map(r => (r.kind === 'tools' ? r.items.length : r.item)), [2, 'x', 5, 1]);
});
