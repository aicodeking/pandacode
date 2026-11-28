#!/usr/bin/env node
// Paired analysis. Every metric is re-derived from the transcripts, so a metric fix reaches old runs.
// `analyze.mjs --runs dirA,dirB` pools batches; each batch's gate is also reported alone.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { costAtLongContext, costBeyondFirstWrite, costToFullRecall, fieldUsd, gradeLocalization, metrics, PRICES, scoreRubric } from './metrics.mjs';
import { bootstrapCi, holm, maxT, mcnemar, mean, median, random, signTest, wilcoxon } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RECALL_MARGIN = -0.05;
// S1v3's pooled task-success gate (edit pass and report recall): P(pass | no effect) = 0.86 at 5 seeds, by
// `saver.mjs --simulate` (docs/token-saver-benchmark.md). S1v2's was -0.20 at 3 seeds.
export const TASK_SUCCESS_MARGIN = -0.15;
const PINNED = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).harness.models;
/** A run that resolved to another model than its alias is pinned to measured something else. */
export const offModel = run => Boolean(run.init?.model && PINNED[run.model] && run.init.model !== PINNED[run.model]);
const ALPHA = 0.05;

const goldBook = () => {
  // Newer runs record their own gold. v1 runs did not, so tasks-v1.json answers for them and must win.
  const load = file => JSON.parse(readFileSync(join(HERE, file), 'utf8')).localization ?? [];
  const book = {};
  for (const task of [...load('tasks.json'), ...load('tasks-heldout.json')]) book[task.id] = { gold: task.gold, tags: task.tags ?? [] };
  for (const task of load('tasks-v1.json')) book[task.id] = { gold: task.gold, tags: book[task.id]?.tags ?? [] };
  return book;
};

/** A long-context run whose filler was not read from cache did not test long context. */
const tested = run => run.longContext?.valid !== false;
export function loadRuns(dirs, model, book = goldBook()) {
  return dirs.flatMap(dir => (dir.endsWith('.csv') ? loadCsv(dir, model) : loadDir(dir, model, book)).filter(tested));
}

function loadDir(dir, model, book) {
  return readdirSync(dir).flatMap(name => {
    const file = join(dir, name, 'run.json');
    if (!existsSync(file)) return [];
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (model && record.model !== model) return [];
    const stream = join(dir, name, 'stream.jsonl');
    const measured = existsSync(stream) ? metrics(readFileSync(stream, 'utf8'), { skip: record.warmTurns ?? 0 }) : {};
    const run = { ...record, ...measured, batch: dir, wallMs: record.wallMs ?? 0 };
    if (offModel(run)) { console.error(`excluded ${name}: model ${run.init.model}, pinned ${PINNED[run.model]}`); return []; }
    const gold = record.gold ?? book[record.task]?.gold;
    if (gold && !run.set.startsWith('edit') && measured.stepText) {
      run.gold = gold;
      run.grade = gradeLocalization(measured, gold);
      run.success = run.grade.answered && !record.timedOut && !measured.isError;
      run.toRecall = costToFullRecall(measured, gold, run.model);
    }
    run.tags = book[record.task]?.tags ?? [];
    delete run.stepText;
    return [run];
  });
}

// Per-run CSV: what the analysis needs from each run, so it can rerun without the transcripts.
// Lists are joined with `;`. Long-context runs whose filler wasn't cached are kept with longValid=false.
const num = x => (x === '' || x == null ? null : Number(x));
const list = x => (x ? String(x).split(';').map(Number) : []);
const COLUMNS = {
  batch: null, set: r => r.set, task: r => r.task, arm: r => r.arm, seed: r => r.seed, model: r => r.model, tags: r => r.tags.join(';'),
  steps: r => r.steps, turns: r => r.turns, wallMs: r => r.wallMs, durationMs: r => r.durationMs, apiMs: r => r.apiMs, apiMsPerStep: r => r.apiMsPerStep, nonApiMs: r => r.nonApiMs,
  costUsd: r => r.costUsd, inputTok: r => r.tokens?.input, cacheReadTok: r => r.tokens?.cacheRead, cacheWriteTok: r => r.tokens?.cacheWrite, outputTok: r => r.tokens?.output,
  firstReadTok: r => r.firstStep?.cacheRead, firstWriteTok: r => r.firstStep?.cacheWrite, laterWrites: r => (r.laterWrites ?? []).join(';'),
  answered: r => r.grade?.answered, recall: r => r.grade?.recall, precision: r => r.grade?.precision, credit: r => r.grade?.credit,
  success: r => r.success, changedFiles: r => r.grade?.changed?.length,
  exploreCalls: r => r.explore?.args.length, exploreSingleKind: r => r.explore?.singleKind, exploreErrors: r => r.explore?.errors.length,
  exploreTruncated: r => r.explore?.truncated, exploreResultChars: r => (r.explore?.resultChars ?? []).join(';'),
  firstToolIsExplore: r => r.firstToolIsExplore, toolSearch: r => r.tools?.ToolSearch, subtype: r => r.subtype, longValid: r => r.longContext?.valid,
  // Batch R1 (--set reuse) only.
  // Token saver batches only: the selector's pick for a CHOSEN run.
  packs: r => (r.selector ? (r.selector.ok ? r.selector.packs.join('+') || 'none' : 'invalid') + (r.selector.packs.includes('caveman') ? `:${r.selector.level}` : '') : ''),
  reusePosition: r => r.reuse?.position, toolSaves: r => r.reuse?.calls?.save, toolRuns: r => r.reuse?.calls?.run, toolsAfter: r => r.reuse?.toolsAfter?.length,
};
const cell = value => (value == null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

/** Every run of one batch directory, any model, as sanitized CSV text. */
export function runsCsv(runs, batch) {
  const rows = runs.map(run => Object.entries(COLUMNS).map(([key, get]) => cell(get ? get(run) : batch)).join(','));
  return assertSanitized(`${[Object.keys(COLUMNS).join(','), ...rows].join('\n')}\n`);
}

export function parseCsv(text) {
  const records = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const [header, ...body] = records;
  return body.map(values => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ''])));
}

