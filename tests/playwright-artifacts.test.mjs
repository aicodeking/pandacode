import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactPaths, reportDirectory, acquireBrowserRun, productionFingerprint, ensureProductionBuild } from '../scripts/playwright-artifacts.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pandacode-browser-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 1;');
  writeFileSync(join(root, 'index.html'), '<main>main</main>');
  writeFileSync(join(root, 'agents-dock.html'), '<main>dock</main>');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return root;
}

test('ports do not create distinct production builds or historical report directories', () => {
  const paths = artifactPaths('/project');
  assert.match(paths.production.replaceAll('\\', '/'), /pandacode-browser-tests\/production$/);
  assert.match(paths.reports.replaceAll('\\', '/'), /playwright-report\/latest\/chromium$/);
  assert.match(artifactPaths('/project', 'webkit').reports.replaceAll('\\', '/'), /latest\/webkit$/);
  const config = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /pandacode-perf-\$|playwright-report\/port-/);
  assert.match(config, /acquireBrowserRun\(\)/);
});

test('test discovery does not create a lease or artifact folder', t => {
  const root = fixture(t);
  acquireBrowserRun({ root, argv: ['node', 'playwright', '--list'] })();
  assert.equal(existsSync(artifactPaths(root).cache), false);
});

test('explicit evidence folders cannot point Playwright cleanup at product or old reports', t => {
  const root = fixture(t);
  for (const value of ['src', 'playwright-report', 'playwright-report/archive', 'playwright-report/port-15480', '../outside', tmpdir()]) {
    assert.throws(() => reportDirectory(root, 'chromium', value), /PW_REPORT_DIR/);
  }
  const archive = 'playwright-report/archive/issue-one';
  assert.equal(reportDirectory(root, 'chromium', archive), join(root, archive, 'chromium'));
  assert.equal(reportDirectory(root, 'webkit', archive), join(root, archive, 'webkit'));
});

test('another process cannot acquire the checkout before output cleanup', t => {
  const root = fixture(t);
  const release = acquireBrowserRun({ root, installExitHandler: false });
  t.after(release);
  const module = new URL('../scripts/playwright-artifacts.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireBrowserRun } from ${JSON.stringify(module)}; acquireBrowserRun({root:${JSON.stringify(root)}});`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another browser suite is running/);
  assert.equal(JSON.parse(readFileSync(artifactPaths(root).lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(artifactPaths(root).lock), false);
});

test('a child preview can inherit the owning runner lease, but cannot release it', t => {
  const root = fixture(t);
  const release = acquireBrowserRun({ root, installExitHandler: false });
  t.after(release);
  const module = new URL('../scripts/playwright-artifacts.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireBrowserRun } from ${JSON.stringify(module)}; acquireBrowserRun({root:${JSON.stringify(root)},allowInherited:true})();`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(artifactPaths(root).lock), true);
  assert.deepEqual(JSON.parse(readFileSync(artifactPaths(root).lock, 'utf8')).children, []);
});

test('the real Playwright runner refuses overlap before it clears existing evidence', t => {
  const root = fixture(t);
  const release = acquireBrowserRun({ root, installExitHandler: false });
  t.after(release);
  const reports = join(root, 'results');
  mkdirSync(reports);
  const sentinel = join(reports, 'existing-evidence.txt');
  writeFileSync(sentinel, 'must survive a refused concurrent run');
  const module = new URL('../scripts/playwright-artifacts.mjs', import.meta.url).href;
  const config = join(root, 'playwright.config.mjs');
  writeFileSync(config, `import { acquireBrowserRun } from ${JSON.stringify(module)}; acquireBrowserRun({root:${JSON.stringify(root)}}); export default {testDir:${JSON.stringify(root)},outputDir:${JSON.stringify(reports)}};`);
  const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'test', '--config', config], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another browser suite is running/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'must survive a refused concurrent run');
});

test('unknown lease files are preserved rather than automatically deleted', t => {
  const root = fixture(t);
  const paths = artifactPaths(root);
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(paths.lock, '{"owner":"unknown"}');
  assert.throws(() => acquireBrowserRun({ root, installExitHandler: false }), /Unrecognized browser-test lease/);
  assert.equal(readFileSync(paths.lock, 'utf8'), '{"owner":"unknown"}');
});

test('an exited recognized lease owner is reclaimed without spending a test attempt', t => {
  const root = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  const paths = artifactPaths(root);
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({ schema: 1, root, pid: exited.pid, id: 'old-test-owner' }));
  const release = acquireBrowserRun({ root, installExitHandler: false });
  t.after(release);
  assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, process.pid);
  assert.equal(existsSync(`${paths.lock}.reclaim`), false);
});

