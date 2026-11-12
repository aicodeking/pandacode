import test from 'node:test';
import assert from 'node:assert/strict';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
import { describeTool, summarizeTools, toolPreview, traceRowHtml } from '../src/tool-trace.ts';

// Every row renders on each frame of a live turn, so one hostile record must never freeze the window. A pattern that
// backtracks (`rm ` + 62 dashes once took over 30 s) blows far past the budget; GC and JIT warm-up do not.
const BUDGET_MS = 50;
const RUNS = 3;

const bash = (command, status = 'completed', output = '') => ({ name: 'Bash', status, input: JSON.stringify({ command }), output });
const codex = command => ({ name: 'Command', status: 'failed', input: `/bin/zsh -lc '${command}'\nWorking directory: /repo`, output: 'Exit code: 1\nOutput:\n' });

const HOSTILE = {
  'rm and 50,000 dashes': 'rm ' + '-'.repeat(50_000),
  'rm and 62 dashes, clipped': 'rm ' + '-'.repeat(62) + '…',
  'echo and 10,000 dashes': 'echo ' + '-'.repeat(10_000),
  '10,000 nested parens': '('.repeat(10_000) + 'ls' + ')'.repeat(10_000),
  'a 200 KB command': 'ls ' + 'a '.repeat(100_000),
  'long -a-b-c tokens': 'ls ' + '-a'.repeat(5_000) + ' ' + '-a-b-c'.repeat(3_000) + ' -' + 'x-'.repeat(5_000),
  'separator runs': 'echo ' + ' · '.repeat(10_000) + 'x' + ' '.repeat(20_000) + '·',
  'whitespace runs': 'git status ' + ' '.repeat(50_000) + 'x',
  'a wait on a long subject': 'until grep -q ' + '"'.repeat(5_000) + ' log; do sleep 1; done',
};

/** The fastest of a few runs after one warm-up, so a GC pause cannot fail the test but a backtracking pattern still does. */
function fastest(work) {
  work();
  let best = Infinity;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

for (const [name, command] of Object.entries(HOSTILE)) {
  test(`describeTool, traceRowHtml and toolPreview stay under ${BUDGET_MS} ms: ${name}`, () => {
    for (const tool of [bash(command), bash(command, 'failed', 'Exit code 1\n' + command.slice(0, 4000)), codex(command.slice(0, 20_000))]) {
      const ms = fastest(() => { traceRowHtml(describeTool(tool)); toolPreview(tool); });
      assert.ok(ms < BUDGET_MS, `${name} (${tool.name}, ${tool.status}) took ${ms.toFixed(1)} ms`);
    }
  });
}

test('a group of hostile records summarizes under the budget', () => {
  const tools = Object.values(HOSTILE).map(command => bash(command));
  const ms = fastest(() => summarizeTools(tools));
  assert.ok(ms < BUDGET_MS * tools.length, `summary took ${ms.toFixed(1)} ms`);
});

test('legacy titles and outputs with long whitespace runs stay under the budget', () => {
  const spaces = ' '.repeat(50_000);
  const tools = [
    { name: `Ran python3${spaces}grep`, status: 'completed', input: 'out', output: '' },
    { name: 'Update files', status: 'completed', input: `update a.ts${spaces}->${spaces}`, output: '' },
    { name: 'BashOutput', status: 'completed', input: '{"bash_id":"b1"}', output: '\n'.repeat(20_000) + 'x' },
    { name: 'KillShell', status: 'completed', input: '{"shell_id":"b1"}', output: JSON.stringify({ message: '('.repeat(20_000) }) },
  ];
  for (const tool of tools) {
    const ms = fastest(() => { traceRowHtml(describeTool(tool)); toolPreview(tool); });
    assert.ok(ms < BUDGET_MS, `${tool.name.slice(0, 20)} took ${ms.toFixed(1)} ms`);
  }
});
