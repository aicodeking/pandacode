import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, mcpAction, mcpCard, summarizeTools, summaryIcons, toolPreview, traceRowHtml, shellCommand, toolKind } from '../src/tool-trace.ts';
import { richCard } from '../src/tool-cards.ts';

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
    [tool('Skill', { skill: 'simplify', args: 'src/lib' }), 'skill', 'Loaded skill', 'simplify', 'src/lib'],
    [tool('mcp__github__list_issues', {}), 'mcp', 'Read the', 'GitHub', 'issues'],
    [tool('mcp__slack__search_messages', { query: 'messages since yesterday' }), 'mcp', 'Searched', 'Slack', 'for messages since yesterday'],
    [tool('mcp__claude_ai_Granola__get_meetings', { query: 'notes from today’s calls' }, { status: 'running' }), 'mcp', 'Read the', 'Granola', 'notes from today’s calls'],
    [tool('mcp__acme__deploy_site', {}), 'mcp', 'Used', 'acme', 'deploy site'],
    [tool('pandacode_dispatch_workers', { workers: [{}, {}] }), 'mcp', 'Dispatched', 'PandaCode', '2 workers'],
    [tool('pandacode_architect_pandacode_title', { title: 'Traces' }), 'mcp', 'Named', 'PandaCode', 'the task “Traces”'],
    [tool('mcp__pandacode_architect__pandacode_dispatch_workers', { workers: [{}] }), 'mcp', 'Dispatched', 'PandaCode', '1 worker'],
    [tool('Write', { file_path: 'one.md', content: 'x' }), 'write', 'Wrote', 'one.md', '1 line'],
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
  assert.equal(describeTool(tool('mcp__slack__search_messages', {})).icon, 'search');
  assert.equal(describeTool(tool('mcp__linear__list_issues', {})).icon, 'file');
  assert.match(describeTool(tool('mcp__slack__search_messages', {})).chip.svg, /brand-icon/);
  assert.deepEqual(['search_messages', 'slack_search_public', 'list_pull_requests', 'get_meetings', 'deploy_site'].map(mcpAction), ['search', 'search', 'read', 'read', undefined]);
  assert.match(traceRowHtml(describeTool(tool('mcp__gmail__search_threads', { query: 'unread threads' }))), /tool-trace-verb">Searched<\/span><span class="tool-trace-chip" title="mcp__gmail__search_threads"><svg class="brand-icon"[^]*<b>Gmail<\/b><\/span><span class="tool-trace-object">for unread threads</);
});