/** The inverse of runsCsv: run objects with the shapes the analysis reads. */
export function runFromRow(row, source) {
  const bool = x => (x === '' ? null : x === 'true');
  const loc = row.recall !== '';
  return {
    batch: source, set: row.set, task: row.task, arm: row.arm, seed: num(row.seed), model: row.model, tags: row.tags ? row.tags.split(';') : [],
    steps: num(row.steps), turns: num(row.turns), wallMs: num(row.wallMs) ?? 0, durationMs: num(row.durationMs), apiMs: num(row.apiMs), apiMsPerStep: num(row.apiMsPerStep), nonApiMs: num(row.nonApiMs),
    costUsd: num(row.costUsd),
    tokens: { input: num(row.inputTok) ?? 0, cacheRead: num(row.cacheReadTok) ?? 0, cacheWrite: num(row.cacheWriteTok) ?? 0, output: num(row.outputTok) ?? 0 },
    firstStep: { cacheRead: num(row.firstReadTok) ?? 0, cacheWrite: num(row.firstWriteTok) ?? 0 }, laterWrites: list(row.laterWrites),
    grade: loc ? { answered: bool(row.answered), recall: num(row.recall), precision: num(row.precision), credit: num(row.credit) } : row.changedFiles !== '' ? { changed: new Array(num(row.changedFiles)).fill('') } : undefined,
    success: bool(row.success),
    explore: row.exploreCalls === '' ? undefined : {
      args: new Array(num(row.exploreCalls)).fill({}), singleKind: num(row.exploreSingleKind), errors: new Array(num(row.exploreErrors)).fill(''),
      truncated: num(row.exploreTruncated), resultChars: list(row.exploreResultChars),
    },
    tools: { explore: num(row.exploreCalls) ?? 0, ToolSearch: num(row.toolSearch) ?? 0 },
    firstToolIsExplore: bool(row.firstToolIsExplore), subtype: row.subtype || undefined, longContext: row.longValid === '' ? undefined : { valid: bool(row.longValid) },
    ...(row.reusePosition ? { reuse: { position: num(row.reusePosition), calls: { save: num(row.toolSaves), run: num(row.toolRuns) }, toolsAfter: new Array(num(row.toolsAfter)).fill('') } } : {}),
  };
}

function loadCsv(file, model) {
  return parseCsv(readFileSync(file, 'utf8')).map(row => runFromRow(row, file)).filter(run => !model || run.model === model);
}

/** A batch's name: its directory, or its CSV file without the extension. */
const batchName = source => basename(source).replace(/\.csv$/, '');

