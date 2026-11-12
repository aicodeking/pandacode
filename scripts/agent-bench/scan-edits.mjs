#!/usr/bin/env node
// Finds edit-task candidates: `node scan-edits.mjs <commit...>`. No model time. A candidate is useful
// when its tests build at the parent and fail on an assertion, because then no symbol is handed over.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { REPO, WORK_ROOT, applyFix, materialize, must, overlayTests, runCommand, stopChildrenOnSignal } from './lib.mjs';

const OUT = process.env.BENCH_OUT ?? join(homedir(), 'Library/Caches/pandacode-bench');
const TARGET = join(OUT, 'targets', 'shared');
const REPORT = join(OUT, 'edit-scan.json');
stopChildrenOnSignal();

const moduleOf = path => path.replace('src-tauri/src/', '').replace(/\.rs$/, '').replace(/\/(mod)$/, '').replaceAll('/', '::');
/** Overlay and test command derived from which test code the commit changed. */
async function planFor(commit) {
  const files = (await must('git', ['-C', REPO, 'diff', '--name-only', `${commit}^`, commit])).trim().split('\n');
  const overlay = [];
  const modules = new Set();
  const node = [];
  for (const path of files) {
    if (/\.test\.mjs$/.test(path)) { overlay.push({ path, mode: 'file' }); node.push(path); continue; }
    if (!path.startsWith('src-tauri/src/') || !path.endsWith('.rs')) continue;
    if (/(^|\/)(tests|[a-z_]+_tests)\.rs$/.test(path)) { overlay.push({ path, mode: 'file' }); modules.add(moduleOf(path)); continue; }
    const diff = await must('git', ['-C', REPO, 'show', '--format=', commit, '--', path]);
    if (/^\+\s*#\[(tokio::)?test/m.test(diff) || /^@@.*mod tests/m.test(diff)) { overlay.push({ path, mode: 'rust-tests' }); modules.add(moduleOf(path)); }
  }
  if (node.length) return { overlay, test: { cwd: '.', command: ['node', '--test', ...node] } };
  if (modules.size === 1) return { overlay, test: { cwd: 'src-tauri', command: ['cargo', 'test', '--lib', `${[...modules][0]}::`] } };
  if (modules.size > 1) return { overlay, test: { cwd: 'src-tauri', command: ['cargo', 'test', '--lib', [...modules].sort((a, b) => a.length - b.length)[0].split('::')[0]] } };
  return null;
}

const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {};
for (const commit of process.argv.slice(2)) {
  if (report[commit]) continue;
  const dir = join(WORK_ROOT, 'scan', 'current');
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dir, { recursive: true });
  try {
    const plan = await planFor(commit);
    if (!plan) { report[commit] = { verdict: 'no tests' }; continue; }
    const parent = (await must('git', ['-C', REPO, 'rev-parse', `${commit}^`])).trim();
    await materialize(REPO, parent, dir, { nodeModules: true });
    const task = { commit, ...plan };
    const target = plan.test.command[0] === 'cargo' ? TARGET : null;
    await overlayTests(task, dir);
    const parentRun = await runCommand(plan.test, dir, target, 15 * 60_000);
    await applyFix(task, parent, dir);
    const fixRun = await runCommand(plan.test, dir, target, 15 * 60_000);
    report[commit] = {
      ...plan,
      subject: (await must('git', ['-C', REPO, 'log', '-1', '--format=%s', commit])).trim(),
      parent: parentRun.kind, parentFailed: parentRun.failed, fix: fixRun.kind, fixFailed: fixRun.failed,
      parentTail: parentRun.kind === 'build' ? parentRun.tail.split('\n').filter(line => /^error|does not provide|Cannot find/.test(line)).slice(0, 4) : [],
      ms: [parentRun.ms, fixRun.ms],
    };
  } catch (error) {
    report[commit] = { verdict: 'error', error: String(error).slice(0, 300) };
  } finally {
    writeFileSync(REPORT, JSON.stringify(report, null, 1));
  }
  console.log(commit, report[commit].parent, report[commit].fix, (report[commit].parentFailed ?? []).length, report[commit].subject ?? report[commit].verdict);
}
rmSync(join(WORK_ROOT, 'scan', 'current'), { recursive: true, force: true, maxRetries: 3 });
