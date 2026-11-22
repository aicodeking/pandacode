// The parts of the benchmark a bug would silently bias. Runs in `npm run test:release`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendLedger, interruptedCharge, ledgerTotals, readLedger, writeAtomic } from './ledger.mjs';
import { analysisCheck, analysisHashes, armReport, assertSanitized, compareArms, fitPrices, gate, nonInferior, parseCsv, RECALL_MARGIN, runFromRow, runsCsv, withoutVerdict } from './analyze.mjs';
import { agentFiles, assertExplorable, failedTests, failureKind, markedSection, register, WORK_ROOT, withCommitTests } from './lib.mjs';
import { costAtLongContext, costBeyondFirstWrite, costToFullRecall, gradeLocalization, mentions, metrics, parseAnswer, resultTotals } from './metrics.mjs';
import { buildJobs, canStart, fillerText, goldFromStatus, harnessArgs } from './run.mjs';
import { bootstrapCi, maxT, mcnemar, signTest, wilcoxon } from './stats.mjs';

const stream = lines => lines.map(line => JSON.stringify(line)).join('\n');
const step = (id, usage, content = []) => ({ type: 'assistant', message: { id, usage, content } });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const result = (over = {}) => ({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.5, duration_ms: 1000, duration_api_ms: 800, usage: { cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 2 }, ...over });

test('exact tests match known values', () => {
  const up = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.ok(Math.abs(signTest(up) - 2 / 256) < 1e-12);
  assert.ok(Math.abs(wilcoxon(up) - 2 / 256) < 1e-12);
  assert.ok(Math.abs(wilcoxon(up.map(x => -x)) - 2 / 256) < 1e-12);
  assert.equal(wilcoxon([0, 0]), 1);
  assert.equal(wilcoxon([1, -1]), 1);
  assert.equal(mcnemar(0, 0), 1);
  assert.equal(mcnemar(0, 5), 2 / 32);
  assert.deepEqual(bootstrapCi([1, 1, 1, 1]), [1, 1]);
});

test('max-T corrects across correlated metrics and tasks', () => {
  const clear = [-1, -1.1, -0.9, -1.2, -1, -0.8, -1.1, -1];
  const noise = [0.2, -0.3, 0.1, -0.1, 0.3, -0.2, 0.1, -0.1];
  const p = maxT({ clear, noise });
  assert.ok(Math.abs(p.clear - 2 / 256) < 1e-12);
  assert.ok(p.noise > 0.5);
  assert.ok(maxT({ clear }).clear <= p.clear + 1e-12);
  assert.throws(() => maxT({ clear, short: [1] }));
  assert.deepEqual(maxT({}), {});
});

test('max-T treats constant nonzero effects as infinite statistics', () => {
  assert.deepEqual(maxT({ saved: Array(8).fill(-1) }), { saved: 2 / 256 });
  assert.deepEqual(maxT({ saved: Array(8).fill(-0.1) }), { saved: 2 / 256 });
  assert.deepEqual(maxT({ saved: Array(8).fill(0) }), { saved: 1 });
  assert.deepEqual(maxT({ empty: [] }), { empty: 1 });
  assert.deepEqual(maxT({ single: [-1] }), { single: 1 });
});

test('max-T shares sign flips across constant and variable effects', () => {
  // Two all-equal assignments hit saved; two further assignments make alternating infinite.
  // Only these four assignments give either metric an infinite statistic.
  assert.deepEqual(maxT({ saved: [-1, -1, -1, -1], alternating: [-1, 1, -1, 1] }), {
    saved: 4 / 16, alternating: 1,
  });
  // The largest absolute mean of 1..8 occurs only at the two all-equal sign assignments.
  assert.deepEqual(maxT({ saved: Array(8).fill(-0.1), variable: [1, 2, 3, 4, 5, 6, 7, 8], zero: Array(8).fill(0) }), {
    saved: 2 / 256, variable: 2 / 256, zero: 1,
  });
});