const usd = (run, get) => (run.costUsd == null ? 0 : get(run, run.model));
const METRICS = {
  steps: { get: r => r.steps ?? 0, primary: true },
  'turns (num_turns, also counts parallel tool messages)': { get: r => r.turns ?? 0 },
  'wall s': { get: r => r.wallMs / 1000, wall: true },
  'duration s': { get: r => (r.durationMs ?? 0) / 1000 },
  'API s': { get: r => (r.apiMs ?? 0) / 1000 },
  'API s/step': { get: r => (r.apiMsPerStep ?? 0) / 1000 },
  'non-API s': { get: r => (r.nonApiMs ?? 0) / 1000 },
  'cost $': { get: r => r.costUsd ?? 0 },
  'cost beyond first write $': { get: r => usd(r, costBeyondFirstWrite) },
  'cost at 150k context $': { get: r => usd(r, costAtLongContext) },
  'cache read tok': { get: r => r.tokens?.cacheRead ?? 0 },
  'cache write tok': { get: r => r.tokens?.cacheWrite ?? 0 },
  'output tok': { get: r => r.tokens?.output ?? 0 },
  // Descriptive, outside the max-T family (pre-registered for batch C).
  'cache write tok/step after the first': { get: r => (r.laterWrites?.length ? r.laterWrites.reduce((a, b) => a + b, 0) / r.laterWrites.length : null), descriptive: true },
};
const fmt = (x, digits = 2) => (x == null || Number.isNaN(x) ? 'n/a' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(digits));
const pct = x => `${x > 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;

/** Per-task means per arm over all seeds; only tasks both arms ran count. */
function paired(runs, armA, armB, get) {
  const tasks = [...new Set(runs.map(r => r.task))].sort();
  return tasks.flatMap(task => {
    const side = arm => runs.filter(r => r.task === task && r.arm === arm).map(get).filter(x => x != null);
    const [a, b] = [side(armA), side(armB)];
    return a.length && b.length ? [{ task, a: mean(a), b: mean(b) }] : [];
  });
}
const relative = row => (row.a ? row.b / row.a - 1 : 0);

/**
 * `holmCost` (batch F on): cost $ leaves the max-T family of the other secondaries and is tested by
 * Wilcoxon alone, and reads use the registered wording ("not shown to be lower", never "within noise").
 * `holm` (F on, the tuned localization set only): steps and cost are the primary and co-primary, Holm-
 * adjusted; elsewhere neither carries a primary label or a Holm p. `descriptive` (AFTER-E and other
 * unregistered comparisons): every read is "descriptive".
 */
export function compareArms(runs, armA, armB, { skipWall = false, holmCost = false, holm: holmPair = holmCost, descriptive = false } = {}) {
  const chosen = Object.entries(METRICS).filter(([, m]) => !(skipWall && m.wall));
  const rows = Object.fromEntries(chosen.map(([name, m]) => [name, paired(runs, armA, armB, m.get)]));
  const outOfFamily = name => holmCost && name === 'cost $';
  const coPrimary = name => holmPair && name === 'cost $';
  const labelled = (name, m) => (holmCost ? holmPair && (m.primary || coPrimary(name)) : Boolean(m.primary));
  const family = Object.fromEntries(chosen.filter(([name, m]) => !m.primary && !m.descriptive && !outOfFamily(name)).map(([name]) => [name, rows[name].map(relative)]));
  const holmed = holmPair && rows.steps?.length && rows['cost $']?.length
    ? Object.fromEntries(holm(['steps', 'cost $'].map(name => wilcoxon(rows[name].map(row => row.b - row.a)))).map((p, i) => [['steps', 'cost $'][i], p]))
    : {};
  const corrected = rows.steps?.length > 1 ? maxT(family) : {};
  return Object.fromEntries(chosen.map(([name, m]) => {
    const list = rows[name];
    if (!list.length) return [name, null];
    const rel = list.map(relative);
    const diffs = list.map(row => row.b - row.a);
    const ci = bootstrapCi(rel);
    const pWilcoxon = wilcoxon(diffs);
    const pMaxT = corrected[name] ?? null;
    const pHolm = holmed[name] ?? null;
    const p = pHolm ?? (m.primary || m.descriptive || outOfFamily(name) ? pWilcoxon : pMaxT);
    const significant = p != null && p < ALPHA && (ci[0] > 0 || ci[1] < 0);
    const notShown = holmCost ? (mean(rel) < 0 ? 'not shown to be lower' : 'not shown to be higher') : 'within noise';
    return [name, {
      a: mean(list.map(r => r.a)), b: mean(list.map(r => r.b)), medianRel: median(rel), meanRel: mean(rel), ci,
      pWilcoxon, pSign: signTest(diffs), pMaxT, ...(pHolm == null ? {} : { pHolm }), primary: labelled(name, m), n: list.length,
      better: diffs.filter(d => d < 0).length, worse: diffs.filter(d => d > 0).length,
      read: descriptive || (holmCost && m.descriptive) ? 'descriptive' : significant ? (mean(rel) < 0 ? 'lower' : 'higher') : notShown,
    }];
  }));
}

function compareTable(stats, armA, armB) {
  const lines = [`| Metric | ${armA} | ${armB} | Median change | Mean change | 95% CI | Wilcoxon p | max-T p | Better / worse | Read |`, '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const [name, s] of Object.entries(stats)) {
    if (!s) continue;
    const label = s.primary ? `**${name}** (${s.pHolm == null ? 'primary' : `co-primary, Holm p ${s.pHolm.toFixed(3)}`})` : name;
    lines.push(`| ${label} | ${fmt(s.a)} | ${fmt(s.b)} | ${pct(s.medianRel)} | ${pct(s.meanRel)} | ${pct(s.ci[0])} to ${pct(s.ci[1])} | ${s.pWilcoxon.toFixed(3)} | ${s.pMaxT == null ? '–' : s.pMaxT.toFixed(3)} | ${s.better} / ${s.worse} | ${s.read} |`);
  }
  return lines;
}

/** Non-inferiority: the CI of the mean per-task change must sit above the margin. */
export function nonInferior(runs, armA, armB, get, margin = RECALL_MARGIN) {
  const rows = paired(runs, armA, armB, get);
  if (!rows.length) return null;
  const diffs = rows.map(r => r.b - r.a);
  const ci = bootstrapCi(diffs);
  return { a: mean(rows.map(r => r.a)), b: mean(rows.map(r => r.b)), diff: mean(diffs), ci, margin, pass: ci[0] > margin, n: rows.length };
}
export function gate(runs, armA, armB) {
  const loc = runs.filter(r => r.set === 'loc');
  const edit = runs.filter(r => r.set === 'edit');
  return {
    recall: nonInferior(loc, armA, armB, r => r.grade?.recall ?? 0),
    precision: nonInferior(loc, armA, armB, r => r.grade?.precision ?? 0),
    editPass: nonInferior(edit, armA, armB, r => (r.success ? 1 : 0)),
    // Batch F: tasks-edit-v2.json, its own registered set and gate (null when it didn't run).
    editV2Pass: nonInferior(runs.filter(r => r.set === 'edit2'), armA, armB, r => (r.success ? 1 : 0)),
  };
}
/** A descriptive comparison (no `pass`) prints its change and CI with no verdict. */
const gateLines = g => Object.entries(g).filter(([, v]) => v).map(([name, v]) => (v.pass == null
  ? `- descriptive: ${name} ${v.a.toFixed(3)} → ${v.b.toFixed(3)}, CI of change ${v.ci[0].toFixed(3)} to ${v.ci[1].toFixed(3)} (${v.n} tasks; no gate)`
  : `- ${v.pass ? 'PASS' : 'FAIL'}: ${name} ${v.a.toFixed(3)} → ${v.b.toFixed(3)}, CI of change ${v.ci[0].toFixed(3)} to ${v.ci[1].toFixed(3)}, margin ${v.margin} (${v.n} tasks)`));
/** Drops the verdicts of a descriptive comparison, keeping every number. */
export const withoutVerdict = g => Object.fromEntries(Object.entries(g).map(([name, v]) => [name, v && Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'pass'))]));

// ---------- Token saver benchmark (docs/token-saver-benchmark.md) ----------

/**
 * Report runs are rescored from their answer, so a rubric fix reaches old runs. CHOSEN's cost counts
 * the lead's marginal cost of writing the tokenSaver field inline (the selector's output tokens at the
 * lead's output price); the standalone selector call is reported apart, never folded in.
 */
export function saverRuns(runs, reports) {
  return runs.map(run => {
    const task = reports[run.task];
    const grade = run.set === 'report' && task && run.answer != null ? scoreRubric(run.answer, task.rubric, task.kind) : run.grade;
    const field = run.selector ? run.selector.fieldUsd ?? fieldUsd(run.selector.tokens?.output) : 0;
    return { ...run, grade, fieldUsd: field, costWithField: (run.costUsd ?? 0) + field };
  });
}
export const SAVER_METRICS = {
  'output tok': { get: r => r.tokens?.output ?? 0, role: 'co-primary' },
  'cost $ (with the field)': { get: r => r.costWithField ?? r.costUsd ?? 0, role: 'co-primary' },
  'input + cache tok': { get: r => (r.tokens?.input ?? 0) + (r.tokens?.cacheRead ?? 0) + (r.tokens?.cacheWrite ?? 0), role: 'secondary' },
  steps: { get: r => r.steps ?? 0, role: 'descriptive' },
  'wall s': { get: r => r.wallMs / 1000, role: 'descriptive', wall: true },
};
/** Wilcoxon on per-task means; the two co-primaries are Holm-adjusted; one secondary; the rest descriptive. */
export function compareSaver(runs, armA, armB, { skipWall = false } = {}) {
  const chosen = Object.entries(SAVER_METRICS).filter(([, m]) => !(skipWall && m.wall));
  const stats = Object.fromEntries(chosen.map(([name, m]) => {
    const list = paired(runs, armA, armB, m.get);
    if (!list.length) return [name, null];
    const rel = list.map(relative);
    const diffs = list.map(row => row.b - row.a);
    return [name, {
      a: mean(list.map(r => r.a)), b: mean(list.map(r => r.b)), medianRel: median(rel), meanRel: mean(rel), ci: bootstrapCi(rel),
      pWilcoxon: wilcoxon(diffs), pSign: signTest(diffs), role: m.role, n: list.length,
      better: diffs.filter(d => d < 0).length, worse: diffs.filter(d => d > 0).length,
    }];
  }));
  const primaries = Object.keys(stats).filter(name => stats[name]?.role === 'co-primary');
  holm(primaries.map(name => stats[name].pWilcoxon)).forEach((p, i) => { stats[primaries[i]].pHolm = p; });
  for (const s of Object.values(stats)) {
    if (!s) continue;
    const p = s.role === 'co-primary' ? s.pHolm : s.pWilcoxon;
    const significant = p < ALPHA && (s.ci[0] > 0 || s.ci[1] < 0);
    s.read = s.role === 'descriptive' ? 'descriptive' : significant ? (s.meanRel < 0 ? 'lower' : 'higher') : s.meanRel < 0 ? 'not shown to be lower' : 'not shown to be higher';
  }
  return stats;
}
function saverTable(stats, armA, armB) {
  const lines = [`| Metric | Role | ${armA} | ${armB} | Mean change | 95% CI | Wilcoxon p | Holm p | Better / worse | Read |`, '|---|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const [name, s] of Object.entries(stats)) {
    if (s) lines.push(`| ${name} | ${s.role} | ${fmt(s.a)} | ${fmt(s.b)} | ${pct(s.meanRel)} | ${pct(s.ci[0])} to ${pct(s.ci[1])} | ${s.pWilcoxon.toFixed(3)} | ${s.pHolm == null ? '–' : s.pHolm.toFixed(3)} | ${s.better} / ${s.worse} | ${s.read} |`);
  }
  return lines;
}
/** Task success: an edit run's pass, a report run's rubric recall. */
export const taskSuccess = r => (r.set === 'edit' ? (r.success ? 1 : 0) : r.grade?.recall ?? 0);
export function saverGate(runs, armA, armB) {
  const loc = runs.filter(r => r.set === 'loc');
  return {
    recall: nonInferior(loc, armA, armB, r => r.grade?.recall ?? 0),
    precision: nonInferior(loc, armA, armB, r => r.grade?.precision ?? 0),
    taskSuccess: nonInferior(runs.filter(r => r.set === 'edit' || r.set === 'report'), armA, armB, taskSuccess, TASK_SUCCESS_MARGIN),
  };
}
/** Which packs the selector chose, per task type ('loc', 'edit', or the report kind). */
export function packMix(runs) {
  const mix = {};
  for (const run of runs.filter(r => r.arm === 'CHOSEN' && r.selector)) {
    const type = run.set === 'report' ? `report:${run.kind}` : run.set;
    const row = (mix[type] ??= { picks: 0, none: 0, invalid: 0, packs: {}, levels: {} });
    row.picks++;
    if (!run.selector.ok) row.invalid++;
    if (!run.selector.packs.length) row.none++;
    for (const pack of run.selector.packs) row.packs[pack] = (row.packs[pack] ?? 0) + 1;
    if (run.selector.packs.includes('caveman')) row.levels[run.selector.level] = (row.levels[run.selector.level] ?? 0) + 1;
  }
  return mix;
}
const sha256 = text => createHash('sha256').update(text).digest('hex');

// ---------- Analysis code pins ----------

/** The files whose code turns runs into results; every registration from round 17 on records their sha256. */
export const ANALYSIS_FILES = ['analyze.mjs', 'metrics.mjs', 'stats.mjs'];
export const analysisHashes = (dir = HERE) => Object.fromEntries(ANALYSIS_FILES.map(file => [file, sha256(readFileSync(join(dir, file)))]));
export const readRegistrations = (file = join(HERE, 'results', 'preregistrations.jsonl')) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
/**
 * One line per batch: whether the analysis code now on disk is the code the batch's newest registration
 * entry with `analysis` hashes recorded. A CSV such as `v6-Fv2` also answers to `Fv2`; deviations
 * (`Fv2-3`) count for their batch. A difference prints a MISMATCH line; the output is then not the
 * registered analysis.
 */
export function analysisCheck(batches, registrations, now = analysisHashes()) {
  return batches.map(batch => {
    const names = [...new Set([batch, batch.replace(/^[a-z0-9]+-/, '')])];
    const entry = registrations.findLast(e => e.analysis && names.some(name => e.batch === name || e.batch.startsWith(`${name}-`)));
    if (!entry) return `analysis code: no hashes registered for ${batch}`;
    const off = ANALYSIS_FILES.filter(file => entry.analysis[file] !== now[file]);
    if (!off.length) return `analysis code matches ${entry.marker ?? entry.batch} for ${batch}`;
    return `MISMATCH: ${batch}: ${off.map(file => `${file} is ${now[file].slice(0, 12)}, registered ${String(entry.analysis[file]).slice(0, 12)} (${entry.marker ?? entry.batch})`).join('; ')}. This output is not the registered analysis.`;
  });
}

// ---------- Post-hoc sensitivity (token saver S1v3; written after its results were known) ----------

/**
 * Rescores report answers with other rubrics. The scorer sees only the answer and the task's rubric,
 * never the arm, seed or run id.
 */
export const blindRescore = (runs, rubrics) => runs.map(run => (run.set === 'report' && rubrics[run.task]
  ? { ...run, grade: scoreRubric(run.answer ?? '', rubrics[run.task].rubric, rubrics[run.task].kind) }
  : run));

const clamp01 = p => Math.min(1, Math.max(0, p));
/**
 * P(a non-inferiority gate passes), Fv2's design: each task runs `seeds` times per arm, the gate is the
 * lower end of the bootstrap CI of the mean per-task difference against `margin`. Rates (`kind: 'rate'`)
 * are Bernoulli at each task's shrunk BEFORE rate ((passes + 0.5) / (runs + 1)), plus `effect` for B;
 * scores (`kind: 'score'`, recall or precision) resample each task's BEFORE runs, plus `effect` for B.
 */
export function simulateNonInferior({ values, kind, effect = 0, margin = RECALL_MARGIN, seeds = 2, reps = 1000, rounds = 2000, seed = 0xca1b, shrink = true }) {
  const next = random(seed);
  const rates = values.map(list => (list.filter(Boolean).length + (shrink ? 0.5 : 0)) / (list.length + (shrink ? 1 : 0)));
  const arm = (i, shift) => {
    let sum = 0;
    for (let s = 0; s < seeds; s++) sum += kind === 'rate' ? (next() < clamp01(rates[i] + shift) ? 1 : 0) : values[i][Math.floor(next() * values[i].length)] + shift;
    return sum / seeds;
  };
  let passes = 0;
  for (let rep = 0; rep < reps; rep++) {
    const diffs = values.map((_, i) => arm(i, effect) - arm(i, 0));
    if (bootstrapCi(diffs, rounds, (seed + rep * 7919) >>> 0)[0] > margin) passes++;
  }
  return passes / reps;
}

/**
 * How often a non-inferiority gate passes with no effect at all, from one arm's own runs: per task,
 * two resamples of that task's runs stand in for the two arms (simulateNonInferior with `kind: 'score'`).
 * `seeds` defaults to the most runs any task has.
 */
export function noEffectGate(runs, arm, get, margin, { seeds, reps = 1000, rounds = 2000, seed = 0x0e0e } = {}) {
  const tasks = [...new Set(runs.filter(r => r.arm === arm).map(r => r.task))].sort();
  const values = tasks.map(task => runs.filter(r => r.task === task && r.arm === arm).map(get));
  const n = seeds ?? Math.max(...values.map(list => list.length));
  return { arm, tasks: tasks.length, reps, margin, seeds: n, passRate: simulateNonInferior({ values, kind: 'score', margin, seeds: n, reps, rounds, seed }) };
}

/** Report recall per task and arm, means over runs. */
const reportRecall = runs => Object.fromEntries([...new Set(runs.filter(r => r.set === 'report').map(r => r.task))].sort().map(task => [task,
  Object.fromEntries([...new Set(runs.map(r => r.arm))].sort().map(arm => { const list = runs.filter(r => r.task === task && r.arm === arm); return [arm, list.length ? Number(mean(list.map(r => r.grade?.recall ?? 0)).toFixed(3)) : null]; }))]));

function saverPosthoc(runs, args, registeredGate, [armA, armB]) {
  const posthoc = { label: 'POST-HOC SENSITIVITY: written after the batch\'s results were known; it never changes a registered verdict.' };
  const lines = ['', '## POST-HOC SENSITIVITY (not registered; written after the results were known)'];
  const success = list => list.filter(r => r.set === 'edit' || r.set === 'report');
  if (args['strict-rubrics']) {
    const text = readFileSync(args['strict-rubrics'], 'utf8');
    const strict = Object.fromEntries(JSON.parse(text).report.map(t => [t.id, t]));
    const rescored = blindRescore(runs, strict);
    const gateNow = nonInferior(success(rescored), armA, armB, taskSuccess, TASK_SUCCESS_MARGIN);
    posthoc.strictRubrics = { sha256: sha256(text), registered: registeredGate, strict: gateNow, reportRecallRegistered: reportRecall(runs), reportRecallStrict: reportRecall(rescored) };
    lines.push(`Task success, registered rubrics: ${registeredGate.a.toFixed(3)} → ${registeredGate.b.toFixed(3)}, CI ${registeredGate.ci[0].toFixed(3)} to ${registeredGate.ci[1].toFixed(3)} (registered verdict: ${registeredGate.pass ? 'pass' : 'fail'})`,
      `Task success, strict rubrics (blind rescoring): ${gateNow.a.toFixed(3)} → ${gateNow.b.toFixed(3)}, CI ${gateNow.ci[0].toFixed(3)} to ${gateNow.ci[1].toFixed(3)}, margin ${gateNow.margin}: would ${gateNow.pass ? 'pass' : 'fail'} (sensitivity only)`,
      `Report recall per task (registered → strict): ${JSON.stringify(Object.fromEntries(Object.keys(posthoc.strictRubrics.reportRecallStrict).map(t => [t, [posthoc.strictRubrics.reportRecallRegistered[t], posthoc.strictRubrics.reportRecallStrict[t]]])))}`);
  }
  if (args['no-effect']) {
    const loc = runs.filter(r => r.set === 'loc');
    posthoc.noEffect = {
      note: `${armA} resampled against itself; descriptive`,
      recall: noEffectGate(loc, armA, r => r.grade?.recall ?? 0, RECALL_MARGIN),
      precision: noEffectGate(loc, armA, r => r.grade?.precision ?? 0, RECALL_MARGIN),
      taskSuccess: noEffectGate(success(runs), armA, taskSuccess, TASK_SUCCESS_MARGIN),
    };
    lines.push(`No-effect pass rates (${armA} against ${armA}, descriptive): ${Object.entries(posthoc.noEffect).filter(([k]) => k !== 'note').map(([k, v]) => `${k} ${v.passRate.toFixed(2)} at ${v.margin}`).join(', ')}`);
  }
  return { posthoc, lines };
}

/** Refuses runs made with another tasks-saver.json than the one on disk and pre-registered for the batch. */
export function assertSaverTasks(dirs, text, registrations) {
  const now = sha256(text);
  for (const dir of dirs) {
    const pinned = existsSync(join(dir, 'batch.json')) ? JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')).tasksSaverSha256 : null;
    if (pinned && pinned !== now) throw new Error(`${basename(dir)} ran with tasks-saver.json ${pinned.slice(0, 12)}, the file is now ${now.slice(0, 12)}`);
    const entry = registrations.findLast(e => e.batch === basename(dir));
    const registered = entry?.files?.['tasks-saver.json'] ?? entry?.tasksSaverSha256;
    if (registered && registered !== now) throw new Error(`tasks-saver.json is not the one pre-registered for ${basename(dir)}`);
  }
}
function saverMain(dirs, args) {
  const text = readFileSync(join(HERE, 'tasks-saver.json'), 'utf8');
  const registrations = readRegistrations();
  assertSaverTasks(dirs, text, registrations);
  for (const line of analysisCheck(dirs.map(batchName), registrations)) console.log(line);
  const reports = Object.fromEntries(JSON.parse(text).report.map(t => [t.id, t]));
  const runs = saverRuns(dirs.flatMap(dir => loadDir(dir, null, goldBook())), reports);
  const [armA, armB] = ['NONE', 'CHOSEN'];
  const stats = compareSaver(runs, armA, armB, { skipWall: args['skip-wall'] });
  const g = saverGate(runs, armA, armB);
  const bySet = Object.fromEntries(['loc', 'edit', 'report'].map(set => [set, compareSaver(runs.filter(r => r.set === set), armA, armB, { skipWall: true })['output tok']]));
  const chosen = runs.filter(r => r.arm === 'CHOSEN' && r.selector);
  const selector = { calls: chosen.length, standaloneUsd: chosen.reduce((s, r) => s + (r.selector.usd ?? 0), 0), fieldUsd: chosen.reduce((s, r) => s + r.fieldUsd, 0), invalid: chosen.filter(r => !r.selector.ok).length };
  const summary = { runs: runs.length, comparison: `${armA}-${armB}`, stats, gate: g, outputBySet: bySet, selector, packMix: packMix(runs) };
  const out = [`## ${armA} → ${armB}`, '', ...saverTable(stats, armA, armB), '', 'Gates:', ...gateLines(g), '',
    `Output tokens by set (descriptive): ${JSON.stringify(Object.fromEntries(Object.entries(bySet).map(([k, v]) => [k, v && { meanRel: v.meanRel, ci: v.ci, n: v.n }])))}`,
    `Selector: ${JSON.stringify(selector)} (cost rows include only fieldUsd; standaloneUsd is what the benchmark's separate call cost)`, `Pack mix: ${JSON.stringify(summary.packMix)}`];
  if (args['strict-rubrics'] || args['no-effect']) {
    const { posthoc, lines } = saverPosthoc(runs, args, g.taskSuccess, [armA, armB]);
    summary.posthoc = posthoc;
    out.push(...lines);
  }
  console.log(out.join('\n'));
  if (args.summary) {
    mkdirSync(dirname(args.summary), { recursive: true });
    writeFileSync(args.summary, `${assertSanitized(JSON.stringify(summary, null, 1))}\n`);
  }
}

