// Token saver benchmark: the parts a bug would silently bias. Runs in `npm run test:bench`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SIM_MARGINS, architectSources, assertUnchanged, assignJobs, assumedItemRates, findLeadGuidance, findWorkerReport, loadTasks, parseSelection, saverBlock, selectorPrompt, simulateGate, simulationReport, unescapeRust, workerMessage, workerPrompt } from './saver.mjs';
import { scoreRubric, splitFindings } from './metrics.mjs';
import { TASK_SUCCESS_MARGIN, assertSaverTasks, blindRescore, compareSaver, noEffectGate, saverGate, saverRuns } from './analyze.mjs';
import { holm } from './stats.mjs';

const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
const shipped = await import(new URL('../../src/token-saver.ts', import.meta.url));

test('selector replies are validated as token_saver::parse validates an assignment', () => {
  assert.deepEqual(parseSelection('{"tokenSaver":{"packs":["quiet-tools","caveman"],"level":"lite"}}'), { ok: true, packs: ['caveman', 'quiet-tools'], level: 'lite' });
  assert.deepEqual(parseSelection('Sure.\n```json\n{"tokenSaver": {"packs": ["lean-code"]}}\n```'), { ok: true, packs: ['lean-code'], level: 'full' });
  assert.deepEqual(parseSelection('{"tokenSaver":{"packs":["caveman"]}}'), { ok: true, packs: ['caveman'], level: 'full' });
  // "none", null and an omitted tokenSaver (inherit the lead thread's, which has none) give no packs.
  for (const off of ['{"tokenSaver":"none"}', '{"tokenSaver":null}', '{}', '{"tokenSaver":{"packs":[]}}']) assert.deepEqual(parseSelection(off), { ok: true, packs: [], level: 'full' }, off);
  for (const bad of ['no json', '{"tokenSaver":"off"}', '{"tokenSaver":["caveman"]}', '{"tokenSaver":{"packs":["gzip"]}}', '{"tokenSaver":{"packs":["caveman"],"level":"max"}}',
    '{"tokenSaver":{"packs":["quiet-tools"],"level":"lite"}}', '{"tokenSaver":{"packs":["rtk"],"extra":1}}', '{"tokenSaver":3}', '{"tokenSaver":{"level":"full"}}']) {
    const pick = parseSelection(bad);
    assert.equal(pick.ok, false, bad);
    assert.deepEqual(pick.packs, [], bad);
  }
});