test('a run with two results adds per-segment values and keeps the cumulative cost', () => {
  // Shapes recorded from Claude Code 2.1.317: duration_api_ms and total_cost_usd run on, the rest is per segment.
  const events = [result({ num_turns: 9, duration_ms: 100, duration_api_ms: 80, total_cost_usd: 0.14, usage: { cache_read_input_tokens: 10, output_tokens: 1 } }), result({ num_turns: 5, duration_ms: 50, duration_api_ms: 120, total_cost_usd: 0.18, usage: { cache_read_input_tokens: 20, output_tokens: 2 } })];
  const totals = resultTotals(events);
  assert.equal(totals.turns, 14);
  assert.equal(totals.durationMs, 150);
  assert.equal(totals.costUsd, 0.18);
  assert.equal(totals.tokens.cacheRead, 30);
  assert.equal(totals.segments, 2);
  assert.equal(totals.apiMs, 120);
  assert.equal(resultTotals(events, 1).apiMs, 40);
  assert.equal(resultTotals(events, 1).durationMs, 50);
});

test('skipping the warm turn measures only the task', () => {
  const m = metrics(stream([
    step('warm', { cache_creation_input_tokens: 150000, cache_read_input_tokens: 0 }, [{ type: 'text', text: 'OK' }]),
    result({ total_cost_usd: 0.6, num_turns: 1, duration_ms: 500, duration_api_ms: 450 }),
    step('a', { cache_read_input_tokens: 150000, cache_creation_input_tokens: 100 }, [tool('t', 'Bash', { command: 'rg x' })]),
    toolResult('t', 'src/a.ts'),
    step('b', { cache_read_input_tokens: 150100, cache_creation_input_tokens: 10 }, [{ type: 'text', text: 'done' }]),
    result({ total_cost_usd: 0.7, num_turns: 2, duration_ms: 300, duration_api_ms: 700 }),
  ]), { skip: 1 });
  assert.equal(m.apiMs, 250);
  assert.equal(m.nonApiMs, 50);
  assert.equal(m.steps, 2);
  assert.equal(m.firstStep.cacheRead, 150000);
  assert.ok(Math.abs(m.costUsd - 0.1) < 1e-12);
  assert.equal(m.durationMs, 300);
  assert.equal(m.answer, 'done');
});

test('steps count model requests, not parallel tool messages', () => {
  const m = metrics(stream([
    { type: 'system', subtype: 'init', model: 'm', tools: [] },
    step('1', { cache_read_input_tokens: 5 }, [tool('t1', 'mcp__x__pandacode_explore', { read: ['a.ts:1-2'], outline: ['b.ts'] })]),
    step('1', { cache_read_input_tokens: 5 }, [tool('t2', 'Bash', { command: 'rg foo' })]),
    toolResult('t1', 'abc', true),
    toolResult('t2', 'src/deep/c.ts'),
    step('2', { cache_read_input_tokens: 9 }, [tool('t3', 'Bash', { command: 'npm test' })]),
    { type: 'assistant', parent_tool_use_id: 't9', message: { id: 'sub', content: [{ type: 'text', text: 'sub' }] } },
    step('3', { cache_read_input_tokens: 11 }, [{ type: 'text', text: 'done' }]),
    result({ num_turns: 5 }),
  ]));
  assert.equal(m.steps, 3);
  assert.equal(m.turns, 5);
  assert.equal(m.tools.explore, 1);
  assert.equal(m.tools.BashSearch, 1);
  assert.equal(m.tools.BashOther, 1);
  assert.equal(m.firstToolIsExplore, true);
  assert.equal(m.explore.errors.length, 1);
  assert.equal(m.explore.singleKind, 0);
  assert.equal(m.apiMsPerStep, 800 / 3);
  assert.equal(m.nonApiMs, 200);
  assert.equal(m.answer, 'done');
});