/** Fits write, read and output prices to the observed costs by least squares. */
export function fitPrices(runs) {
  const rows = runs.filter(r => r.costUsd > 0 && r.tokens).map(r => ({ x: [r.tokens.cacheWrite, r.tokens.cacheRead, r.tokens.output].map(t => t / 1e6), y: r.costUsd }));
  if (rows.length < 4) return null;
  const n = 3;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const { x, y } of rows) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j];
      A[i][n] += x[i] * y;
    }
  }
  for (let i = 0; i < n; i++) {
    const pivot = Math.max(...Array.from({ length: n - i }, (_, k) => k + i).map(k => Math.abs(A[k][i])));
    if (!(pivot > 0)) return null; // the runs don't vary enough to tell the prices apart
    const at = A.findIndex((row, k) => k >= i && Math.abs(row[i]) === pivot);
    [A[i], A[at]] = [A[at], A[i]];
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j];
    }
  }
  const [write, read, output] = A.map((row, i) => row[n] / row[i]);
  const errors = rows.map(({ x, y }) => Math.abs(x[0] * write + x[1] * read + x[2] * output - y) / y);
  return { write, read, output, medianError: median(errors), maxError: Math.max(...errors), runs: rows.length };
}

function taskTable(runs, armA, armB, set) {
  const tasks = [...new Set(runs.map(r => r.task))].sort();
  const quality = set.startsWith('edit') ? 'Passes' : 'Recall';
  const lines = [`| Task | Steps | Duration s | Cost $ | ${quality} | Explore adoption |`, '|---|---:|---:|---:|---:|---:|'];
  for (const task of tasks) {
    const of = arm => runs.filter(r => r.task === task && r.arm === arm);
    const avg = (arm, get) => (of(arm).length ? mean(of(arm).map(get)) : null);
    const cell = arm => (set.startsWith('edit') ? `${of(arm).filter(r => r.success).length}/${of(arm).length}` : fmt(avg(arm, r => r.grade?.recall ?? 0)));
    const after = of(armB);
    lines.push(`| ${task} | ${fmt(avg(armA, r => r.steps ?? 0), 1)} → ${fmt(avg(armB, r => r.steps ?? 0), 1)} | ${fmt(avg(armA, r => (r.durationMs ?? 0) / 1000), 0)} → ${fmt(avg(armB, r => (r.durationMs ?? 0) / 1000), 0)} | ${fmt(avg(armA, r => r.costUsd ?? 0))} → ${fmt(avg(armB, r => r.costUsd ?? 0))} | ${cell(armA)} → ${cell(armB)} | ${after.filter(r => r.tools?.explore).length}/${after.length} |`);
  }
  return lines;
}

