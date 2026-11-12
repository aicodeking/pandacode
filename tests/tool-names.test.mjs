import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePathOf, normalizeTool } from '../src/tool-names.ts';
import { pandacodeTool } from '../src/tool-trace-pandacode.ts';

const tool = (name, input = '', output = '') => ({ name, status: 'completed', input: typeof input === 'string' ? input : JSON.stringify(input), output });
const norm = (name, input, output) => {
  const t = normalizeTool(tool(name, input, output));
  return { name: t.name, input: t.input ? JSON.parse(t.input) : t.input };
};

test('Devin shell titles become Bash', () => {
  // Devin's plain-text input is the command's output: the programs come from the title and the text becomes the output.
  const ran = normalizeTool(tool('Ran python3, rg in ./src', '56:class Shot:'));
  assert.deepEqual([ran.name, JSON.parse(ran.input), ran.output], ['Bash', { _programs: ['python3', 'rg'], _where: './src' }, '56:class Shot:']);
  assert.deepEqual(norm('Ran git', { command: 'git status' }), { name: 'Bash', input: { command: 'git status' } });
  assert.deepEqual(norm('Ran sleep', 'ok'), { name: 'Bash', input: { _programs: ['sleep'] } });
  assert.deepEqual(norm('Ran npx, echo', { command: 'npx tsc && echo ok' }), { name: 'Bash', input: { command: 'npx tsc && echo ok' } });
});

test('Devin file, shell and MCP titles', () => {
  assert.deepEqual(norm('Read file', { file_path: '/repo/a.ts' }, 'line'), { name: 'Read', input: { file_path: '/repo/a.ts' } });
  assert.deepEqual(norm('Read file', { file_path: '/tmp/v4f/v3e.jpg' }, 'View image /private/tmp/v4f/v3e.jpg (1920x1080)'),
    { name: 'ViewImage', input: { path: '/tmp/v4f/v3e.jpg' } });
  assert.equal(norm('Edit file', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }).name, 'Edit');
  assert.deepEqual(norm('Read shell', { shell_id: 'f50fcf', timeout: 280000 }), { name: 'BashOutput', input: { shell_id: 'f50fcf', timeout: 280000 } });
  const called = norm('Called pandacode_send_team_message from pandacode_architect', { to: 'x', body: 'hi' });
  assert.deepEqual(called, { name: 'mcp__pandacode_architect__pandacode_send_team_message', input: { to: 'x', body: 'hi' } });
  assert.equal(pandacodeTool(called.name), 'send_team_message');
  assert.deepEqual(norm('Listed MCP tools for pandacode_architect', { server_name: 'pandacode_architect' }),
    { name: 'ListMcpTools', input: { server: 'pandacode_architect' } });
});

test('Kimi titles', () => {
  assert.deepEqual(norm('Reading /Users/dev/x.ts', { path: '/Users/dev/x.ts' }), { name: 'Read', input: { path: '/Users/dev/x.ts', file_path: '/Users/dev/x.ts' } });
  assert.equal(norm('Reading src/main.ts', '').input.file_path, 'src/main.ts');
  const media = tool('Reading media: /tmp/a.png', { path: '/tmp/a.png' }, '[{"type":"text","text":"<image path=/tmp/a.png>"},{"type":"image_url"}]');
  assert.deepEqual(norm(media.name, media.input, media.output), { name: 'ViewImage', input: { path: '/tmp/a.png' } });
  assert.equal(imagePathOf(media), '/tmp/a.png');
  const write = norm('Writing /tmp/x.mjs', { path: '/tmp/x.mjs', content: 'x' }, 'Wrote 473 bytes to /tmp/x.mjs');
  assert.deepEqual(write, { name: 'Write', input: { path: '/tmp/x.mjs', content: 'x', file_path: '/tmp/x.mjs' } });
  const edit = norm('Editing /tmp/x.mjs', { path: '/tmp/x.mjs', new_string: 'b', old_string: 'a' });
  assert.equal(edit.name, 'Edit');
  assert.equal(edit.input.file_path, '/tmp/x.mjs');
  assert.deepEqual(norm('Running: cd "/Users/k"…', { command: 'cd "/Users/k" && ls' }), { name: 'Bash', input: { command: 'cd "/Users/k" && ls' } });
  assert.deepEqual(norm('Running: ls -la', ''), { name: 'Bash', input: { command: 'ls -la' } });
  assert.deepEqual(norm('Updating todo list', { todos: [{ status: 'done', title: 'A' }, { status: 'in_progress', title: 'B' }] }),
    { name: 'TodoWrite', input: { todos: [{ status: 'completed', content: 'A' }, { status: 'in_progress', content: 'B' }] } });
});