test('credit treats every arm alike: any tool may show a gold file', () => {
  assert.equal(parseAnswer('no json'), null);
  assert.deepEqual(parseAnswer('x\n```json\n{"files":["a"]}\n```\nthen\n```json\n{"files":["b"]}\n```').files, ['b']);
  // Seen in round 2: a code block before the answer made a bare-fence pattern pair the wrong fences.
  assert.deepEqual(parseAnswer('see\n```ts\nx()\n```\nEach call\n\n```json\n{"files":["c"]}\n```').files, ['c']);
  assert.deepEqual(parseAnswer('done: {"files":["d"],"functions":[]}').files, ['d']);
  const answer = '```json\n{"files":["./src/a.ts","/tmp/x/repo/src/b.ts:12","src/z.ts"],"functions":["f"]}\n```';
  for (const stepText of [['cat src/c.ts'], ['{"read":["src/c.ts:1-2"]}'], ['ok\nsrc/c.ts:9: hit']]) {
    const grade = gradeLocalization({ answer, stepText }, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    assert.equal(grade.recall, 0.5);
    assert.equal(grade.precision, 2 / 3);
    assert.equal(grade.credit, 2.5 / 4);
    assert.deepEqual(grade.seenOnly, ['src/c.ts']);
  }
  assert.ok(mentions('cd src-tauri/src; rg x → remote/host.rs:1', 'src-tauri/src/remote/host.rs'));
  assert.ok(!mentions('host.rs', 'src-tauri/src/remote/host.rs'));
});

test('cost views use the measured steps', () => {
  const m = { costUsd: 0.2, steps: 2, firstStep: { cacheWrite: 10_000 }, tokens: { cacheRead: 20_000, cacheWrite: 11_000, input: 0, output: 1000 }, stepUsage: [{ read: 0, write: 10_000, input: 0 }, { read: 20_000, write: 1000, input: 0 }], stepText: ['nothing', 'src/a.ts'] };
  assert.ok(Math.abs(costBeyondFirstWrite(m, 'sonnet') - 0.16) < 1e-9);
  const expected = (20_000 + 10_000 + 300_000) * 0.1 / 1e6 + 1000 * 4 / 1e6 + 1000 * 10 / 1e6;
  assert.ok(Math.abs(costAtLongContext(m, 'sonnet') - expected) < 1e-9);
  const reached = costToFullRecall(m, ['src/a.ts'], 'sonnet');
  assert.equal(reached.steps, 2);
  assert.ok(Math.abs(reached.costUsd - (0.04 + 0.002 + 0.004)) < 1e-9);
  assert.equal(costToFullRecall(m, ['src/never.ts'], 'sonnet').reached, false);
});

test('only the arm-specific lines differ between arms', () => {
  const base = { model: 'sonnet', config: 'mcp.json', instructions: { after: 'A', instruction: 'I' }, runBudget: 2 };
  const before = harnessArgs({ ...base, arm: 'before' });
  const only = harnessArgs({ ...base, arm: 'instruction' });
  const after = harnessArgs({ ...base, arm: 'after' });
  assert.deepEqual(only.slice(0, before.length), before);
  assert.deepEqual(only.slice(before.length), ['--append-system-prompt', 'I']);
  assert.ok(!only.includes('mcp.json'));
  assert.ok(after.includes('mcp.json') && after.includes('A') && !before.includes('A'));
  for (const flag of ['--strict-mcp-config', '--setting-sources', '--no-session-persistence']) assert.ok(after.includes(flag) && before.includes(flag));
});

test('arm order comes from the batch seed and differs between batches', () => {
  const selected = { loc: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}` })) };
  const jobs = seed => buildJobs(selected, () => [1, 2], ['before', 'instruction', 'after'], 'sonnet', seed);
  assert.deepEqual(jobs(7).map(j => j.arm), jobs(7).map(j => j.arm));
  assert.notDeepEqual(jobs(7).map(j => j.task.id + j.arm), jobs(8).map(j => j.task.id + j.arm));
  const all = jobs(7);
  assert.equal(all.length, 120);
  assert.equal(new Set(all.map(j => j.order.join())).size, 6);
  for (let i = 0; i < all.length; i += 3) assert.equal(new Set(all.slice(i, i + 3).map(j => `${j.task.id}/${j.seed}`)).size, 1);
});

test('the budget stops a run before it could cross', () => {
  assert.equal(canStart({ totalUsd: 58, cap: 2, budget: 60 }), true);
  assert.equal(canStart({ totalUsd: 58.01, cap: 2, budget: 60 }), false);
});

test('the ledger survives a restart: open runs stay reserved, interrupted ones pay their cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-ledger-'));
  const file = join(dir, 'ledger.jsonl');
  try {
    assert.deepEqual(readLedger(file), []);
    appendLedger(file, { type: 'start', attempt: 'a', id: 'x', batch: 'A', capUsd: 1 });
    appendLedger(file, { type: 'end', attempt: 'a', billedUsd: 0.25 });
    appendLedger(file, { type: 'start', attempt: 'b', id: 'y', batch: 'A', capUsd: 1 });
    let totals = ledgerTotals(readLedger(file));
    assert.equal(totals.totalUsd, 1.25);
    assert.equal(totals.reservedUsd, 1);
    assert.deepEqual(totals.open.map(a => a.id), ['y']);
    // A crash cuts the last line short; what came before still counts.
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"type":"end","attem`);
    assert.equal(ledgerTotals(readLedger(file)).totalUsd, 1.25);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\{"type":"end","attem$/, ''));
    appendLedger(file, { type: 'interrupted', attempt: 'b', id: 'y', chargedUsd: interruptedCharge(1, 0.4) });
    appendLedger(file, { type: 'start', attempt: 'c', id: 'y', batch: 'A', capUsd: 1 });
    appendLedger(file, { type: 'end', attempt: 'c', billedUsd: 0.5 });
    totals = ledgerTotals(readLedger(file));
    assert.equal(totals.totalUsd, 0.25 + 1 + 0.5);
    assert.equal(totals.interrupted, 1);
    assert.equal(totals.ended, 2);
    assert.equal(totals.open.length, 0);
    assert.equal(interruptedCharge(1, 1.5), 1.5);
    writeAtomic(join(dir, 'r.json'), '{}');
    assert.equal(readFileSync(join(dir, 'r.json'), 'utf8'), '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate needs the whole CI above the margin, per measure', () => {
  const runsOf = (a, b) => ['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((task, i) => [{ set: 'loc', task, arm: 'before', grade: { recall: a[i], precision: 0.5 } }, { set: 'loc', task, arm: 'after', grade: { recall: b[i], precision: 0.5 } }]);
  const same = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
  assert.equal(gate(runsOf(same, same), 'before', 'after').recall.pass, true);
  const noisy = gate(runsOf(same, [0.5, 0.6, 0.7, 0.8, 0.9, 0.5]), 'before', 'after');
  assert.equal(noisy.recall.pass, false);
  assert.equal(noisy.precision.pass, true);
  assert.equal(noisy.editPass, null);
  assert.equal(RECALL_MARGIN, -0.05);
  assert.equal(nonInferior([], 'before', 'after', () => 0), null);
});

test('steps are the primary metric and others carry a corrected p', () => {
  const runs = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].flatMap((task, i) => ['before', 'after'].map(arm => ({
    task, arm, model: 'sonnet', wallMs: 1000, steps: arm === 'before' ? 8 + i : 4 + i, turns: 5, durationMs: 1000, apiMs: 900, apiMsPerStep: 100, nonApiMs: 100, costUsd: 0.1, firstStep: { cacheWrite: 100 }, tokens: { cacheRead: 1, cacheWrite: 1, input: 0, output: 1 },
  })));
  const stats = compareArms(runs, 'before', 'after');
  assert.equal(stats.steps.primary, true);
  assert.equal(stats.steps.pMaxT, null);
  assert.equal(stats.steps.read, 'lower');
  assert.ok(stats['cost $'].pMaxT != null);
  assert.equal(stats['cost $'].read, 'within noise');
  assert.ok(!('wall s' in compareArms(runs, 'before', 'after', { skipWall: true })));
});

test('fitted prices recover the ones behind the costs', () => {
  const runs = [[100, 200, 3], [500, 100, 9], [50, 900, 1], [800, 800, 8], [300, 40, 20]].map(([w, r, o]) => ({ tokens: { cacheWrite: w * 1000, cacheRead: r * 1000, output: o * 1000 }, costUsd: (w * 4 + r * 0.1 + o * 10) / 1000 }));
  const fit = fitPrices(runs);
  assert.ok(Math.abs(fit.write - 4) < 1e-6 && Math.abs(fit.read - 0.1) < 1e-6 && Math.abs(fit.output - 10) < 1e-6);
  const same = Array.from({ length: 5 }, () => ({ tokens: { cacheWrite: 1000, cacheRead: 1000, output: 1000 }, costUsd: 0.1 }));
  assert.equal(fitPrices(same), null);
});

test('edit grading parsers tell a failed test from a failed build', () => {
  assert.equal(failureKind('error[E0425]: cannot find function\nerror: could not compile', 101), 'build');
  assert.equal(failureKind("SyntaxError: The requested module does not provide an export named 'X'", 1), 'build');
  assert.equal(failureKind('test a::b ... FAILED\ntest result: FAILED. 1 passed', 101), 'assertion');
  assert.equal(failureKind('test result: FAILED. 1 passed\nerror: test failed, to rerun pass `--lib`', 101), 'assertion');
  assert.equal(failureKind('not ok 3 - something', 1), 'assertion');
  assert.equal(failureKind('anything', 0), 'pass');
  assert.deepEqual(failedTests('test a::b ... FAILED\ntest a::c ... ok\nnot ok 3 - names it\n'), ['a::b', 'names it']);
  const bun = 'src/x.test.ts:\n(pass) keeps it [0.10ms]\n(fail) Accepts > exact type wins [1.20ms]\nerror: expect(received).toBe(expected)\n(fail) no time\n 1 fail';
  assert.equal(failureKind(bun, 1), 'assertion');
  assert.deepEqual(failedTests(bun), ['Accepts > exact type wins', 'no time']);
  assert.equal(withCommitTests('code\n#[cfg(test)]\nmod tests { old }\n', 'other\n#[cfg(all(test, unix))]\nmod tests { new }\n'), 'code\n#[cfg(all(test, unix))]\nmod tests { new }\n');
});

test('gold drops new files, docs and lock files', () => {
  assert.deepEqual(goldFromStatus('M\tsrc/a.ts\nA\tsrc/new.ts\nM\tdocs/x.md\nM\tyarn.lock\nM\t.husky/pre-commit\nM\tREADME.md'), ['.husky/pre-commit', 'src/a.ts']);
});

test('the filler is deterministic and the task list is well formed', () => {
  assert.equal(fillerText(1000), fillerText(1000));
  assert.ok(fillerText(1000).length >= 1000);
  const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
  const ids = tasks.localization.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const task of tasks.localization) {
    assert.match(task.commit, /^[0-9a-f]{40}$/);
    assert.ok(task.gold.length > 0, task.id);
    for (const path of task.gold) assert.ok(!task.prompt.includes(path), `${task.id} names ${path}`);
  }
  const tagged = tag => tasks.localization.filter(t => t.tags.includes(tag)).length;
  for (const tag of ['secret-named', 'glob-narrow', 'truncated-read', 'auth', 'dot-config', 'big-repo']) assert.ok(tagged(tag) > 0, tag);
  for (const id of tasks.long.tasks) assert.ok(ids.includes(id), id);
  assert.ok(tasks.instructionOnly && !/pandacode_explore/.test(tasks.instructionOnly));
  assert.match(tasks.harness.version, /^\d+\.\d+\.\d+$/);
});

test('summaries refuse paths and addresses', () => {
  assert.equal(assertSanitized('{"steps":3}'), '{"steps":3}');
  for (const bad of ['/Users/name/x', '/private/tmp/x', '/tmp/y', '/home/a', 'a.b@example.com', 'Bearer abc']) assert.throws(() => assertSanitized(bad));
});

test('per-run CSV round-trips what the analysis reads', () => {
  const runs = ['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((task, i) => ['before', 'after'].map(arm => ({
    set: 'loc', task, arm, seed: 5, model: 'sonnet', tags: ['auth', 'held-out'], steps: arm === 'before' ? 6 + i : 4 + i, turns: 5, wallMs: 1000 + i, durationMs: 900, apiMs: 800, apiMsPerStep: 200, nonApiMs: 100,
    costUsd: 0.1 + i / 100, tokens: { input: 3, cacheRead: 1000, cacheWrite: 500, output: 20 }, firstStep: { cacheRead: 10, cacheWrite: 400 }, laterWrites: [50, 50],
    grade: { answered: true, recall: 0.5 + i / 20, precision: arm === 'after' ? 0.4 : 0.5, credit: 0.6 }, success: true,
    explore: { args: [{}, {}], singleKind: 1, errors: [], truncated: 1, resultChars: [10, 2000] }, tools: { explore: 2, ToolSearch: 0 }, firstToolIsExplore: true, subtype: 'success, odd "text"',
  })));
  const text = runsCsv(runs, 'v9-Z');
  const back = parseCsv(text).map(row => runFromRow(row, 'x.csv'));
  assert.equal(back.length, runs.length);
  assert.deepEqual(gate(back, 'before', 'after'), gate(runs, 'before', 'after'));
  assert.deepEqual(compareArms(back, 'before', 'after'), compareArms(runs, 'before', 'after'));
  assert.deepEqual(back[0].laterWrites, [50, 50]);
  assert.deepEqual(back[0].tags, ['auth', 'held-out']);
  assert.equal(back[0].subtype, 'success, odd "text"');
  assert.equal(back[0].explore.args.length, 2);
  assert.throws(() => runsCsv([{ ...runs[0], subtype: '/Users/x' }], 'b'));
});