function exploreUse(runs) {
  const after = runs.filter(r => r.arm === 'after' && r.explore);
  const sizes = after.flatMap(r => r.explore.resultChars);
  const calls = after.reduce((sum, r) => sum + r.explore.args.length, 0);
  return {
    runs: after.length, adopted: after.filter(r => r.tools.explore > 0).length, firstTool: after.filter(r => r.firstToolIsExplore).length,
    callsPerRun: after.length ? mean(after.map(r => r.tools.explore)) : 0, calls,
    singleKindCalls: after.reduce((sum, r) => sum + r.explore.singleKind, 0),
    errors: after.reduce((sum, r) => sum + r.explore.errors.length, 0), runsWithErrors: after.filter(r => r.explore.errors.length).length,
    truncatedResults: after.reduce((sum, r) => sum + r.explore.truncated, 0),
    resultChars: sizes.length ? { median: median(sizes), max: Math.max(...sizes) } : null,
    toolSearch: after.reduce((sum, r) => sum + r.tools.ToolSearch, 0),
  };
}

/** Cache writes after the first step: weighted by step, then the median, per arm. */
function laterWrites(runs, armA, armB) {
  return Object.fromEntries([armA, armB].map(arm => {
    const all = runs.filter(r => r.arm === arm).flatMap(r => r.laterWrites ?? []);
    return [arm, all.length ? { stepWeighted: mean(all), median: median(all), steps: all.length } : null];
  }));
}