test('the block is exactly what the app appends to a fresh thread\'s first message', () => {
  const picks = [{ packs: [], level: 'full' }, { packs: ['caveman'], level: 'ultra' }, { packs: ['caveman', 'lean-code', 'quiet-tools', 'rtk'], level: 'full' }, { packs: ['rtk'], level: 'full' }, { packs: ['quiet-tools'], level: 'lite' }];
  for (const available of [{ rtk: true }, { rtk: false }]) {
    picks.forEach((pick, i) => {
      const thread = `t-${available.rtk}-${i}`;
      shipped.updateThread(thread, pick);
      assert.equal(saverBlock(shipped.guidance, pick, available), shipped.contextFor(thread, available), JSON.stringify({ pick, available }));
    });
  }
  assert.equal(saverBlock(shipped.guidance, { packs: ['rtk'], level: 'full' }, { rtk: false }), '');
  assert.match(saverBlock(shipped.guidance, { packs: ['caveman'], level: 'full' }, { rtk: false }), /^\n\nResponse style \(PandaCode token saver.*\nRespond like smart caveman/);
});

test('the lead guidance is read from the Rust source, escapes and all', () => {
  assert.equal(unescapeRust('a \\"b\\"\\n\\\n    c\\\\d'), 'a "b"\nc\\d');
  assert.equal(unescapeRust('keep \\n raw', true), 'keep \\n raw');
  const description = [
    'let d = if child { format!("Sub \\"x\\" tokenSaver: no") } else {',
    '    "Start assignments as one batch. files: scopes. tokenSaver: \\"none\\" or packs; review quiet-tools.".into()',
    '};',
  ].join('\n');
  const schema = 'fn token_saver_schema() -> Value {\n    json!({"description": "\\"none\\" or {packs: a|b}.", "oneOf": []})\n}';
  assert.deepEqual(findLeadGuidance([{ path: 'x.rs', text: 'nothing' }, { path: 'architect.rs', text: description }]), {
    source: 'architect.rs: dispatch_tool description',
    text: 'tokenSaver: "none" or packs; review quiet-tools.',
  });
  assert.deepEqual(findLeadGuidance([{ path: 'architect.rs', text: `${description}\n${schema}` }]), {
    source: 'architect.rs: dispatch_tool description; architect.rs: token_saver_schema',
    text: 'tokenSaver: "none" or packs; review quiet-tools.\ntokenSaver parameter: "none" or {packs: a|b}.',
  });
  assert.equal(findLeadGuidance([{ path: 'a.rs', text: description.replace('tokenSaver: \\"none', 'saver: \\"none') }]), null);
});

test('worker reports preserve current wording and historical byte limits', () => {
  const report = 'Provide a concise final report with changes, exact files, checks performed, and blockers. Do not claim tests that you did not run.';
  const sources = text => [{ path: 'architect.rs', text: `format!("Worker. ${text}", limit)` }];
  assert.deepEqual(findWorkerReport(sources(report)), { source: 'architect.rs: worker rules', text: report });
  const historical = report.replace('final report', 'final report (under {} UTF-8 bytes)');
  for (const limit of [undefined, 1536]) {
    assert.equal(findWorkerReport(sources(historical), limit).text, historical.replace('{}', String(limit ?? 3072)));
  }
  assert.equal(findWorkerReport(sources('No worker report.')), null);
  const hash = text => createHash('sha256').update(text).digest('hex');
  const meta = { leadGuidance: { sha256: 'a' }, workerReport: { sha256: hash(historical.replace('{}', '3072')) }, look: { sha256: 'c' } };
  assert.throws(() => assertUnchanged(meta, { lead: { sha256: 'a' }, report: { sha256: hash(report) }, look: { sha256: 'c' } }), /workerReport changed since --prepare/);
});

test('the guidance and the worker brief come from the real architect sources', () => {
  const sources = architectSources();
  const lead = findLeadGuidance(sources);
  assert.ok(lead, 'tokenSaver guidance not found in src-tauri/src/architect.rs: update findLeadGuidance with the dispatch description');
  assert.match(lead.text, /^tokenSaver:/);
  for (const pack of shipped.PACKS) assert.ok(lead.text.includes(pack.id), pack.id);
  const report = findWorkerReport(sources);
  assert.ok(report, 'worker report sentence not found');
  assert.equal(report.text, 'Provide a concise final report with changes, exact files, checks performed, and blockers. Do not claim tests that you did not run.');
  assert.equal(workerMessage('R.', 'Do it.', '\n\nB'), 'R.\n\nDo it.\n\nB');
  const meta = { leadGuidance: { sha256: 'a' }, workerReport: { sha256: 'b' }, look: { sha256: 'c' } };
  assert.doesNotThrow(() => assertUnchanged(meta, { lead: { sha256: 'a' }, report: { sha256: 'b' }, look: { sha256: 'c' } }));
  assert.throws(() => assertUnchanged(meta, { lead: { sha256: 'x' }, report: { sha256: 'b' }, look: { sha256: 'c' } }), /leadGuidance changed/);
  assert.throws(() => assertUnchanged(meta, { lead: { sha256: 'a' }, report: { sha256: 'b' }, look: { sha256: 'x' } }), /look changed/);
});

test('the selector prompt shows only the shape of a reply, never a pack', () => {
  const { system, user } = selectorPrompt('GUIDE', 'Do the thing.');
  assert.ok(system.includes('GUIDE') && system.includes('{"tokenSaver": <value>}') && user.endsWith('Do the thing.'));
  for (const id of ['caveman', 'lean-code', 'quiet-tools', 'rtk']) assert.ok(!system.replace('GUIDE', '').includes(id), id);
});

test('rubric items need all their patterns on one line of the answer', () => {
  const rubric = [{ id: 'a', line: ['secrets\\.json'] }, { id: 'b', line: ['keychain', 'migrat'] }, { id: 'c', line: ['0o?600'] }];
  assert.deepEqual(scoreRubric('Stored in `secrets.json`.\nThe Keychain items\nare migrated later.', rubric), { hits: ['a'], missed: ['b', 'c'], recall: 1 / 3 });
  assert.equal(scoreRubric('secrets.json, mode 0600; old KEYCHAIN items MIGRATE once', rubric).recall, 1);
  assert.equal(scoreRubric(undefined, rubric).recall, 0);
  assert.equal(scoreRubric('x', []).recall, 0);
});

test('a review is scored per finding: one finding cannot borrow words from another', () => {
  const rubric = [{ id: 'a', line: ['\\bscale\\b', '\\bzero\\b'] }];
  const answer = '1. The scale is never checked.\n2. A zero-length PNG panics.\n```json\n{"findings":[{"file":"a.rs","line":1,"issue":"scale unchecked"},{"file":"a.rs","line":2,"issue":"zero length"}]}\n```';
  assert.equal(scoreRubric(answer.replaceAll('\n', ' '), rubric).recall, 1, 'one line would borrow');
  assert.equal(scoreRubric(answer, rubric, 'review').recall, 0);
  assert.equal(scoreRubric('1. The scale may be zero,\n   so it divides by zero.\n\n2. Other.', rubric, 'review').recall, 1, 'wrapped finding');
  assert.deepEqual(splitFindings('Intro\n- one\n  more\n- two\n```json\n{"findings":[{"file":"f","line":3,"issue":"x"}]}\n```'), ['f 3 x', '- one more', '- two']);
  assert.equal(scoreRubric('The scale may be zero.', rubric, 'review').recall, 1, 'no findings: scored by line');
});

test('rubrics are anchored, specific, and score at most 1 item on any other task\'s answer', () => {
  const { saver } = loadTasks();
  const generic = ['src-tauri', 'prompt', 'sign', 'header', 'defaults', 'default', 'steering', 'steer', '50', '8', '128', '0', '2.12', 'node', 'wrong', 'flush', 'failed', 'new'];
  for (const task of saver.report) {
    for (const item of task.rubric) {
      const testName = item.id.startsWith('t-');
      for (const source of item.line) assert.ok(testName || source === '@' || source.includes('\\b'), `${task.id}/${item.id}: ${source} has no word boundary`);
      if (item.line.length === 1 && !testName) for (const word of generic) assert.ok(!new RegExp(item.line[0], 'i').test(` ${word} `), `${task.id}/${item.id} matches the bare word ${word}`);
    }
    const real = saver.negativeControls.filter(c => c.task && c.task !== task.id && c.sameTopic !== task.id);
    assert.ok(real.length >= 2, `${task.id} has no real answer to another report task as a control`);
    for (const control of saver.negativeControls) {
      if (control.task === task.id || control.sameTopic === task.id) continue;
      const { hits } = scoreRubric(control.answer, task.rubric, task.kind);
      assert.ok(hits.length <= 1, `${task.id} scores ${hits.join(', ')} on ${control.id}`);
    }
  }
  // Positive control: the smoke answers of rep-explain-queue still score on their own rubric.
  const queue = saver.report.find(t => t.id === 'rep-explain-queue');
  for (const control of saver.negativeControls.filter(c => c.task === queue.id)) assert.ok(scoreRubric(control.answer, queue.rubric).recall >= 0.75, control.id);
});

// POST-HOC (round 17): the registered rubrics score the topic, so an answer stating the opposite facts
// scored full marks. The strict rubrics in results/s1v3-strict-rubrics.json must score every same-topic
// wrong answer (negated, wrong values) at most 1 item, and keep every right answer's score.
test('strict rubrics refuse same-topic wrong answers and keep right ones', () => {
  const { saver } = loadTasks();
  const strict = JSON.parse(readFileSync(new URL('./results/s1v3-strict-rubrics.json', import.meta.url), 'utf8')).report;
  assert.deepEqual(strict.map(t => t.id), saver.report.map(t => t.id));
  for (const task of saver.report) {
    const tight = strict.find(t => t.id === task.id);
    assert.equal(tight.kind, task.kind);
    assert.deepEqual(tight.rubric.map(i => i.id), task.rubric.map(i => i.id), `${task.id}: same items`);
    for (const item of tight.rubric) for (const source of [...item.line, ...(item.not ?? [])]) new RegExp(source, 'i');
    assert.deepEqual(Object.keys(tight.controls).sort(), ['negated', 'wrongValue']);
    for (const [name, answer] of Object.entries(tight.controls)) {
      const { hits } = scoreRubric(answer, tight.rubric, tight.kind);
      assert.ok(hits.length <= 1, `${task.id} strict scores ${hits.join(', ')} on its ${name} control`);
    }
    // The negated control is a real test: the registered rubric gives it more than 1 item.
    assert.ok(scoreRubric(tight.controls.negated, task.rubric, task.kind).hits.length > 1, `${task.id}: the negated control does not fool the registered rubric`);
    // Right answers keep their score; other tasks' answers still score at most 1.
    for (const control of saver.negativeControls) {
      const strictHits = scoreRubric(control.answer, tight.rubric, tight.kind).hits;
      if (control.task === task.id) assert.deepEqual(strictHits, scoreRubric(control.answer, task.rubric, task.kind).hits, `${task.id} loses an item on ${control.id}`);
      else if (control.sameTopic !== task.id) assert.ok(strictHits.length <= 1, `${task.id} strict scores ${strictHits.join(', ')} on ${control.id}`);
    }
  }
  // A failing-test item scores only names inside the answer's JSON failing array.
  const fail = strict.find(t => t.id === 'rep-fail-appimage');
  const name = 'the GTK hook keeps a GDK_BACKEND the user set, defaulting to x11';
  assert.deepEqual(scoreRubric(`It fails: ${name}`, fail.rubric, fail.kind).hits, []);
  assert.deepEqual(scoreRubric(`x\n\`\`\`json\n{"failing":["${name}"],"causes":[]}\n\`\`\``, fail.rubric, fail.kind).hits, ['t-gtk-hook']);
});

test('post-hoc rescoring never shows the scorer an arm, and the no-effect check passes identical arms', () => {
  const rubrics = { r: { kind: 'explain', rubric: [{ id: 'a', line: ['\\bright\\b'], not: ['\\bnot right\\b'] }] } };
  const runs = ['right', 'not right', 'right', 'other'].map((answer, i) => ({ set: 'report', task: 'r', arm: i % 2 ? 'CHOSEN' : 'NONE', seed: i, answer }));
  const rescored = blindRescore([...runs, { set: 'edit', task: 'e', arm: 'NONE', success: true }], rubrics);
  assert.deepEqual(rescored.slice(0, 4).map(r => r.grade.recall), [1, 0, 1, 0]);
  assert.deepEqual(rescored.map(r => r.arm), ['NONE', 'CHOSEN', 'NONE', 'CHOSEN', 'NONE']);
  assert.equal(rescored[4].grade, undefined);
  const same = ['t1', 't2', 't3'].flatMap(task => [1, 2].map(seed => ({ task, arm: 'NONE', seed, v: 0.5 })));
  assert.equal(noEffectGate(same, 'NONE', r => r.v, -0.05, { reps: 20, rounds: 200 }).passRate, 1);
  const spread = ['t1', 't2', 't3'].flatMap(task => [0, 1, 0, 1].map((v, seed) => ({ task, arm: 'NONE', seed, v })));
  assert.ok(noEffectGate(spread, 'NONE', r => r.v, -0.05, { reps: 50, rounds: 200 }).passRate < 0.5);
});

test('arms are assigned per task and seed from the batch seed', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` }));
  const jobs = seed => assignJobs(tasks, [1, 2, 3], ['NONE', 'CHOSEN'], seed);
  const all = jobs(7);
  assert.equal(all.length, 30 * 6);
  assert.deepEqual(all.map(j => j.task.id + j.arm + j.seed), jobs(7).map(j => j.task.id + j.arm + j.seed));
  assert.notDeepEqual(all.map(j => j.task.id + j.arm), jobs(8).map(j => j.task.id + j.arm));
  for (const task of tasks) {
    const mine = all.filter(j => j.task === task);
    for (const seed of [1, 2, 3]) assert.deepEqual(mine.filter(j => j.seed === seed).map(j => j.arm).sort(), ['CHOSEN', 'NONE']);
  }
  // Arms of one group run next to each other, in every order.
  const firsts = new Set(all.filter((j, i) => i === 0 || all[i - 1].group !== j.group).map(j => j.arm));
  assert.deepEqual([...firsts].sort(), ['CHOSEN', 'NONE']);
});

test('the task list covers every type with objective scoring', () => {
  const { tasks, base, saver } = loadTasks();
  const count = set => tasks.filter(t => t.set === set).length;
  assert.ok(tasks.length >= 24);
  assert.equal(count('loc'), base.localization.length);
  assert.equal(count('edit'), base.edit.length);
  assert.ok(count('report') >= 6);
  assert.equal(new Set(tasks.map(t => t.id)).size, tasks.length);
  for (const task of tasks.filter(t => t.set === 'report')) {
    assert.ok(['review', 'explain', 'failing'].includes(task.kind), task.id);
    assert.ok(task.rubric.length >= 2, task.id);
    for (const item of task.rubric) for (const source of item.line) assert.doesNotThrow(() => new RegExp(source, 'i'), `${task.id}/${item.id}`);
    assert.ok(task.kind === 'explain' ? /^[0-9a-f]{7,40}$/.test(task.at) : /^[0-9a-f]{7,40}$/.test(task.commit), task.id);
  }
  for (const kind of ['review', 'explain', 'failing']) assert.ok(tasks.some(t => t.kind === kind), kind);
  assert.ok(workerPrompt(tasks.find(t => t.set === 'loc'), base).endsWith(base.localizationSuffix));
  for (const id of saver.smokeTasks) assert.ok(tasks.some(t => t.id === id), id);
});

test('the task-success margin passes a no-effect batch at least 85% of the time at 5 seeds', () => {
  const report = simulationReport({ reps: 2000 })  // the registered table's own reps; 400 is too noisy for 0.85;
  assert.equal(report.seeds, 5);
  assert.ok(SIM_MARGINS.includes(TASK_SUCCESS_MARGIN));
  assert.ok(report.noEffect[TASK_SUCCESS_MARGIN] >= 0.85, JSON.stringify(report.noEffect));
  // The next tighter margin on the grid would not, so -0.15 is the tightest that does.
  assert.ok(report.noEffect[-0.125] < 0.85, JSON.stringify(report.noEffect));
  // ...and still fails most batches with a true 0.2 loss.
  assert.ok(report.trueDrop20[TASK_SUCCESS_MARGIN] <= 0.1, JSON.stringify(report.trueDrop20));
  assert.deepEqual(assumedItemRates(3).map(q => Number(q.toFixed(3))), [0.35, 0.65, 0.95]);
  // A perfectly stable task set passes any margin.
  assert.equal(simulateGate({ editRates: [1, 1], reportItems: [[1, 1]], reps: 20, margins: [-0.01] })[-0.01], 1);
});

test('co-primaries are Holm-adjusted, cost counts the inline field, and the gate pools edits and reports', () => {
  assert.deepEqual(holm([0.04, 0.01]), [0.04, 0.02]);
  assert.deepEqual(holm([0.03, 0.04]), [0.06, 0.06]);
  const reports = { r1: { rubric: [{ id: 'a', line: ['\\balpha\\b'] }, { id: 'b', line: ['\\bbeta\\b'] }], kind: 'explain' } };
  const runs = [];
  for (const [i, task] of ['e1', 'e2', 'r1', 'l1'].entries()) {
    for (const arm of ['NONE', 'CHOSEN']) {
      const set = task[0] === 'e' ? 'edit' : task[0] === 'r' ? 'report' : 'loc';
      runs.push({
        task, arm, set, seed: 1, wallMs: 1000, steps: 4, costUsd: 0.1 + i / 100, tokens: { output: arm === 'NONE' ? 1000 + i : 800 + i, input: 1, cacheRead: 10, cacheWrite: 5 },
        success: true, answer: set === 'report' ? (arm === 'NONE' ? 'alpha\nbeta' : 'alpha') : undefined,
        grade: set === 'loc' ? { recall: 1, precision: 1 } : undefined,
        selector: arm === 'CHOSEN' ? { tokens: { output: 20 }, usd: 0.02, ok: true, packs: [] } : undefined,
      });
    }
  }
  const scored = saverRuns(runs, reports);
  assert.equal(scored.find(r => r.task === 'r1' && r.arm === 'CHOSEN').grade.recall, 0.5);
  assert.equal(scored.find(r => r.arm === 'CHOSEN').costWithField, scored.find(r => r.arm === 'CHOSEN').costUsd + 20 * 25 / 1e6);
  const stats = compareSaver(scored, 'NONE', 'CHOSEN');
  assert.ok(stats['output tok'].pHolm >= stats['output tok'].pWilcoxon);
  assert.equal(stats['input + cache tok'].pHolm, undefined);
  assert.equal(stats.steps.read, 'descriptive');
  const gate = saverGate(scored, 'NONE', 'CHOSEN');
  assert.equal(gate.taskSuccess.n, 3);
  assert.equal(gate.taskSuccess.margin, TASK_SUCCESS_MARGIN);
  assert.ok(Math.abs(gate.taskSuccess.diff - -0.5 / 3) < 1e-9);
  assert.equal(gate.recall.margin, -0.05);
  const dir = join(mkdtempSync(join(tmpdir(), 'saver-')), 'S9');
  mkdirSync(dir);
  const text = '{"x":1}';
  const hash = createHash('sha256').update(text).digest('hex');
  writeFileSync(join(dir, 'batch.json'), JSON.stringify({ tasksSaverSha256: hash }));
  assert.doesNotThrow(() => assertSaverTasks([dir], text, [{ batch: 'S9', tasksSaverSha256: hash }]));
  assert.throws(() => assertSaverTasks([dir], '{"x":2}', []), /ran with tasks-saver.json/);
  writeFileSync(join(dir, 'batch.json'), '{}');
  assert.throws(() => assertSaverTasks([dir], text, [{ batch: 'S9', tasksSaverSha256: 'other' }]), /not the one pre-registered/);
  assert.throws(() => assertSaverTasks([dir], text, [{ batch: 'S9', files: { 'tasks-saver.json': 'other' } }]), /not the one pre-registered/);
  assert.doesNotThrow(() => assertSaverTasks([dir], text, [{ batch: 'S9', files: { 'tasks-saver.json': hash } }]));
  rmSync(dirname(dir), { recursive: true, force: true });
});