test('held-out tasks are well formed, apart from the tuned ones, and match their pre-registration', () => {
  const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
  const tuned = JSON.parse(read('./tasks.json')).localization;
  const heldout = JSON.parse(read('./tasks-heldout.json'));
  const ids = heldout.localization.map(t => t.id);
  assert.ok(ids.length >= 6 && ids.length <= 10);
  for (const task of heldout.localization) {
    assert.ok(!tuned.some(t => t.id === task.id || t.commit === task.commit), task.id);
    assert.match(task.commit, /^[0-9a-f]{40}$/);
    assert.ok(task.tags.includes('held-out'), task.id);
    for (const path of task.gold) assert.ok(!task.prompt.includes(path), `${task.id} names ${path}`);
    if (task.repo) assert.ok(heldout.repos[task.repo], task.repo);
  }
  // Pre-registrations and deviations are append-only: each entry names the one before it, the texts it
  // hashed never change, and the task files it pins stay as pinned until a later entry supersedes it.
  const sha = text => createHash('sha256').update(text).digest('hex');
  const lines = read('./results/preregistrations.jsonl').split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line));
  const docOf = entry => readFileSync(new URL(`../../${entry.doc ?? 'docs/agent-loop-benchmark.md'}`, import.meta.url), 'utf8');
  const doc = docOf({});
  const legacy = { tasksSha256: 'tasks.json', heldoutSha256: 'tasks-heldout.json', tasksSaverSha256: 'tasks-saver.json' };
  entries.forEach((entry, i) => {
    assert.equal(entry.prev, i ? sha(lines[i - 1]) : null);
    assert.equal(sha(markedSection(docOf(entry), entry.marker ?? `prereg:${entry.batch}`)), entry.sectionSha256, `${entry.marker ?? entry.batch} changed after it was registered`);
    if (entries.slice(i + 1).some(later => later.supersedes === entry.batch)) return;
    const pins = { ...Object.fromEntries(Object.entries(legacy).filter(([key]) => entry[key]).map(([key, name]) => [name, entry[key]])), ...entry.files };
    for (const [name, hash] of Object.entries(pins)) assert.equal(sha(read(`./${name}`)), hash, `${name} changed after ${entry.batch}'s registration`);
  });
  const e = entries.find(entry => entry.batch === 'E');
  assert.equal(sha(read('./tasks-heldout.json')), e.heldoutSha256);
  assert.ok(doc.includes(e.heldoutSha256));
});

