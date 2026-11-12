import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document ??= { documentElement: { dataset: {} } };
import { summarizeTools } from '../src/tool-trace.ts';

const tool = (name, input, extra = {}) => ({ name, status: 'completed', input: JSON.stringify(input), output: '', ...extra });
const read = tool('Read', { file_path: '/repo/a.ts' });
const edit = tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' });
const write = tool('Write', { file_path: '/repo/b.ts', content: 'x' });
const fetch = tool('WebFetch', { url: 'https://a.dev' });
const todo = tool('TodoWrite', { todos: [] });
const grep = tool('Grep', { pattern: 'x' });
const npmTest = tool('Bash', { command: 'npm test' });
const ls = tool('Bash', { command: 'ls src' });
const mcp = tool('mcp__acme__deploy_site', {});
const failedEdit = tool('Edit', { file_path: '/repo/c.ts', old_string: 'x', new_string: 'y' }, { status: 'failed', output: '<tool_use_error>String to replace not found in file.</tool_use_error>' });
const panda = name => tool(`mcp__pandacode_architect__pandacode_${name}`, {});

test('what a summary leaves out is its last part: a single leftover is named, more read `and N more steps`', () => {
  // One step more than the biggest hidden entry: named, never `, +1 more step`.
  assert.equal(summarizeTools([read, edit, todo, fetch, fetch, fetch]), 'Read 1 file, edited 1 file, updated the plan and fetched 3 pages');
  const image = tool('Read', { file_path: '/tmp/a.png' }, { output: '[Non-text content omitted]' });
  assert.equal(summarizeTools([ls, edit, image, image, fetch]), 'Ran 1 command, edited 1 file, viewed 2 images and fetched 1 page');
  const sentence = summarizeTools([read, edit, write, write, todo, fetch]);
  assert.equal(sentence, 'Read 1 file, edited 1 file, wrote 2 files and 2 more steps');
  // A failed-edit clause stays inside the list; the count closes it.
  assert.equal(summarizeTools([read, edit, write, write, todo, fetch, failedEdit]), "Read 1 file, edited 1 file, wrote 2 files, couldn't edit 1 file and 2 more steps");
  // One hidden group is still named in full.
  assert.equal(summarizeTools([read, edit, fetch]), 'Read 1 file, edited 1 file and fetched 1 page');
});

test('no summary trails a `, +N` or names `other steps`', () => {
  const pool = [read, edit, write, fetch, todo, grep, npmTest, ls, mcp, failedEdit, panda('vm_list'), panda('design_write')];
  for (let start = 0; start < pool.length; start++) {
    for (let size = 2; size <= pool.length; size++) {
      const sentence = summarizeTools(Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]));
      assert.doesNotMatch(sentence, /, \+\d|\+\d+ more|other steps?/, sentence);
    }
  }
});

test('a failed edit is one more clause: `and` only before the last', () => {
  const tools = [npmTest, npmTest, grep, grep, ls, edit, mcp, failedEdit];
  assert.equal(summarizeTools(tools), "Ran tests twice, 2 searches, 1 other command, edited 1 file, used 1 tool and couldn't edit 1 file");
  assert.equal(summarizeTools([ls, failedEdit]), "Ran 1 command and couldn't edit 1 file");
  // A verb with two nouns no longer keeps its own `and` once a failure follows.
  assert.equal(summarizeTools([ls, grep, read, failedEdit]), "Ran 1 command, 1 search, read 1 file and couldn't edit 1 file");
});

test('PandaCode families read as natural phrases', () => {
  const cases = [
    [[panda('send_team_message'), panda('read_team_mailbox')], 'Coordinated with the team twice'],
    [[panda('vm_list'), panda('vm_control'), panda('vm_manage')], 'Used the VM 3 times'],
    [[panda('design_write'), panda('design_write'), panda('design_resolve')], 'Made 3 design edits'],
    [[panda('read_task'), panda('start_task')], 'Made 2 task updates'],
  ];
  for (const [tools, expected] of cases) assert.equal(summarizeTools(tools), expected);
  for (const [tools] of cases) assert.doesNotMatch(summarizeTools(tools), /Operated|Managed|steps|actions/);
});

test('every summary says `and` at most once', () => {
  const pool = [read, edit, write, fetch, todo, grep, npmTest, ls, mcp, failedEdit, panda('vm_list'), panda('design_write')];
  for (let start = 0; start < pool.length; start++) {
    for (let size = 2; size <= pool.length; size++) {
      const tools = Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length]);
      const sentence = summarizeTools(tools);
      assert.ok((sentence.match(/ and /g) ?? []).length <= 1, sentence);
    }
  }
});

test('a verb with several nouns never keeps its own `and` before a later clause', () => {
  assert.equal(summarizeTools([ls, grep, grep, read]), 'Ran 1 command, 2 searches and read 1 file');
  assert.equal(summarizeTools([npmTest, grep, ls, read]), 'Ran tests, 1 search, 1 other command and read 1 file');
  assert.equal(summarizeTools([read, grep, ls]), 'Read 1 file, ran 1 search and 1 command');
});

test('blocked, denied and interrupted calls share one `stopped` tally when more than one kind is present', () => {
  const bash = (command, output, status) => tool('Bash', { command }, { status, output });
  const blocked = tool('Read', { file_path: '/repo/b.ts' }, { status: 'failed', output: '<tool_use_error>Blocked: read b.ts</tool_use_error>' });
  const denied = bash('git push --force', "The user doesn't want to proceed with this tool use. The tool use was rejected.", 'failed');
  const failed = bash('git push', 'Exit code 1\nrejected', 'failed');
  const ls = bash('ls', 'a', 'completed');
  assert.equal(summarizeTools([ls, failed, blocked, denied]), 'Ran 1 command · 1 failed · 2 stopped');
  assert.equal(summarizeTools([ls, blocked]), 'Ran 1 command · 1 blocked');
});
