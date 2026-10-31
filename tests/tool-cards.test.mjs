import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
const { richCard, parsePatch, highlight, stripAnsi } = await import('../src/tool-cards.ts');

const tool = (name, input, output = '', status = 'completed') => ({ name, status, input: typeof input === 'string' ? input : JSON.stringify(input), output: typeof output === 'string' ? output : JSON.stringify(output) });
const count = (html, needle) => html.split(needle).length - 1;

test('shell: terminal card with command, exit badge, ANSI-stripped tail and earlier-lines footer', () => {
  const out = 'Exit code: 1\nWall time: 2s\nOutput:\n' + Array.from({ length: 20 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\n');
  const html = richCard(tool('Bash', { command: 'npm test' }, out));
  assert.match(html, /tc-term is-failed/);
  assert.match(html, /<code class="tc-command">npm test<\/code>/);
  assert.match(html, /exit 1/);
  assert.match(html, /8 earlier lines/);
  assert.match(html, /line 19/);
  assert.doesNotMatch(html, /line 7\n|\x1b/);
  assert.match(richCard(tool('Bash', { command: 'ls' }, 'a\nExit code: 2')), /exit 2/);
  assert.match(richCard(tool('pandacode_vm_exec', { name: 'dev-vm', command: 'uname' }, 'Darwin')), /on dev-vm/);
  assert.equal(stripAnsi('\x1b]0;title\x07\x1b[1;32mok\x1b[0m'), 'ok');
});

test('read: file header, real line numbers and range', () => {
  const html = richCard(tool('Read', { file_path: '/repo/src/main.ts', offset: 10, limit: 3 }, '    10→const a = 1;\n    11→const b = 2;\n    12→const c = 3;'));
  assert.match(html, /<b>main\.ts<\/b><span class="tc-dir">\/repo\/src<\/span>/);
  assert.match(html, /Lines 10–12/);
  assert.match(html, /<span class="tc-gutter">11<\/span><span class="tc-code">const b = 2;/);
});

test('write: new file with capped preview; the line count stays in the step row', () => {
  const content = Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n');
  const html = richCard(tool('Write', { file_path: 'a/b.md', content }));
  assert.match(html, /New file/);
  assert.doesNotMatch(html, /30 lines/);
  assert.equal(count(html, 'class="tc-line"'), 12);
  assert.match(html, /\+18 more lines/);
});

test('edit: mini unified diff with context and multiedit; the delta stays in the step row only', () => {
  const html = richCard(tool('Edit', { file_path: 'src/x.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }));
  assert.doesNotMatch(html, /tc-delta/);
  assert.match(html, /data-sign="del".*?b<\/span>/s);
  assert.match(html, /data-sign="add".*?B<\/span>/s);
  assert.match(html, /data-sign="ctx"/);
  assert.match(html, /tc-diff is-unnumbered/);
  assert.doesNotMatch(html, /tc-gutter/);
  const multi = richCard(tool('MultiEdit', { file_path: 'y.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] }));
  assert.equal(count(multi, 'data-sign="add"'), 2);
  assert.equal(count(multi, 'data-sign="del"'), 2);
});

test('apply_patch: per-file sections with real hunk numbers', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@ -4,2 +4,2 @@\n keep\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch';
  const files = parsePatch(patch);
  assert.deepEqual(files.map(f => [f.path, f.action]), [['src/a.ts', 'Update'], ['src/b.ts', 'Add']]);
  assert.deepEqual(files[0].lines.map(l => [l.sign, l.old, l.new]), [[' ', 4, 4], ['-', 5, undefined], ['+', undefined, 5]]);
  const html = richCard(tool('apply_patch', { input: patch }));
  assert.equal(count(html, 'tc-diff-file'), 2);
  assert.match(html, /New file/);
  assert.doesNotMatch(html.slice(0, html.indexOf('b.ts</b>')), /is-unnumbered/);
  assert.equal(parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')[0].path, 'x');
});

test('search: grep hits grouped by file with highlighted query; glob and ls list entries', () => {
  const html = richCard(tool('Grep', { pattern: 'icon\\(', path: 'src' }, 'src/a.ts:3:const x = icon("a")\nsrc/a.ts:9:icon(b)\nsrc/b.ts:1:icon(c)'));
  // The step row shows the scope and query; the card leads with what is new.
  assert.match(html, /tc-head-meta">3 matches in 2 files</);
  assert.doesNotMatch(html, /tc-query|in src/);
  assert.equal(count(html, '<mark>icon(</mark>'), 3);
  assert.match(html, /<span class="tc-row-title">a\.ts<\/span>/);
  const glob = richCard(tool('Glob', { pattern: '**/*.ts' }, 'src/a.ts\nsrc/b.ts'));
  assert.equal(count(glob, 'class="tc-row"'), 2);
  assert.doesNotMatch(glob, /tc-head/);
  assert.doesNotMatch(glob, /<mark>/);
  const ls = richCard(tool('LS', { path: '/repo' }, 'src/\nREADME.md'));
  assert.equal(count(ls, 'class="tc-row"'), 2);
  assert.equal(highlight('<a>', /a/gi), '&lt;<mark>a</mark>&gt;');
  assert.equal(highlight('x', /(?:)/g), 'x');
});

test('web search: results with domain mark, title, domain and snippet', () => {
  const out = 'Web search results for query: "tauri"\n\nLinks: [{"title":"Tauri 2","url":"https://www.tauri.app/start"},{"title":"Docs","url":"https://docs.rs/tauri"}]\n';
  const html = richCard(tool('WebSearch', { query: 'tauri' }, out));
  assert.doesNotMatch(html, /tc-head|2 results/);
  assert.match(html, /tc-letter" aria-hidden="true">T</);
  assert.match(html, /tauri\.app/);
  const json = richCard(tool('web_search', { query: 'x' }, [{ title: 'A', url: 'https://a.dev', snippet: 'About A' }]));
  assert.match(json, /About A/);
});

test('web fetch: page card with title, domain/path and excerpt; the prompt stays in the step row', () => {
  const html = richCard(tool('WebFetch', { url: 'https://example.com/docs/a', prompt: 'Summarize' }, '# Example Docs\nSome body text.'));
  assert.match(html, /tc-page/);
  assert.match(html, /Example Docs/);
  assert.match(html, /example\.com\/docs\/a/);
  assert.match(html, /Some body text/);
  assert.doesNotMatch(html, /Summarize|Asked/);
  const code = richCard(tool('WebFetch', { url: 'https://e.com' }, 'Pass `{ sensitivity: "base" }` or `a < b`.'));
  assert.match(code, /Pass <code>\{ sensitivity: &quot;base&quot; \}<\/code> or <code>a &lt; b<\/code>\./);
  const untitled = richCard(tool('WebFetch', { url: 'https://e.com/a' }, 'plain text'));
  assert.equal(count(untitled, 'e.com'), 1);
});

test('todo and update_plan: status circles and progress', () => {
  const html = richCard(tool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }, { content: 'c', status: 'pending' }] }, '', 'running'));
  assert.match(html, /1 of 3 done/);
  for (const s of ['completed', 'in_progress', 'pending']) assert.match(html, new RegExp(`tc-status" data-status="${s}"`));
  assert.match(html, /Doing b/);
  const plan = richCard(tool('update_plan', { explanation: 'why', plan: Array.from({ length: 14 }, (_, i) => ({ step: `s${i}`, status: 'pending' })) }));
  assert.match(plan, /\+4 more steps/);
  assert.match(plan, /why/);
});

test('agent and skill cards', () => {
  const agent = richCard(tool('Task', { subagent_type: 'Explore', description: 'Find callers', prompt: 'Look for icon()' }, 'Found 3 callers in src.'));
  assert.match(agent, /tc-agent/);
  // Type and description are the step row's; the card adds the prompt, the state and the result.
  assert.doesNotMatch(agent, /Explore|Find callers/);
  assert.match(agent, /Look for icon\(\).*Done/s);
  assert.match(agent, /Found 3 callers/);
  const skill = richCard(tool('Skill', { skill: 'pdf', args: 'merge' }, 'description: Work with PDFs'));
  assert.equal(skill, '<div class="tc" data-kind="skill"><p class="tc-excerpt">Work with PDFs</p></div>');
  assert.doesNotMatch(skill, /tc-pill/);
  assert.equal(richCard(tool('Skill', { skill: 'simplify' }, 'Launching skill: simplify')), '');
});

test('PandaCode tools: workers, title, design, vm screenshot, preview', () => {
  const workers = richCard(tool('pandacode_dispatch_workers', { workers: [{ name: 'UI', model: 'sonnet', assignment: 'Build cards' }, { name: 'Core', model: 'opus', assignment: 'Wire it' }] }, '', 'running'));
  assert.doesNotMatch(workers, /2 workers|Workers/);
  assert.match(workers, /UI.*sonnet.*Build cards/s);
  // Architect-served tools arrive namespaced as MCP; they still get PandaCode cards.
  const served = richCard(tool('mcp__pandacode_architect__pandacode_dispatch_workers', { workers: [{ name: 'Search fix', model: 'opus', prompt: 'Normalize the query.' }] }));
  assert.match(served, /Search fix<\/span><span class="tc-row-meta">opus<\/span>.*Normalize the query\./s);
  assert.match(richCard(tool('pandacode_title', { title: 'Better traces' })), /Task title.*Better traces/s);
  assert.match(richCard(tool('pandacode_design_write', { name: 'home', html: '<div>\n</div>', width: 1280, height: 800 })), /home.*Design artboard · 1280 × 800.*2 lines/s);
  assert.match(richCard(tool('pandacode_vm_screenshot', { name: 'mac' }, 'Captured 1280x800')), /mac.*Screenshot · 1280 × 800/s);
  assert.match(richCard(tool('pandacode_preview_file', { path: 'out/index.html' })), /index\.html.*Opened in preview/s);
});

test('MCP: input key/values and JSON records as reference rows with +N more', () => {
  const records = Array.from({ length: 9 }, (_, i) => ({ title: `Issue ${i}`, state: 'open', updated_at: '2024-10-28T08:12:00Z', description: `Body ${i}` }));
  const html = richCard(tool('mcp__linear__list_issues', { team: 'ENG', limit: 9 }, [{ type: 'text', text: JSON.stringify(records) }]));
  // Server and tool name are the step row's.
  assert.doesNotMatch(html, /tc-head|list issues/);
  assert.match(html, /<dt>team<\/dt><dd>ENG<\/dd>/);
  assert.equal(count(html, 'class="tc-row"'), 6);
  assert.match(html, /\+3 more/);
  assert.match(html, /tc-row-time">Oct 28</);
  assert.match(html, /Body 0/);
  assert.match(richCard(tool('mcp__x__get', {}, { a: 1, nested: { b: 2 } })), /<dt>nested<\/dt><dd>1 field<\/dd>/);
  // Docs-style results with only a title and a link use the link as the meta.
  const docs = richCard(tool('mcp__docs__search_docs', { query: 'q' }, { results: [{ title: 'Search index', url: 'https://docs.example.com/search-index' }, { name: 'Ask', prompt: 'How to?' }] }));
  assert.match(docs, /Search index<\/span><span class="tc-row-meta">docs\.example\.com\/search-index</);
  assert.match(docs, /How to\?/);
  // The query is the step row's object (`Searched docs for q`), so it is not repeated as a field.
  assert.doesNotMatch(docs, /tc-kv|<dt>query/);
});

test('running status line and failed state', () => {
  const running = richCard(tool('Bash', { command: 'sleep 1' }, '', 'running'));
  assert.match(running, /<p class="tc-running" role="status">Running command…<\/p>/);
  assert.doesNotMatch(running, /tc-bar|tc-skeleton/);
  // The terminal header is already the final one, so only the output area changes when output lands.
  const head = '<div class="tc-term-head"><span class="tc-dollar" aria-hidden="true">$</span><code class="tc-command">sleep 1</code></div>';
  assert.ok(running.includes(head));
  assert.ok(richCard(tool('Bash', { command: 'sleep 1' }, 'done')).includes(head));
  assert.equal(richCard(tool('Grep', { pattern: 'x' }, '', 'running')), '<div class="tc" data-kind="search"><p class="tc-running" role="status">Searching…</p></div>');
  const failed = richCard(tool('mcp__gh__get_pr', { n: 1 }, 'Error: <boom>', 'failed'));
  assert.match(failed, /tc-failed/);
  assert.match(failed, /&lt;boom&gt;/);
  assert.equal(richCard(tool('unknown_tool', {}, 'x')), '');
});

test('escapes every user-controlled string', () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const cases = [
    tool('Bash', { command: evil }, evil),
    tool('Read', { file_path: evil }, evil),
    tool('Write', { file_path: evil, content: evil }),
    tool('Edit', { file_path: evil, old_string: evil, new_string: 'b' }),
    tool('Grep', { pattern: evil }, `${evil}:1:${evil}`),
    tool('WebSearch', { query: evil }, [{ title: evil, url: 'https://e.com', snippet: evil }]),
    tool('WebFetch', { url: 'https://e.com', prompt: evil }, evil),
    tool('TodoWrite', { todos: [{ content: evil, status: evil }] }),
    tool('Task', { subagent_type: evil, description: evil }, evil),
    tool('Skill', { skill: evil }, evil),
    tool('pandacode_dispatch_workers', { workers: [{ name: evil, model: evil }] }),
    tool('mcp__s__t', { [evil]: evil }, [{ title: evil, body: evil }]),
  ];
  for (const t of cases) {
    const html = richCard(t);
    assert.ok(html, `${t.name} renders`);
    assert.doesNotMatch(html, /<img src=x|onerror=alert\(1\)>"/, t.name);
  }
});

test('bounds huge inputs', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `src/f${i}.ts:${i}:match ${'x'.repeat(500)}`).join('\n');
  const html = richCard(tool('Grep', { pattern: 'match' }, big));
  assert.ok(count(html, 'class="tc-row"') <= 6);
  assert.match(html, /more files/);
  assert.ok(html.length < 20_000);
  const diff = richCard(tool('Edit', { file_path: 'a', old_string: Array(200).fill('o').join('\n'), new_string: Array(200).fill('n').join('\n') }));
  assert.ok(count(diff, 'tc-diff-line') <= 18);
});