test('trees are never made where pandacode_explore refuses a root', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  try {
    for (const bad of ['Library/Caches/pandacode-bench/v2/work/x/repo', 'library/caches/x', '.config/x', '.local/share/x', 'AppData/Roaming/x', '.cache/x', '.claude']) {
      assert.throws(() => assertExplorable(join(home, bad), home), /refuses/, bad);
    }
    for (const ok of ['pandacode-bench-work/x', 'code/app', '.config/nvim/x', 'Library/Mobile Documents/com~apple~CloudDocs/app']) assert.equal(assertExplorable(join(home, ok), home), join(home, ok));
    assert.equal(assertExplorable('/var/tmp/x', home), '/var/tmp/x');
    assert.doesNotThrow(() => assertExplorable(join(WORK_ROOT, 'x')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('register appends a chained entry with the section, time and pinned files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prereg-'));
  try {
    const file = join(dir, 'p.jsonl');
    writeFileSync(file, '{"batch":"A"}\n');
    const entry = register({ batch: 'E', doc: 'docs/agent-loop-benchmark.md', pins: ['tasks.json'], now: new Date('2026-11-07T00:00:00Z') }, file);
    const sha = text => createHash('sha256').update(text).digest('hex');
    assert.equal(entry.prev, sha('{"batch":"A"}'));
    assert.equal(entry.kind, 'prereg');
    assert.equal(entry.writtenAt, '2026-11-07T00:00:00.000Z');
    assert.equal(entry.sectionSha256, '79b39b75397946c67dffb84d0b292e8358afdbcdd4f6eb893447136adf5bf9f7');
    assert.equal(entry.files['tasks.json'], sha(readFileSync(new URL('./tasks.json', import.meta.url))));
    assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1), entry);
    assert.throws(() => register({ batch: 'nope', doc: 'docs/agent-loop-benchmark.md' }, file), /no section prereg:nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused explore call earns no recall credit, from its arguments or its reply', () => {
  const run = refused => metrics(stream([
    step('1', { cache_read_input_tokens: 5 }, [tool('e', 'mcp__x__pandacode_explore', { read: ['src/gold.ts:1-9'] })]),
    toolResult('e', refused ? 'refused: src/gold.ts is outside the project' : 'src/gold.ts:1 export const x = 1', refused),
    step('2', { cache_read_input_tokens: 9 }, [{ type: 'text', text: '```json\n{"files":[]}\n```' }]),
    result(),
  ]));
  assert.deepEqual(gradeLocalization(run(false), ['src/gold.ts']).seenOnly, ['src/gold.ts']);
  const refused = run(true);
  assert.deepEqual(gradeLocalization(refused, ['src/gold.ts']).seenOnly, []);
  assert.equal(refused.explore.errors.length, 1);
  assert.equal(costToFullRecall(refused, ['src/gold.ts'], 'sonnet').reached, false);
});

test('Holm and the co-primary label belong to tuned localization; registered reads never say within noise', () => {
  const runs = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].flatMap((task, i) => ['before', 'after'].map(arm => ({
    task, arm, model: 'sonnet', wallMs: 1000, steps: arm === 'before' ? 8 + i : 4 + i, turns: 5, durationMs: 1000, apiMs: 900, apiMsPerStep: 100, nonApiMs: 100, costUsd: 0.1 + (arm === 'after' ? (i % 2 ? 0.02 : -0.01) : 0), firstStep: { cacheWrite: 100 }, tokens: { cacheRead: 1, cacheWrite: 1, input: 0, output: 1 },
  })));
  const tuned = compareArms(runs, 'before', 'after', { holmCost: true, holm: true });
  assert.equal(tuned.steps.primary, true);
  assert.equal(tuned['cost $'].primary, true);
  assert.ok(tuned['cost $'].pHolm != null && tuned['cost $'].pMaxT == null);
  assert.equal(tuned['cost $'].read, 'not shown to be higher');
  const other = compareArms(runs, 'before', 'after', { holmCost: true, holm: false });
  assert.equal(other.steps.primary, false);
  assert.equal(other['cost $'].primary, false);
  assert.equal(other['cost $'].pHolm, undefined);
  assert.equal(other['cost $'].pMaxT, null, 'cost stays out of the max-T family, so the other p-values do not move');
  assert.equal(other['output tok'].pMaxT, tuned['output tok'].pMaxT);
  assert.equal(other['cost $'].pWilcoxon, tuned['cost $'].pWilcoxon);
  assert.ok(Object.values(other).filter(Boolean).every(m => m.read !== 'within noise'));
  assert.ok(Object.values(compareArms(runs, 'before', 'after', { descriptive: true })).filter(Boolean).every(m => m.read === 'descriptive'));
  const g = withoutVerdict(gate(runs.map(r => ({ ...r, set: 'loc', grade: { recall: 1, precision: 1 } })), 'before', 'after'));
  assert.equal(g.recall.pass, undefined);
  assert.equal(g.recall.diff, 0);
});