function firstWriteShare(runs) {
  const usable = runs.filter(r => r.costUsd > 0 && r.firstStep);
  if (!usable.length) return null;
  const tokens = mean(usable.map(r => r.firstStep.cacheWrite));
  const share = mean(usable.map(r => r.firstStep.cacheWrite * (PRICES[r.model]?.write ?? PRICES.sonnet.write) / 1e6 / r.costUsd));
  return { tokens, share };
}

function setSection(title, runs, armA, armB, set, options) {
  if (!runs.length) return { lines: [], stats: null };
  const stats = compareArms(runs, armA, armB, options);
  const lines = [`## ${title} (${runs.length} runs, ${new Set(runs.map(r => r.task)).size} tasks)`, '', ...compareTable(stats, armA, armB), '', ...taskTable(runs, armA, armB, set), ''];
  return { lines, stats };
}

/** Summaries are committed: they may hold numbers and task ids, never transcripts or paths. */
export function assertSanitized(text) {
  const bad = text.match(/\/Users\/|\/home\/|\/private\/|\/tmp\/|[\w.+-]+@[\w-]+\.[a-z]{2,}|Bearer /);
  if (bad) throw new Error(`summary is not clean: ${bad[0]}`);
  return text;
}

/**
 * Batch Fv2's registered edit-steps test, on the 6 edits and the 14 edit2 tasks together: AFTER's
 * steps are no more than BEFORE's +5% (non-superiority). Per task, the relative change of the mean
 * steps over seeds. Passes only if the one-sided Wilcoxon on (change - margin) gives p < 0.05 and
 * the upper end of the 95% bootstrap CI of the mean change is below the margin.
 */
