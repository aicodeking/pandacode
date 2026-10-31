import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, summarizeTools, toolPreview, traceRowHtml, shellCommand, toolKind } from '../src/tool-trace.ts';

const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input), output: '', ...extra });

test('describes each kind as a verb, chip and object', () => {
  const cases = [
    [tool('Bash', { command: 'npm test -- --runInBand' }), 'shell', 'Ran', 'npm', 'test -- --runInBand'],
    [tool('Command', '/bin/zsh -lc "git status --short"\nWorking directory: /repo'), 'shell', 'Ran', 'git', 'status --short'],
    [tool('pandacode_vm_exec', { name: 'vm', command: 'uname -a' }), 'shell', 'Ran', 'uname', '-a'],
    [tool('Read', { file_path: '/repo/src/main.ts' }), 'read', 'Read', 'main.ts', ''],
    [tool('read', { path: 'src/dom.ts' }), 'read', 'Read', 'dom.ts', ''],
    [tool('Write', { file_path: 'a/b.md', content: 'one\ntwo' }), 'write', 'Wrote', 'b.md', '2 lines'],
    [tool('Grep', { pattern: 'icon\\(', path: 'src' }), 'search', 'Searched', 'src', 'for icon\\('],
    [tool('Glob', { pattern: '**/*.ts' }), 'search', 'Searched', 'workspace', 'for files matching **/*.ts'],
    [tool('WebSearch', { query: 'tauri updater' }), 'web', 'Searched', 'Web', 'for tauri updater'],
    [tool('WebFetch', { url: 'https://www.example.com/a', prompt: 'Summarize' }), 'fetch', 'Fetched', 'example.com', 'Summarize'],
    [tool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] }), 'todo', 'Updated', undefined, 'the plan · 2 steps'],
    [tool('Task', { description: 'Find callers', subagent_type: 'Explore' }), 'agent', 'Started', 'Explore', 'Find callers'],
    [tool('Skill', { skill: 'hyperframes' }), 'skill', 'Loaded skill', 'hyperframes', ''],
    [tool('mcp__github__list_issues', {}), 'mcp', 'Used', 'github', 'list issues'],
    [tool('pandacode_dispatch_workers', { workers: [{}, {}] }), 'mcp', 'Dispatched', 'PandaCode', '2 workers'],
    [tool('pandacode_schedule_wakeup', { note: 'Check CI', inMinutes: 30 }), 'mcp', 'Scheduled', 'PandaCode', 'a wake-up · in 30 min · Check CI'],
    [tool('pandacode_schedule_wakeup', { note: 'Poll CI', kind: 'interval', intervalMinutes: 120 }), 'mcp', 'Scheduled', 'PandaCode', 'a wake-up · every 2 h · Poll CI'],
    [tool('pandacode_schedule_message', { taskId: 't', text: 'Rebase', kind: 'weekdays', timeOfDay: '09:00' }), 'mcp', 'Scheduled', 'PandaCode', 'a message · weekdays at 09:00 · Rebase'],
    [tool('pandacode_schedule_wakeup', { title: 'Deploy check', note: 'x', at: '18:30' }), 'mcp', 'Scheduled', 'PandaCode', 'a wake-up · at 18:30 · Deploy check'],
    [tool('pandacode_architect_pandacode_title', { title: 'Traces' }), 'mcp', 'Named', 'PandaCode', 'the task “Traces”'],
    [tool('Frobnicate', { path: 'x/y' }), 'tool', 'Used', 'Frobnicate', 'x/y'],
  ];
  for (const [input, kind, verb, chip, object] of cases) {
    const trace = describeTool(input);
    assert.equal(trace.kind, kind, input.name);
    assert.equal(trace.verb, verb, input.name);
    assert.equal(trace.chip?.label, chip, input.name);
    assert.equal(trace.object, object, input.name);
  }
  const edit = describeTool(tool('Edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b\nc' }));
  assert.deepEqual([edit.kind, edit.verb, edit.chip.label, edit.chip.title, edit.added, edit.removed], ['edit', 'Edited', 'x.ts', 'src/x.ts', 2, 1]);
  const multi = describeTool(tool('edit', { path: 'y.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c\nd', newText: '' }] }));
  assert.deepEqual([multi.added, multi.removed], [1, 3]);
  assert.equal(shellCommand("bash -lc 'ls -la'", {}), 'ls -la');
  assert.equal(toolKind('MultiEdit'), 'edit');
});