test('rows read as finished sentences even while running', () => {
  assert.equal(describeTool(tool('Bash', { command: 'ls' }, { status: 'running' })).verb, 'Ran');
  assert.equal(describeTool(tool('Read', { file_path: 'a' }, { status: 'running' })).verb, 'Read');
  assert.equal(describeTool(tool('WebSearch', { query: 'q' }, { status: 'running' })).verb, 'Searched');
  assert.equal(describeTool(tool('Skill', { skill: 's' }, { status: 'running' })).verb, 'Loaded skill');
  // Only brand marks sit inside the chip; a line icon would repeat the row's kind icon.
  assert.match(traceRowHtml(describeTool(tool('Read', { file_path: 'src/a.ts' }))), /tool-trace-chip" title="src\/a\.ts"><b>a\.ts<\/b>/);
  assert.equal(describeTool(tool('pandacode_dispatch_workers', {}, { status: 'running' })).verb, 'Dispatched');
});

test('summaries pluralise, merge verbs and report running and failures', () => {
  const bash = tool('Bash', { command: 'ls' }), read = tool('Read', { file_path: 'a' });
  // Two counts at most, then `and N more`, so the folded summary stays on one line.
  assert.equal(summarizeTools([bash, bash, bash, read, read, tool('Edit', {})]), 'Ran 3 commands, read 2 files and 1 more step');
  assert.equal(summarizeTools([tool('Grep', {}), tool('WebSearch', {}), read, read, read]), 'Ran 2 searches and read 3 files');
  assert.equal(summarizeTools([{ ...bash, status: 'running' }, bash], { live: true }), 'Running 2 commands…');
  // A saved record stuck at `running` still reads as finished.
  assert.equal(summarizeTools([{ ...bash, status: 'running' }, bash]), 'Ran 2 commands');
  assert.equal(summarizeTools([bash, { ...read, status: 'failed' }]), 'Ran 1 command and read 1 file · 1 failed');
  assert.equal(summarizeTools([undefined]), 'Used 1 tool');
  assert.equal(summarizeTools([tool('TodoWrite', {})]), 'Updated the plan');
  const brief = ['mcp__slack__search_messages', 'mcp__granola__get_meetings', 'mcp__gmail__search_threads', 'mcp__github__list_pull_requests', 'mcp__linear__list_issues'].map(name => tool(name, {}));
  assert.equal(summarizeTools(brief), 'Ran 2 searches and read 3 sources');
  assert.equal(summarizeTools([...brief, read]), 'Ran 2 searches, read 3 sources and 1 more step');
  assert.equal(summarizeTools([{ ...brief[0], status: 'running' }, brief[1]], { live: true }), 'Running 1 search and reading 1 source…');
  const marks = summaryIcons(brief);
  assert.equal(marks.length, 3);
  assert.ok(marks.every(mark => mark.includes('brand-icon')));
  assert.equal(summaryIcons([bash, bash, read]).length, 2);
});

test('MCP results become brand rows: marks, title, meta, time, body and +N more', () => {
  const json = value => JSON.stringify(value);
  const slack = mcpCard(tool('mcp__slack__search_messages', {}, { output: json({ messages: [
    { user: 'Jane Doe', channel: '#support', ts: '9:41', text: 'Two tickets.' },
    { user: { name: 'Sam Lee' }, channel: '#deploys', ts: '11:02', text: 'fix: retry' },
    { user: 'Alex Kim', channel: '#general', ts: '14:15', text: 'Huddle at 3?' },
    { user: 'Priya Shah', channel: '#design', ts: '15:30', text: 'Mocks' },
  ] }) }));
  assert.match(slack, /class="tool-trace-card is-rows" data-trace-kind="mcp" data-brand="slack"/);
  assert.match(slack, /trace-mark is-avatar">J<\/span><span class="trace-row-head"><b>Jane Doe<\/b><span class="trace-row-meta">#support<\/span><\/span><span class="trace-row-time">9:41<\/span><span class="trace-row-body">Two tickets.<\/span>/);
  assert.match(slack, /<b>Sam Lee<\/b>/);
  assert.ok(!slack.includes('Priya'));
  assert.match(slack, /tool-trace-more">\+1 more</);
  const gmail = mcpCard(tool('mcp__gmail__search_threads', {}, { output: json([{ type: 'text', text: json({ threads: [{ subject: 'Re: Signed contract', from: 'Jane Doe', time: '8:12', unread: true, snippet: 'Attached' }, { subject: 'Invoice', from: 'Billing', unread: false }] }) }]) }));
  assert.match(gmail, /<li class="trace-row" data-unread><span class="trace-mark is-unread" data-unread><\/span><span class="trace-row-head"><b>Re: Signed contract<\/b><span class="trace-row-meta">Jane Doe/);
  assert.match(gmail, /<span class="trace-mark is-unread"><\/span><span class="trace-row-head"><b>Invoice<\/b>/);
  const github = mcpCard(tool('mcp__github__list_pull_requests', {}, { output: json({ pull_requests: [{ title: 'Retry', identifier: 'acme/app#128', state: 'merged', time: '2h' }, { title: 'Export', identifier: 'acme/app#131', state: 'open' }] }) }));
  assert.match(github, /trace-mark is-pull" data-state="merged"/);
  assert.match(github, /data-state="open"[^]*<b>Export<\/b><span class="trace-row-meta">acme\/app#131/);
  const linear = mcpCard(tool('mcp__linear__list_issues', {}, { output: json({ issues: [{ title: 'CSV', identifier: 'ENG-142', state: 'In Progress' }, { title: 'Dupes', identifier: 'ENG-139', status: 'Todo' }, { title: 'Ship', identifier: 'ENG-120', state: 'Done' }] }) }));
  assert.deepEqual([...linear.matchAll(/is-issue" data-state="(\w+)"/g)].map(match => match[1]), ['progress', 'todo', 'done']);
  const granola = mcpCard(tool('mcp__granola__get_meetings', {}, { output: json({ meetings: [{ title: 'Kickoff', author: 'Jane, Sam', time: '10:00' }] }) }));
  assert.match(granola, /<span class="trace-mark"><svg class="brand-icon"[^]*<b>Kickoff<\/b><span class="trace-row-meta">Jane, Sam/);
  // Unparseable or list-free output falls through to the rich card or the excerpt.
  const plain = tool('mcp__slack__search_messages', {}, { output: 'no results' });
  assert.equal(mcpCard(plain), '');
  assert.equal(mcpCard(tool('mcp__x__get', {}, { output: '{"ok":true}' })), '');
  assert.equal(mcpCard(tool('Bash', { command: 'ls' }, { output: '[{"title":"x"}]' })), '');
  assert.ok(toolPreview(plain).length > 0);
});

test('previews prefer the MCP card, then the rich card inside the shared card chrome', () => {
  for (const input of [
    tool('Command', 'ls', { output: 'Exit code: 2\nOutput:\nline 1' }),
    tool('Read', 'src/a.ts', { output: 'one\ntwo\nthree' }),
    tool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }),
    tool('TodoWrite', { todos: [{ content: 'Ship', status: 'completed' }] }),
  ]) {
    assert.ok(richCard(input), input.name);
    assert.equal(toolPreview(input), `<div class="tool-trace-card" data-trace-kind="${toolKind(input.name)}">${richCard(input)}</div>`, input.name);
  }
  const mcp = tool('mcp__linear__list_issues', {}, { output: '{"issues":[{"title":"CSV","state":"todo"}]}' });
  assert.equal(toolPreview(mcp), mcpCard(mcp));
  // PandaCode's own tools and docs servers use the rich card first (workers with prompts, docs with URLs).
  for (const own of [
    tool('mcp__pandacode_architect__pandacode_dispatch_workers', { workers: [{ name: 'A', prompt: 'Do it', model: 'opus' }] }, { output: '{"workers":[{"name":"A","status":"started"}]}' }),
    tool('mcp__docs__search_docs', { query: 'index' }, { output: '{"results":[{"title":"Search index","url":"https://docs.example.com/search-index"}]}' }),
  ]) {
    assert.ok(richCard(own), own.name);
    assert.equal(toolPreview(own), `<div class="tool-trace-card" data-trace-kind="mcp">${richCard(own)}</div>`, own.name);
  }
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
  assert.ok(!/data-status="">/.test(html));
  assert.match(html, /&lt;img/);
  const card = mcpCard(tool('mcp__slack__search_messages', {}, { output: JSON.stringify({ messages: [{ user: unsafe, channel: unsafe, ts: unsafe, text: unsafe, state: unsafe }] }) }));
  assert.ok(card.includes('&lt;img') && !card.includes('<img'));
});