test('Command Code Read: path', () => {
  assert.deepEqual(norm('Read: /abs/p.ts', { file_path: '/abs/p.ts', offset: 1, limit: 20 }), { name: 'Read', input: { file_path: '/abs/p.ts', offset: 1, limit: 20 } });
  assert.deepEqual(norm('Read: /abs/p.ts', 'garbage'), { name: 'Read', input: { file_path: '/abs/p.ts' } });
});

test('Muse and Deepseek snake_case names', () => {
  assert.deepEqual(norm('bash', { command: 'ls' }), { name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(norm('read_file', { path: 'a.ts' }), { name: 'Read', input: { path: 'a.ts', file_path: 'a.ts' } });
  assert.equal(norm('write_file', { path: 'a.ts', content: '' }).name, 'Write');
  assert.equal(norm('edit_file', { path: 'a.ts' }).name, 'Edit');
  assert.deepEqual(norm('search', { pattern: 'x' }), { name: 'Grep', input: { pattern: 'x' } });
  assert.deepEqual(norm('read_skill', { name: 'systematic-debugging' }), { name: 'Skill', input: { skill: 'systematic-debugging' } });
  assert.deepEqual(norm('write_todos', { todos: [{ content: 'a', status: 'pending' }] }), { name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } });
});

test('Codex titles', () => {
  assert.deepEqual(norm('View image', { path: '/tmp/s.webp' }), { name: 'ViewImage', input: { path: '/tmp/s.webp' } });
  assert.equal(imagePathOf(tool('View image', { path: '/tmp/s.webp' })), '/tmp/s.webp');
  assert.deepEqual(norm('web_search', { query: 'tauri' }), { name: 'WebSearch', input: { query: 'tauri' } });
  // Legacy items: an empty imageView and webSearch, and `Update files` with a diff per file.
  assert.deepEqual(norm('imageView', ''), { name: 'ViewImage', input: {} });
  assert.deepEqual(norm('webSearch', ''), { name: 'WebSearch', input: {} });
  assert.deepEqual(norm('Update files', 'update /r/a.ts', '/r/a.ts\n@@ -1 +1 @@\n-a\n+b'),
    { name: 'apply_patch', input: { file_path: '/r/a.ts', files: ['/r/a.ts'], patch: '*** Update File: /r/a.ts\n@@ -1 +1 @@\n-a\n+b', _added: 1, _removed: 1 } });
  for (const name of ['sleep', 'Compact context', 'Command']) {
    const t = tool(name, 'x');
    assert.equal(normalizeTool(t), t, name);
  }
});

test('Claude names', () => {
  const img = tool('Read', { file_path: 'x.png' }, '[Non-text content omitted]');
  assert.equal(normalizeTool(img).name, 'Read');
  assert.equal(imagePathOf(img), 'x.png');
  assert.equal(imagePathOf(tool('Read', { file_path: 'x.ts' })), '');
  assert.deepEqual(norm('BashOutput', { bash_id: 'b1' }), { name: 'BashOutput', input: { bash_id: 'b1', shell_id: 'b1' } });
  for (const name of ['TaskStop', 'KillShell', 'ToolSearch', 'Bash', 'mcp__github__list_issues']) {
    const t = tool(name, { query: 'select:A,B' });
    assert.equal(normalizeTool(t), t, name);
  }
});

test('image paths from Devin output and non-image tools', () => {
  assert.equal(imagePathOf(tool('Read file', '', 'View image /private/tmp/v.jpeg (10x10)')), '/private/tmp/v.jpeg');
  assert.equal(imagePathOf(tool('Ran git', 'git log')), '');
  assert.equal(imagePathOf(tool('Reading media: /tmp/a.GIF', '')), '/tmp/a.GIF');
});

test('never mutates the input tool', () => {
  const t = Object.freeze(tool('Updating todo list', { todos: [{ status: 'done', title: 'A' }] }));
  const out = normalizeTool({ ...t, id: 7 });
  assert.notEqual(out, t);
  assert.equal(out.id, 7);
  assert.equal(t.name, 'Updating todo list');
});

// Title-named rows from the recorded database (home paths shortened). Devin's plain-text input is the call's result.
const full = (name, input, output) => {
  const t = normalizeTool(tool(name, input, output));
  return { name: t.name, input: t.input ? JSON.parse(t.input) : t.input, output: t.output };
};

test('Devin search, find, list and fetch titles', () => {
  assert.deepEqual(full("Search for 'fn open_external_url'", 'lib.rs\nfile:///Users/me/p/src-tauri/src/lib.rs'),
    { name: 'Grep', input: { pattern: 'fn open_external_url' }, output: 'lib.rs\nfile:///Users/me/p/src-tauri/src/lib.rs' });
  assert.deepEqual(full('Searched for profile in ./src-tauri/Cargo.toml', '70:[profile.release]\n71-lto = "thin"'),
    { name: 'Grep', input: { pattern: 'profile', path: './src-tauri/Cargo.toml' }, output: '70:[profile.release]\n71-lto = "thin"' });
  assert.deepEqual(full("Search for 'sentPrompt|mirrorPrompt|r", 'a.ts').input, { pattern: 'sentPrompt|mirrorPrompt|r' });
  assert.deepEqual(full('Searched web for Arch-Router 1.5B', { query: 'Arch-Router 1.5B', num_results: 4 }, 'Found 4 result(s)'),
    { name: 'WebSearch', input: { query: 'Arch-Router 1.5B', num_results: 4 }, output: 'Found 4 result(s)' });
  assert.deepEqual(full('Find files matching `**/*connect*`', 'connect.ts\nfile:///Users/me/p/src/connect.ts').input, { pattern: '**/*connect*' });
  assert.equal(full('Find files matching `**/*connect*`', '').name, 'Glob');
  assert.deepEqual(full('Find files matching `node_modules/**/trace.zip`', { query: 'node_modules/**/trace.zip' }).input, { query: 'node_modules/**/trace.zip', pattern: 'node_modules/**/trace.zip' });
  assert.deepEqual(full('Listed ./data/cache', 't0423.00.jpg\nt0425.70.jpg'), { name: 'LS', input: { path: './data/cache' }, output: 't0423.00.jpg\nt0425.70.jpg' });
  assert.deepEqual(full('Listed ./a/check, ./a/check/assets', 'check:\ntotal 584').input, { path: './a/check', paths: ['./a/check', './a/check/assets'] });
  assert.deepEqual(full('Fetched https://help.openai.com/en/articles/1', { url: 'https://help.openai.com/en/articles/1' }, 'Fetched 1840 characters from https://help.openai.com/en/articles/1'),
    { name: 'WebFetch', input: { url: 'https://help.openai.com/en/articles/1' }, output: 'Fetched 1840 characters from https://help.openai.com/en/articles/1' });
  assert.deepEqual(full('Kill shell', { shell_id: '4323f2' }), { name: 'KillShell', input: { shell_id: '4323f2' }, output: '' });
  // `Listed MCP tools for …` keeps its own rule.
  assert.equal(full('Listed MCP tools for pandacode_architect', { server_name: 'pandacode_architect' }).name, 'ListMcpTools');
});

test('Devin read and write titles', () => {
  assert.deepEqual(full('Read ./src-tauri/src/remote/mirror.rs', '     1  //! Mirrors'),
    { name: 'Read', input: { file_path: './src-tauri/src/remote/mirror.rs' }, output: '     1  //! Mirrors' });
  assert.deepEqual(full('Read lines 12-36 in ./src/palette.ts', '12 a').input, { file_path: './src/palette.ts', offset: 12, limit: 25 });
  assert.deepEqual(full('Read last 22 lines in /private/var/T/content.txt', 'x').input, { file_path: '/private/var/T/content.txt' });
  assert.deepEqual(full('Read ./a/starts.json, lines 1-30 in ./a/snap.mjs', '{').input, { file_path: './a/starts.json', files: ['./a/starts.json', './a/snap.mjs'] });
  // Reads that are not titles stay as they were.
  assert.equal(full('Read file', { file_path: '/r/a.ts' }).name, 'Read');
  assert.equal(full('Read shell', { shell_id: 'a' }).name, 'BashOutput');
  const wrote = full('Wrote ./tests/test_serve.py', '/Users/me/P/tests/test_serve.py\n--- Before\n\n+++ After\nimport json\nimport sqlite3\n');
  assert.deepEqual(wrote.input, { file_path: '/Users/me/P/tests/test_serve.py', content: 'import json\nimport sqlite3' });
  assert.equal(wrote.name, 'Write');
  const cut = full('Wrote ./a.py', '/Users/me/P/a.py\n--- Before\n\n+++ After\nimport js\n[Preview truncated]');
  assert.deepEqual(cut.input, { file_path: '/Users/me/P/a.py', content: 'import js', _partial: true });
});

test('Kimi search, skill, background and fetch titles', () => {
  const grep = { path: 'src/main.ts', pattern: 'live-activity|paintLive', '-n': true, output_mode: 'content' };
  assert.deepEqual(full("Searching for 'live-activity|paintLive' in src/main.ts", grep).input, grep);
  assert.equal(full("Searching for 'live-activity|paintLive' in src/main.ts", grep).name, 'Grep');
  assert.deepEqual(full('Searching **/*', { path: '/Users/me/runs/project', pattern: '**/*', head_limit: 200 }, 'No matches found').name, 'Glob');
  assert.deepEqual(full('Invoke skill verification-before-completion', { skill: 'verification-before-completion', args: 'Finalize' }),
    { name: 'Skill', input: { skill: 'verification-before-completion', args: 'Finalize' }, output: '' });
  assert.deepEqual(full('Invoke skill brainstorming', '').input, { skill: 'brainstorming' });
  const bg = full('Starting background: cargo test --manifest-path src-tauri/Cargo.toml --…', { command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib storage::', description: 'Run Rust storage unit tests' });
  assert.deepEqual(bg.input, { command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib storage::', description: 'Run Rust storage unit tests', run_in_background: true });
  assert.equal(bg.name, 'Bash');
  assert.deepEqual(full('Fetching: https://matharena.ai', { url: 'https://matharena.ai' }).name, 'WebFetch');
  assert.deepEqual(full('Fetching: https://dev.fitbit.com/build/hea…', '').input, { url: 'https://dev.fitbit.com/build/hea' });
});

test('Command Code `Verb:` titles and shell_output', () => {
  const edit = { file_path: '/Users/me/p/bench.mjs', new_string: 'b', old_string: 'a', replace_all: false };
  assert.deepEqual(full('Edit: /Users/me/p/bench.mjs', edit).input, edit);
  assert.equal(full('Edit: /Users/me/p/bench.mjs', edit).name, 'Edit');
  assert.deepEqual(full('Write: /Users/me/p/model_health...', { file_path: '/Users/me/p/model_health.rs', content: 'use std;' }).input, { file_path: '/Users/me/p/model_health.rs', content: 'use std;' });
  assert.equal(full('Write: /Users/me/p/x.rs', { file_path: '/Users/me/p/x.rs', content: '' }).name, 'Write');
  assert.deepEqual(full('List: /Users/me/p/scripts/release', { path: '/Users/me/p/scripts/release', exclude: [] }).name, 'LS');
  const search = { path: 'src-tauri/src/model_health.rs', pattern: 'pub fn healthy', '-n': true, glob: '*.rs' };
  assert.deepEqual(full('Search: pub fn healthy', search), { name: 'Grep', input: search, output: '' });
  // The shell title carries the (possibly clipped) command; the plain-text input is its output.
  const shell = full('Shell: node --check scripts/bench/memory.mjs', '', '');
  assert.deepEqual(shell, { name: 'Bash', input: { command: 'node --check scripts/bench/memory.mjs' }, output: '' });
  const clipped = full('Shell: rustfmt --edition 2021 src/model_health.rs && cargo t...', '\nrunning 0 tests\n', '\nrunning 7 tests\n');
  assert.deepEqual(clipped, { name: 'Bash', input: { command: 'rustfmt --edition 2021 src/model_health.rs && cargo t', _partial: true }, output: '\nrunning 7 tests\n' });
  assert.equal(full('Shell: ls', 'a\nb', '').output, 'a\nb');
  assert.deepEqual(full('shell_output', { block: true, id: 's2clkkkt', max_chars: 4000, wait: 'exit' }).input, { block: true, id: 's2clkkkt', max_chars: 4000, wait: 'exit', shell_id: 's2clkkkt' });
  assert.equal(full('shell_output', { id: 's2' }).name, 'BashOutput');
  const many = full('Read: ', { file_path: '', paths: ['/Users/me/p/src/a.ts', '/Users/me/p/src/b.ts'] });
  assert.deepEqual([many.name, many.input.file_path, many.input.files], ['Read', '/Users/me/p/src/a.ts', ['/Users/me/p/src/a.ts', '/Users/me/p/src/b.ts']]);
});

test('Muse bash_input: a terminate stops the shell, anything else reads it', () => {
  assert.deepEqual(full('bash_input', '{"session_id":7,"terminate":true}').input, { session_id: 7, terminate: true, shell_id: '7' });
  assert.equal(full('bash_input', '{"session_id":7,"terminate":true}').name, 'KillShell');
  assert.equal(full('bash_input', '{"session_id":12,"yield_time_ms":5000}').name, 'BashOutput');
  assert.equal(full('bash_input', '{"session_id":12,"yield_time_ms":5000}').input.shell_id, '12');
});
