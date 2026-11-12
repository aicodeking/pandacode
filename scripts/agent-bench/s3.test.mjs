import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { absoluteSaving, analyze, armFlag, launchProblem, logRatio, newLists, power, PRE_R18, resampledSd, S2_LISTS_SHA, s3Costs, treeHash, wilcoxonNormal } from './s3.mjs';
import { random, wilcoxon } from './stats.mjs';

test('BASE is S2\'s LEAN launch with Skill on; NEW adds Skill, writers keep the edit tools', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(PRE_R18)).digest('hex'), S2_LISTS_SHA);
  const source = 'const CLAUDE_SESSION_BOUND_TOOLS: &str = "S";\nconst CLAUDE_WORKER_DENIED_TOOLS: &str = "W";\nconst CLAUDE_READ_ONLY_DENIED_TOOLS: &str = "E";\nconst CLAUDE_SKILL_TOOL: &str = "Skill";';
  const lists = newLists(source);
  assert.equal(armFlag('BASE', 'ro', lists), `--disallowedTools=${PRE_R18.session},${PRE_R18.worker},Edit,Write,NotebookEdit`);
  assert.equal(armFlag('BASE', 'rw', lists), `--disallowedTools=${PRE_R18.session},${PRE_R18.worker}`);
  assert.equal(armFlag('NEW', 'ro', lists), '--disallowedTools=S,W,E,Skill');
  assert.equal(armFlag('NEW', 'rw', lists), '--disallowedTools=S,W,Skill');
  assert.throws(() => newLists(source.replace(/CLAUDE_SKILL_TOOL/, 'X')), /CLAUDE_SKILL_TOOL/);
  assert.equal(newLists().skill, 'Skill', 'the live providers.rs');
});

test('the primary uses one scale: Wilcoxon and CI both on log(NEW / BASE)', () => {
  const t = logRatio([[1, 0.5], [2, 1], [4, 2], [1, 0.5], [3, 1.5], [2, 1]]);
  assert.ok(Math.abs(t.change + 0.5) < 1e-12);
  assert.ok(Math.abs(t.ci[0] + 0.5) < 1e-9 && Math.abs(t.ci[1] + 0.5) < 1e-9);
  assert.ok(t.p < 0.05);
  assert.equal(logRatio([[0, 1]]), null, 'a zero cost has no ratio');
});

test('units are task × worker kind; cost is primary, first write and steps are Holm-adjusted', () => {
  const run = (task, worker, arm, usd, write, steps, recall) => ({ task, set: 'loc', worker, arm, billedUsd: usd, firstStep: { cacheWrite: write }, steps, wallMs: 1, tokens: { output: 1, cacheRead: 1 }, grade: { recall, precision: recall }, tools: { explore: 1, BashSearch: 0, BashOther: 0 }, init: { tools: [], skills: [] } });
  const runs = [];
  for (const [i, task] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) {
    for (const worker of ['ro', 'rw']) runs.push(run(task, worker, 'BASE', 0.2 + i / 100, 20000, 4, 1), run(task, worker, 'NEW', (0.2 + i / 100) * 0.8, 12000, 4, 0.5));
  }
  const s = analyze(runs);
  assert.equal(s.units, 12);
  assert.ok(Math.abs(s.table.billedUsd.change + 0.2) < 1e-9);
  assert.equal(s.table.billedUsd.read, 'lower');
  assert.ok(s.table.firstStepCacheWrite.pHolm >= s.table.firstStepCacheWrite.p);
  assert.equal(s.table.steps.read, 'not shown to be higher');
  assert.equal(s.table.outputTokens.read, 'descriptive');
  assert.equal(s.costByWorker.ro.n, 6);
  assert.equal(s.quality.recall.diff, -0.5);
  assert.equal(s.quality.recall.read, 'descriptive');
});

test('power: a clear drop with no noise always reads lower, no effect almost never', () => {
  const flat = Array.from({ length: 10 }, () => [0.2, 0.2, 0.2]);
  assert.equal(power(flat, { effect: -0.1, reps: 20, rounds: 200 }), 1);
  const noisy = Array.from({ length: 10 }, (_, i) => [0.1 + i / 100, 0.3, 0.2]);
  assert.ok(power(noisy, { effect: 0, reps: 60, rounds: 200 }) < 0.15);
});