test('running calls use present tense', () => {
  assert.equal(describeTool(tool('Bash', { command: 'ls' }, { status: 'running' })).verb, 'Running');
  assert.equal(describeTool(tool('Read', { file_path: 'a' }, { status: 'running' })).verb, 'Reading');
  assert.equal(describeTool(tool('WebSearch', { query: 'q' }, { status: 'running' })).verb, 'Searching');
  assert.equal(describeTool(tool('Read', { file_path: 'a' }, { status: 'failed' })).verb, 'Read');
});

test('summaries pluralise, merge verbs and report running and failures', () => {
  const bash = tool('Bash', { command: 'ls' }), read = tool('Read', { file_path: 'a' });
  assert.equal(summarizeTools([bash, bash, bash, read, read, tool('Edit', {})]), 'Ran 3 commands, read 2 files and edited 1 file');
  assert.equal(summarizeTools([tool('Grep', {}), tool('WebSearch', {}), read, read, read]), 'Ran 2 searches and read 3 files');
  assert.equal(summarizeTools([{ ...bash, status: 'running' }, bash]), 'Running 2 commands…');
  assert.equal(summarizeTools([bash, { ...read, status: 'failed' }]), 'Ran 1 command and read 1 file · 1 failed');
  assert.equal(summarizeTools([undefined]), 'Used 1 tool');
  assert.equal(summarizeTools([tool('TodoWrite', {})]), 'Updated the plan');
});

test('cards show structured results', () => {
  const shell = toolPreview(tool('Command', 'ls', { output: 'Exit code: 2\nWall time: 1s\nOutput:\n' + Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n') }));
  assert.match(shell, /tool-trace-badge is-failed">exit 2</);
  assert.match(shell, /line 19/);
  assert.ok(!shell.includes('line 11\n'));
  const vm = toolPreview(tool('pandacode_vm_exec', { command: 'echo hi' }, { output: '{"exitCode":0,"stdout":"hi","stderr":""}' }));
  assert.match(vm, /tool-trace-badge">exit 0</);
  const read = toolPreview(tool('Read', 'src/a.ts', { output: 'one\ntwo\nthree' }));
  assert.match(read, /<b>a.ts<\/b>/);
  assert.match(read, /3 lines/);
  assert.match(toolPreview(tool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })), /<del>- x<\/del>\n<ins>\+ y<\/ins>/);
  const grep = toolPreview(tool('Grep', { pattern: 'x' }, { output: 'Found 8 files\n' + Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`).join('\n') }));
  assert.match(grep, /tool-trace-item-title" title="src\/f0.ts">f0.ts</);
  assert.match(grep, /\+2 more/);
  const web = toolPreview(tool('WebSearch', { query: 'q' }, { output: 'Web search results for query: "q"\n\nLinks: [{"title":"Docs","url":"https://docs.example.com/x"}]\n\nSummary' }));
  assert.match(web, /Docs<\/span><span class="tool-trace-item-meta">docs.example.com</);
  assert.match(toolPreview(tool('TodoWrite', { todos: [{ content: 'Ship', status: 'completed' }] })), /data-status="completed"/);
  assert.equal(toolPreview(tool('Read', 'a', { output: '[Non-text content omitted]' })).includes('Non-text'), false);
});

test('chips, objects and cards escape tool data', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const html = traceRowHtml(describeTool(tool(unsafe, { path: unsafe })))
    + traceRowHtml(describeTool(tool('Read', { file_path: `/a/${unsafe}"` })))
    + toolPreview(tool('Bash', { command: unsafe }, { output: unsafe }))
    + toolPreview(tool('WebSearch', {}, { output: `Links: [{"title":"${unsafe.replace(/"/g, '')}","url":"javascript:${unsafe}"}]` }))
    + toolPreview(tool('Grep', {}, { output: unsafe }))
    + toolPreview(tool('TodoWrite', { todos: [{ content: unsafe, status: '"><b>' }] }));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('"><b>'));
  assert.match(html, /&lt;img/);
});