test('a surviving preview protects the build after its original runner exits', t => {
  const root = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  const paths = artifactPaths(root);
  mkdirSync(paths.cache, { recursive: true });
  const lease = { schema: 1, root, pid: exited.pid, id: 'orphan-preview', children: [process.pid] };
  writeFileSync(paths.lock, JSON.stringify(lease));
  assert.throws(() => acquireBrowserRun({ root, installExitHandler: false }), /Another browser suite is running/);
  assert.deepEqual(JSON.parse(readFileSync(paths.lock, 'utf8')), lease);
});

test('unchanged production inputs are reused across engines, ports and baseline labels', async t => {
  const root = fixture(t);
  let builds = 0;
  const build = async out => {
    builds++;
    mkdirSync(out, { recursive: true });
    for (const name of ['index.html', 'agents-dock.html']) writeFileSync(join(out, name), '<main>compiled</main>');
  };
  assert.equal((await ensureProductionBuild({ root, build, environment: { PW_PORT: '1', BASELINE_REVISION: 'a' } })).reused, false);
  assert.equal((await ensureProductionBuild({ root, build, environment: { PW_PORT: '2', BASELINE_REVISION: 'b' } })).reused, true);
  assert.equal(builds, 1);
  writeFileSync(join(root, 'src', 'entry.ts'), 'export const value = 2;');
  assert.equal((await ensureProductionBuild({ root, build, environment: {} })).reused, false);
  assert.equal(builds, 2);
});

test('build-affecting inputs invalidate the cache, but reports do not', t => {
  const root = fixture(t);
  const original = productionFingerprint(root, {});
  assert.equal(productionFingerprint(root, { NODE_ENV: 'production' }), original);
  mkdirSync(join(root, 'playwright-report'));
  writeFileSync(join(root, 'playwright-report', 'trace.json'), '{}');
  assert.equal(productionFingerprint(root, {}), original);
  assert.notEqual(productionFingerprint(root, { VITE_TEST_MODE: 'changed' }), original);
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":2}');
  assert.notEqual(productionFingerprint(root, {}), original);
});

test('failed and source-mutating builds are never marked reusable', async t => {
  const root = fixture(t);
  await assert.rejects(ensureProductionBuild({ root, environment: {}, build: async () => { throw new Error('build failed'); } }), /build failed/);
  assert.equal(JSON.parse(readFileSync(artifactPaths(root).manifest, 'utf8')).ready, false);
  await assert.rejects(ensureProductionBuild({ root, environment: {}, build: async out => {
    mkdirSync(out, { recursive: true });
    for (const name of ['index.html', 'agents-dock.html']) writeFileSync(join(out, name), 'compiled');
    writeFileSync(join(root, 'src', 'entry.ts'), 'changed while building');
  } }), /Build inputs changed/);
  assert.equal(JSON.parse(readFileSync(artifactPaths(root).manifest, 'utf8')).ready, false);
});

test('missing emitted chunks invalidate an otherwise unchanged build', async t => {
  const root = fixture(t);
  let builds = 0;
  const build = async out => {
    builds++;
    mkdirSync(out, { recursive: true });
    for (const name of ['index.html', 'agents-dock.html', 'chunk.js']) writeFileSync(join(out, name), 'compiled');
  };
  await ensureProductionBuild({ root, build, environment: {} });
  rmSync(join(artifactPaths(root).production, 'chunk.js'));
  assert.equal((await ensureProductionBuild({ root, build, environment: {} })).reused, false);
  assert.equal(builds, 2);
});