export const EDIT_STEPS_MARGIN = 0.05;
export function editStepsGate(runs, armA, armB, margin = EDIT_STEPS_MARGIN) {
  const rows = paired(runs.filter(r => r.set === 'edit' || r.set === 'edit2'), armA, armB, r => r.steps ?? 0);
  if (!rows.length) return null;
  const rel = rows.map(relative);
  const ci = bootstrapCi(rel);
  const p = wilcoxon(rel.map(x => x - margin), { side: 'less' });
  return { a: mean(rows.map(r => r.a)), b: mean(rows.map(r => r.b)), meanRel: mean(rel), ci, p, margin, pass: p < ALPHA && ci[1] < margin, n: rows.length };
}

function heldoutSection(heldout, armA, armB, options, summary, out) {
  if (!heldout.length) return;
  const { lines, stats } = setSection('Held-out localization', heldout, armA, armB, 'loc', { ...options, holm: false, descriptive: true });
  const g = withoutVerdict(gate(heldout, armA, armB));
  summary.heldout = { runs: heldout.length, loc: stats, gate: g, exploreUse: exploreUse(heldout) };
  out.push(...lines, 'Held-out gate (descriptive):', ...gateLines(g), '');
}

function locExtras(loc, armA, armB, options, summary, out) {
  if (!loc.length) return;
  summary.laterWrites = laterWrites(loc, armA, armB);
  summary.firstWrite = firstWriteShare(loc);
  const ceiling = new Set([...new Set(loc.map(r => r.task))].filter(task => mean(loc.filter(r => r.task === task && r.arm === armA).map(r => r.grade?.recall ?? 0)) >= 1));
  const under = loc.filter(r => !ceiling.has(r.task));
  if (under.length) summary.underCeiling = { tasks: new Set(under.map(r => r.task)).size, atCeiling: ceiling.size, recall: nonInferior(under, armA, armB, r => r.grade?.recall ?? 0), steps: compareArms(under, armA, armB, { ...options, holm: false }).steps };
  const tags = [...new Set(loc.flatMap(r => r.tags))].sort();
  summary.byTag = Object.fromEntries(tags.map(tag => [tag, nonInferior(loc.filter(r => r.tags.includes(tag)), armA, armB, r => r.grade?.recall ?? 0)]));
  out.push(`Later-step cache writes: ${JSON.stringify(summary.laterWrites)}`, `First write: ${JSON.stringify(summary.firstWrite)}`, `Under the ceiling: ${JSON.stringify(summary.underCeiling ?? null)}`, `By tag (recall): ${JSON.stringify(summary.byTag)}`, '');
}

function editExtras(all, armA, armB, summary, out, descriptive = false) {
  const edit = all.filter(r => r.set === 'edit');
  if (edit.length) {
    const pairs = {};
    for (const run of edit.filter(r => [armA, armB].includes(r.arm))) (pairs[`${run.task}/${run.seed}`] ??= {})[run.arm] = run;
    const whole = Object.values(pairs).filter(p => p[armA] && p[armB]);
    const onlyA = whole.filter(p => p[armA].success && !p[armB].success).length;
    const onlyB = whole.filter(p => !p[armA].success && p[armB].success).length;
    const changed = arm => { const list = edit.filter(r => r.arm === arm).map(r => r.grade?.changed?.length ?? 0); return list.length ? mean(list) : null; };
    summary.editPairs = { onlyA, onlyB, pMcNemar: mcnemar(onlyA, onlyB), pairs: whole.length, changedFiles: { [armA]: changed(armA), [armB]: changed(armB) } };
    out.push(`Edit pairs: ${JSON.stringify(summary.editPairs)}`, '');
  }
  const s = editStepsGate(all, armA, armB);
  if (!s) { summary.editSteps = null; return; }
  if (descriptive) {
    const { pass, ...numbers } = s;
    summary.editSteps = numbers;
    out.push(`Edit steps, edit + edit2 (${s.n} tasks, descriptive): mean change ${pct(s.meanRel)}, CI ${pct(s.ci[0])} to ${pct(s.ci[1])}`, '');
    return;
  }
  summary.editSteps = s;
  out.push(`Edit steps, edit + edit2 (${s.n} tasks): ${s.pass ? 'PASS' : 'FAIL'} non-superiority at +${s.margin * 100}%, mean change ${pct(s.meanRel)}, CI ${pct(s.ci[0])} to ${pct(s.ci[1])}, one-sided Wilcoxon p ${s.p.toFixed(3)}`, '');
}

function gateSection(all, dirs, armA, armB, summary, out, descriptive = false) {
  summary.gatePerBatch = {};
  out.push(descriptive ? '## Quality (descriptive, no gate)' : '## Gate', '');
  const judge = g => (descriptive ? withoutVerdict(g) : g);
  for (const dir of dirs) {
    const g = judge(gate(all.filter(r => r.batch === dir), armA, armB));
    summary.gatePerBatch[batchName(dir)] = g;
    out.push(`Batch ${batchName(dir)}:`, ...gateLines(g), '');
  }
  if (dirs.length > 1) {
    summary.gatePooled = judge(gate(all, armA, armB));
    out.push('Pooled:', ...gateLines(summary.gatePooled), '');
  }
}