test('the skills copy is pinned by paths and contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 's3-skills-'));
  try {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', 'SKILL.md'), 'one');
    const first = treeHash(dir);
    writeFileSync(join(dir, 'a', 'SKILL.md'), 'two');
    assert.notEqual(treeHash(dir), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a run whose launch is not its arm\'s stops the batch', () => {
  const copied = new Set(['my-skill']);
  const tools = names => names.map(n => (n.startsWith('pandacode') ? `mcp__pandacode_architect__${n}` : n));
  const base = { tools: tools(['Bash', 'Skill', 'pandacode_explore', 'pandacode_tool_list', 'pandacode_tool_save', 'pandacode_tool_run']), skills: ['debug', 'my-skill'] };
  assert.equal(launchProblem('BASE', base, copied), null);
  assert.match(launchProblem('BASE', { ...base, skills: ['debug'] }, copied), /no copied skill/);
  assert.match(launchProblem('BASE', { ...base, tools: base.tools.slice(0, 4) }, copied), /agent-made tools pandacode_tool_list$|agent-made tools list$/);
  assert.equal(launchProblem('NEW', { tools: tools(['Bash', 'pandacode_explore']), skills: [] }, copied), null);
  assert.match(launchProblem('NEW', base, copied), /NEW lists/);
});

test('the power estimate\'s normal Wilcoxon agrees with the sampled exact test at S3\'s size', () => {
  const next = random(7);
  for (const shift of [0, -0.05, -0.1]) {
    const d = Array.from({ length: 56 }, () => shift + (next() - 0.5) * 0.4);
    assert.ok(Math.abs(wilcoxonNormal(d) - wilcoxon(d)) < 0.01, `${shift}: ${wilcoxonNormal(d)} vs ${wilcoxon(d)}`);
  }
  assert.equal(wilcoxonNormal([0, 0]), 1);
});

test('S3b: a bundled-only launch lists no user skill, and BASE still lists Skill and bundled skills', () => {
  const copied = new Set(['my-skill']);
  const tools = ['Bash', 'Skill', 'mcp__x__pandacode_explore', 'mcp__x__pandacode_tool_list', 'mcp__x__pandacode_tool_save', 'mcp__x__pandacode_tool_run'];
  const opt = { bundledOnly: true };
  assert.equal(launchProblem('BASE', { tools, skills: ['debug'] }, copied, opt), null);
  assert.match(launchProblem('BASE', { tools, skills: ['debug', 'my-skill'] }, copied, opt), /user skill/);
  assert.match(launchProblem('BASE', { tools, skills: [] }, copied, opt), /no bundled skill/);
  assert.match(launchProblem('NEW', { tools: ['Bash'], skills: ['my-skill'] }, copied, opt), /user skill/);
  assert.equal(launchProblem('NEW', { tools: ['Bash'], skills: ['debug'] }, copied, opt), null);
});

test('S3b reports the ratio of means and the absolute saving per run with CIs', () => {
  const run = (task, arm, usd) => ({ task, worker: 'ro', set: 'loc', arm, billedUsd: usd });
  // A fixed $0.04 saving: cheap units fall by a larger share than dear ones.
  const runs = [0.1, 0.2, 0.3, 0.4].flatMap((b, i) => [run(`t${i}`, 'BASE', b), run(`t${i}`, 'NEW', b - 0.04)]);
  const a = absoluteSaving(runs, { rounds: 2000 });
  assert.ok(Math.abs(a.savingUsd - 0.04) < 1e-12 && Math.abs(a.savingCi[0] - 0.04) < 1e-12 && Math.abs(a.savingCi[1] - 0.04) < 1e-12);
  assert.ok(Math.abs(a.ratioOfMeans - (0.21 / 0.25 - 1)) < 1e-12);
  assert.ok(a.ratioCi[0] <= a.ratioOfMeans && a.ratioOfMeans <= a.ratioCi[1]);
  assert.equal(absoluteSaving([]), null);
});

test('S3b power input: S3 units are centred on their own ratio, and τ comes from the observed spread', () => {
  const run = (task, arm, usd) => ({ task, worker: 'rw', set: 'loc', arm, billedUsd: usd });
  const runs = [['a', 0.2, 0.1], ['b', 0.4, 0.3]].flatMap(([t, b, n]) => [run(t, 'BASE', b), run(t, 'BASE', b), run(t, 'NEW', n), run(t, 'NEW', n)]);
  const { costs, observedSd } = s3Costs(runs);
  assert.deepEqual(costs.map(list => list.map(x => Number(x.toFixed(12)))), [[0.2, 0.2, 0.2, 0.2], [0.4, 0.4, 0.4, 0.4]]);
  assert.ok(Math.abs(observedSd - Math.abs(Math.log(0.5) - Math.log(0.75)) / Math.SQRT2) < 1e-12);
  assert.equal(resampledSd(costs, { reps: 10 }), 0, 'identical runs give no resampling spread');
});
