import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, armFlag, deniedTools, loadS2, toolCounts } from './s2.mjs';

test('the arms use the app\'s own tool lists', () => {
  const lists = deniedTools();
  assert.equal(lists.session, 'ScheduleWakeup,Monitor,CronCreate');
  assert.match(lists.worker, /\bAgent\b/);
  assert.equal(lists.readOnly, 'Edit,Write,NotebookEdit');
  assert.equal(armFlag('BASE', lists), '--disallowedTools=ScheduleWakeup,Monitor,CronCreate');
  assert.equal(armFlag('LEAN', lists), `--disallowedTools=ScheduleWakeup,Monitor,CronCreate,${lists.worker},Edit,Write,NotebookEdit`);
  assert.throws(() => deniedTools('nothing here'), /CLAUDE_SESSION_BOUND_TOOLS/);
});

test('S2 runs S1\'s 20 localization and 8 report tasks, nothing that edits', () => {
  const { tasks } = loadS2();
  assert.equal(tasks.filter(t => t.set === 'loc').length, 20);
  assert.equal(tasks.filter(t => t.set === 'report').length, 8);
  assert.ok(tasks.every(t => t.set !== 'edit'));
});

test('analysis pairs tasks and reports relative changes and quality differences', () => {
  const run = (task, set, arm, usd, write, grade) => ({ task, set, arm, billedUsd: usd, steps: 3, wallMs: 1, firstStep: { cacheWrite: write }, tokens: { input: 1, cacheRead: 10, cacheWrite: write, output: 5 }, grade, init: { tools: [arm] } });
  const runs = [
    run('a', 'loc', 'BASE', 0.2, 100, { recall: 1, precision: 0.5 }), run('a', 'loc', 'LEAN', 0.1, 50, { recall: 1, precision: 1 }),
    run('b', 'loc', 'BASE', 0.4, 200, { recall: 0.5, precision: 0.5 }), run('b', 'loc', 'LEAN', 0.2, 100, { recall: 0, precision: 0 }),
    run('c', 'report', 'BASE', 0.1, 10, { recall: 0.5 }), run('c', 'report', 'LEAN', 0.05, 5, { recall: 1 }),
    run('d', 'loc', 'BASE', 0.1, 10, { recall: 1, precision: 1 }), // unpaired: dropped
  ];
  const s = analyze(runs);
  assert.equal(s.tasks, 3);
  assert.ok(Math.abs(s.table.billedUsd.relMean + 0.5) < 1e-9);
  assert.ok(Math.abs(s.table.firstStepCacheWrite.relMean + 0.5) < 1e-9);
  assert.equal(s.quality.recall.tasks, 2);
  assert.ok(Math.abs(s.quality.recall.diff + 0.25) < 1e-9);
  assert.ok(Math.abs(s.quality.precision.diff - 0) < 1e-9);
  assert.ok(Math.abs(s.quality.rubric.diff - 0.5) < 1e-9);
});

test('--tools counts the main agent\'s explore and Bash calls per arm, and runs with any Bash', () => {
  const run = (arm, explore, BashSearch, BashOther) => ({ arm, tools: { explore, BashSearch, BashOther } });
  assert.deepEqual(toolCounts([run('BASE', 3, 0, 0), run('BASE', 1, 2, 1), run('LEAN', 0, 0, 1), run('LEAN', 2, 0, 0)]), {
    BASE: { runs: 2, explore: 4, bash: 3, bashSearch: 2, runsWithBash: 1 },
    LEAN: { runs: 2, explore: 2, bash: 1, bashSearch: 0, runsWithBash: 1 },
  });
});