/** The arm comparison: every set, the extras and the gates, as text lines and a summary. */
export function armReport(dirs, args, book = goldBook()) {
  const [armA, armB] = args.arms.split(',');
  const sets = args.set.split(',');
  const loaded = loadRuns(dirs, args.model, book).filter(r => sets.includes(r.set));
  // Held-out tasks are reported apart and never pooled with the tuned ones (pre-registered for batch E).
  const isHeldout = r => r.tags.includes('held-out');
  const all = loaded.filter(r => !isHeldout(r));
  const descriptive = Boolean(args.descriptive);
  // Holm and the co-primary label belong to the tuned localization set alone (batch F on).
  const options = { skipWall: args['skip-wall'], holmCost: args['holm-cost'], holm: false, descriptive };
  const out = [];
  const summary = { model: args.model, arms: [armA, armB], batches: dirs.length, runs: all.length, ...(descriptive ? { descriptive: true } : {}) };
  heldoutSection(loaded.filter(isHeldout), armA, armB, options, summary, out);
  for (const [set, title] of [['loc', 'Localization'], ['edit', 'Edit tasks'], ['edit2', 'Edit tasks v2'], ['long', 'Long context']]) {
    const { lines, stats } = setSection(title, all.filter(r => r.set === set), armA, armB, set, { ...options, holm: Boolean(args['holm-cost']) && set === 'loc' });
    out.push(...lines);
    if (stats) summary[set] = stats;
  }
  const loc = all.filter(r => r.set === 'loc');
  locExtras(loc, armA, armB, options, summary, out);
  summary.fittedPrices = fitPrices(all);
  summary.exploreUse = { loc: exploreUse(loc), edit: exploreUse(all.filter(r => r.set === 'edit')) };
  out.push(`Fitted prices: ${JSON.stringify(summary.fittedPrices)}`, `Explore use: ${JSON.stringify(summary.exploreUse)}`, '');
  editExtras(all, armA, armB, summary, out, descriptive);
  gateSection(all, dirs, armA, armB, summary, out, descriptive);
  const failed = all.filter(r => !r.success);
  summary.failures = failed.map(r => ({ task: r.task, arm: r.arm, seed: r.seed, reason: r.subtype ?? 'failed' }));
  out.push(`Runs counted as failures: ${failed.length}`);
  return { out, summary };
}

/**
 * Batch R1, descriptive: per task position and arm, means over chains, and each chain's runs. No p-values.
 * `laterWritesPerStep` is the mean cache write of a run's steps after its first.
 */
export function reuseReport(runs) {
  const r1 = runs.filter(run => run.set === 'reuse' && run.reuse);
  const perStep = run => (run.laterWrites?.length ? mean(run.laterWrites) : 0);
  const row = run => ({
    position: run.reuse.position, arm: run.arm, seed: run.seed, task: run.task, steps: run.steps, toolSaves: run.reuse.calls.save, toolRuns: run.reuse.calls.run,
    toolsAfter: run.reuse.toolsAfter.length, firstWrite: run.firstStep?.cacheWrite ?? 0, laterWritesPerStep: Math.round(perStep(run)),
    costUsd: run.costUsd, output: run.tokens?.output, pass: Boolean(run.success),
  });
  const rows = r1.map(row).sort((a, b) => a.arm.localeCompare(b.arm) || a.seed - b.seed || a.position - b.position);
  const keys = [...new Set(rows.map(r => `${r.position}|${r.arm}`))].sort();
  const positions = keys.map(key => {
    const group = rows.filter(r => `${r.position}|${r.arm}` === key);
    const avg = field => Number(mean(group.map(r => r[field] ?? 0)).toFixed(4));
    return { position: group[0].position, arm: group[0].arm, runs: group.length, steps: avg('steps'), toolSaves: avg('toolSaves'), toolRuns: avg('toolRuns'), toolsAfter: avg('toolsAfter'), firstWrite: avg('firstWrite'), laterWritesPerStep: avg('laterWritesPerStep'), costUsd: avg('costUsd'), output: avg('output'), passRate: avg('pass') };
  });
  return { batch: 'R1', descriptive: true, runs: rows.length, positions, chains: rows };
}

function exportCsv(dirs, file, book) {
  if (dirs.length !== 1 || dirs[0].endsWith('.csv')) throw new Error('--export-csv takes one batch directory');
  // Every model, and invalid long-context runs too (marked), so the CSV is the whole batch.
  const runs = loadDir(dirs[0], null, book).sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, runsCsv(runs, batchName(file)));
  console.log(`${runs.length} runs → ${file}`);
}

function main() {
  const { values: args } = parseArgs({ options: {
    runs: { type: 'string', default: join(HERE, 'results', 'runs', 'v4-D.csv') },
    model: { type: 'string', default: 'sonnet' },
    arms: { type: 'string', default: 'before,after' },
    'skip-wall': { type: 'boolean', default: false },
    summary: { type: 'string' },
    'export-csv': { type: 'string' },  // write one --runs directory's runs, every model, as results/runs/<name>.csv
    set: { type: 'string', default: 'loc,edit,edit2,long' },
    'holm-cost': { type: 'boolean', default: false },  // batch F on: steps and cost co-primaries on tuned localization, Holm-adjusted
    descriptive: { type: 'boolean', default: false },  // an unregistered comparison (Fv2's AFTER-E): no verdicts, no PASS/FAIL
    'strict-rubrics': { type: 'string' },  // --saver, POST-HOC: also rescore report answers, blind to arm, with these rubrics
    'no-effect': { type: 'boolean', default: false },  // --saver, POST-HOC: each gate's pass rate resampling the first arm against itself
    saver: { type: 'boolean', default: false },  // token saver batches: arms NONE and CHOSEN
    reuse: { type: 'boolean', default: false },  // batch R1: descriptive tables by task position and arm
  } });
  if (args.saver) return saverMain(args.runs.split(','), args);
  for (const line of analysisCheck(args.runs.split(',').map(batchName), readRegistrations())) console.log(line);
  if (args.reuse) {
    const report = reuseReport(loadRuns(args.runs.split(','), args.model));
    console.log(JSON.stringify(report, null, 1));
    if (args.summary) writeFileSync(args.summary, `${assertSanitized(JSON.stringify(report, null, 1))}\n`);
    return;
  }
  const dirs = args.runs.split(',');
  const book = goldBook();
  if (args['export-csv']) return exportCsv(dirs, args['export-csv'], book);
  const { out, summary } = armReport(dirs, args, book);
  console.log(out.join('\n'));
  if (args.summary) {
    mkdirSync(dirname(args.summary), { recursive: true });
    writeFileSync(args.summary, `${assertSanitized(JSON.stringify(summary, null, 1))}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