test('--descriptive held-out output carries no pass and reads every measure as descriptive', () => {
  const { summary, out } = armReport([join(import.meta.dirname, 'results/runs/v6-Fv2.csv')], { arms: 'before,after', set: 'loc', model: 'sonnet', descriptive: true });
  assert.ok(summary.heldout.runs > 0);
  assert.ok(Object.values(summary.heldout.gate).filter(Boolean).every(g => !('pass' in g)));
  assert.ok(Object.values(summary.heldout.loc).filter(Boolean).every(m => m.read === 'descriptive'));
  assert.ok(!out.some(line => /PASS|FAIL/.test(line)));
});

test('the analysis says MISMATCH when its code is not what a batch registered', () => {
  const now = analysisHashes();
  const entry = (batch, analysis) => ({ batch, marker: `deviation:${batch}`, analysis });
  assert.deepEqual(analysisCheck(['v6-Fv2'], [entry('Fv2-2', now)]), ['analysis code matches deviation:Fv2-2 for v6-Fv2']);
  const [line] = analysisCheck(['Fv2'], [entry('Fv2-2', now), entry('Fv2-3', { ...now, 'stats.mjs': 'f'.repeat(64) })]);
  assert.match(line, /^MISMATCH: Fv2: stats\.mjs is [0-9a-f]{12}, registered ffffffffffff/);
  assert.match(analysisCheck(['E'], [entry('Fv2-2', now)])[0], /no hashes registered for E/);
  assert.match(analysisCheck(['F'], [entry('Fv2-2', now)])[0], /no hashes registered for F/);
});

test('checkouts drop agent settings anywhere in the tree, but keep AGENTS.md', () => {
  const tree = ['AGENTS.md', 'CLAUDE.md', 'src/CLAUDE.md', 'pkg/CLAUDE.local.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/x.sh', 'a/.claude/skills/s/SKILL.md', 'src/claude.ts', 'docs/.claudeignore', 'MY_CLAUDE.md'];
  assert.deepEqual(agentFiles(tree), ['.claude', '.mcp.json', 'CLAUDE.md', 'a/.claude', 'pkg/CLAUDE.local.md', 'src/CLAUDE.md']);
});
