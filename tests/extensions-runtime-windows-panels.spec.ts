import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { validateContract } from '../src/extensions/contracts';
import { originKey as twinOriginKey } from '../src/extensions/runtime-rich-assets.ts';
// @ts-ignore plain ES modules of the fixture
import { stagePackages, readZip, packageFiles, PACKAGES, PLACEHOLDERS } from './fixtures/extensions/runtime-windows-panels/stage.mjs';
// @ts-ignore
import { evaluate, invalidity, platformScenario, at, holds } from './fixtures/extensions/runtime-windows-panels/evaluate.mjs';
// @ts-ignore
import { originKey, agentPrompt } from './fixtures/extensions/runtime-windows-panels/scenarios.mjs';
// @ts-ignore
import { parseArguments } from './fixtures/extensions/runtime-windows-panels/qualify.mjs';

// R0306: the installed Windows qualification of rich panels (canvas streaming, remote page, action response,
// per-package storage, state across placements, focus between webviews, a faulting panel beside a running fake-agent
// task, and disable/revoke/safe mode). The installed run is `qualify.mjs` (docs/extensions/runtime-windows-panels.md):
// it builds and installs the exact tree and records `observation.json`. This spec checks the harness offline (the
// staged packages, the archive writer, the expected-observation table and its evaluator) and, when
// PANDACODE_WINDOWS_PANELS_RECORD names a recorded observation, that record. No test here launches the app, and no
// offline test stands for installed evidence: a synthetic or preview record is `invalid` by construction.
const fixture = new URL('./fixtures/extensions/runtime-windows-panels/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', fixture), 'utf8'));
const synthetic = JSON.parse(readFileSync(new URL('records/synthetic-passing.json', fixture), 'utf8'));
const values = { b1: '127.0.0.1:40123', serviceLog: 'C:\\qualification\\run\\service.json', fakeAgent: 'C:\\repo\\tests\\fixtures\\extensions\\backends\\fake-agent.mjs', agentLog: 'C:\\qualification\\run\\agent-frames.jsonl' };
const installed = (record: any) => ({ ...structuredClone(record), evidence: 'installed' });

test('extensions windows panels: the fixture packages validate and stage into archives the installer reads', () => {
  const staged = stagePackages(values);
  expect(staged.map((item: any) => item.id)).toEqual(['sample.windows-panels', 'sample.windows-panels-twin', 'sample.windows-panels-agent', 'sample.rich-mount', 'sample.band-rich']);
  for (const item of staged) {
    const result = validateContract('packages', [item.manifest]);
    expect(result.ok, `${item.id}: ${JSON.stringify(result)}`).toBe(true);
    const entries = readZip(item.bytes);
    expect(entries.map((entry: any) => entry.name).sort()).toEqual([...packageFiles(PACKAGES.find((definition: any) => definition.id === item.id)).keys()].sort());
    for (const entry of entries) {
      expect(crc32(entry.data), entry.name).toBe(entry.crc);
      // MS-DOS host, no attributes: the native validator reads no Unix mode and sees plain files.
      expect(entry.madeBy).toBe(20); expect(entry.external).toBe(0);
      expect(entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')).toBe(false);
      for (const placeholder of Object.values(PLACEHOLDERS)) expect(entry.data.toString('utf8').includes(placeholder as string), `${entry.name} ${placeholder}`).toBe(false);
    }
  }
  // Windows paths survive JSON and JavaScript strings.
  const agent = staged.find((item: any) => item.id === 'sample.windows-panels-agent').manifest.contributes.providers[0].launch;
  expect(agent.command).toEqual(['{node}', values.fakeAgent]);
  expect(agent.env.FAKE_AGENT_LOG).toBe(values.agentLog);
  const service = readZip(staged[0].bytes).find((entry: any) => entry.name === 'main.cjs').data.toString('utf8');
  expect(service).toContain(`const B1 = '${values.b1}';`);
  expect(service).toContain(`const LOG = '${values.serviceLog.replaceAll('\\', '\\\\')}';`);
  expect(() => stagePackages({ ...values, serviceLog: "C:\\it's" })).toThrow(/Unusable staging value/);
  // The twin's panel-only package has no runtime; the board's service and panels share one package origin.
  expect(staged[1].manifest.runtime).toBeUndefined();
  expect(staged[0].manifest.contributes.views.map((view: any) => view.rich.placement)).toEqual(['inspector', 'inspector']);
});

test('extensions windows panels: origin keys match the native rule, and the agent prompt is one finite script', async () => {
  for (const id of ['sample.windows-panels', 'sample.windows-panels-twin', 'sample.rich-mount']) expect(originKey(id)).toBe(await twinOriginKey(id));
  expect(originKey('sample.windows-panels')).not.toBe(originKey('sample.windows-panels-twin'));
  const prompt = agentPrompt(12);
  expect(prompt.startsWith('#script ')).toBe(true);
  const steps = JSON.parse(prompt.slice('#script '.length));
  expect(steps).toHaveLength(24);
  expect(steps.filter((step: any) => 'sleep' in step).reduce((sum: number, step: any) => sum + step.sleep, 0)).toBe(12_000);
});

test('extensions windows panels: the expected table covers every installed criterion and the synthetic record shows its shape', () => {
  expect(Object.keys(expected.criteria)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
  const ids = expected.checks.map((check: any) => check.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const criterion of ['C2', 'C3', 'C4', 'C5']) expect(expected.checks.some((check: any) => check.criterion === criterion), criterion).toBe(true);
  // C1 is the refusal reconciliation in the sources: no installed observation stands for it.
  expect(expected.checks.some((check: any) => check.criterion === 'C1')).toBe(false);
  for (const check of expected.checks) {
    expect(check.why.length, check.id).toBeGreaterThan(10);
    expect(holds(check, at(synthetic, check.path)), `${check.id} on the synthetic record`).toBe(true);
  }
  // The synthetic record never counts; relabelled in memory it passes every check.
  const asIs = evaluate(synthetic, expected);
  expect(asIs.verdict).toBe('invalid');
  expect(asIs.reason).toMatch(/synthetic, not installed/);
  expect(asIs.criteria).toMatchObject({ C1: 'not-observed', C2: 'invalid', C3: 'invalid', C4: 'invalid', C5: 'invalid' });
  const relabelled = evaluate(installed(synthetic), expected);
  expect(relabelled).toMatchObject({ verdict: 'passed', reason: null, criteria: { C1: 'not-observed', C2: 'passed', C3: 'passed', C4: 'passed', C5: 'passed' } });
  expect(platformScenario(relabelled)).toEqual({ id: 'rich-panel', outcome: 'passed' });
});

test('extensions windows panels: every check fails when its observation is missing or changed', () => {
  // Without these the record is not identified installed Windows evidence at all.
  const identifying = new Set(['identity.candidateCommit', 'identity.sourceFingerprint', 'engines.os.platform']);
  for (const check of expected.checks) {
    const record = installed(synthetic);
    const keys = check.path.split('.'); const last = keys.pop();
    const parent = keys.reduce((value: any, key: string) => value[key], record);
    delete parent[last];
    const missing = evaluate(record, expected);
    expect(missing.verdict, check.id).toBe(identifying.has(check.path) ? 'invalid' : 'failed');
    expect(missing.checks.find((entry: any) => entry.id === check.id)).toMatchObject({ pass: false, missing: true });
    expect(missing.criteria[check.criterion]).toBe(identifying.has(check.path) ? 'invalid' : 'failed');
    expect(platformScenario(missing)).toMatchObject({ id: 'rich-panel', outcome: 'failed' });
  }
  const changed = installed(synthetic);
  changed.scenarios.fault.agentCancel = 1; changed.scenarios.focus.trace[2].main = false; changed.scenarios.storage.twin.local = 'qualification-note';
  expect(evaluate(changed, expected).reason).toBe('failing checks: storage.twin, focus.trace, fault.no-cancel');
});

test('extensions windows panels: preview, browser, other-target and unidentified records never count as installed', () => {
  const variants: [string, (record: any) => void, RegExp][] = [
    ['preview', record => { record.evidence = 'preview'; }, /preview, not installed/],
    ['browser', record => { record.evidence = 'browser'; }, /browser, not installed/],
    ['unlabelled', record => { delete record.evidence; }, /unlabelled/],
    ['linux', record => { record.target = 'linux-x64'; }, /linux-x64, not windows-x64/],
    ['macos host', record => { record.engines.os.platform = 'darwin'; }, /not Windows/],
    ['no commit', record => { record.identity.candidateCommit = null; }, /build identity/],
    ['other kind', record => { record.kind = 'runtime-platform-qualification-result'; }, /record kind/],
  ];
  for (const [name, mutate, reason] of variants) {
    const record = installed(synthetic); mutate(record);
    const result = evaluate(record, expected);
    expect(result.verdict, name).toBe('invalid');
    expect(result.reason, name).toMatch(reason);
    expect(platformScenario(result).outcome, name).toBe('failed');
  }
  expect(invalidity(null)).toBe('no record');
});

test('extensions windows panels: the runner takes one explicit build or installer and is registered in both engines and CI', () => {
  expect(() => parseArguments([])).toThrow(/--build/);
  expect(() => parseArguments(['--installer'])).toThrow(/takes a value/);
  expect(parseArguments(['--installer', 'setup.exe', '--keep-install'])).toMatchObject({ build: false, keepInstall: true });
  expect(() => parseArguments(['--build', '--port', '80'])).toThrow(/1024/);
  expect(() => parseArguments(['--build', '--quiet'])).toThrow(/Unknown argument/);
  expect(parseArguments(['--build'])).toMatchObject({ build: true, keepInstall: false });
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toContain('extensions-runtime-windows-panels.spec.ts');
  expect(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8')).toContain('extensions windows panels:');
});

// The installed column: the record `qualify.mjs` wrote. Skipped unless the final test phase points at one.
test('extensions windows panels: the recorded installed observation passes every expected check', () => {
  const path = process.env.PANDACODE_WINDOWS_PANELS_RECORD;
  test.skip(!path, 'Set PANDACODE_WINDOWS_PANELS_RECORD to the observation.json of an installed run (qualify.mjs).');
  const record = JSON.parse(readFileSync(path!, 'utf8'));
  const result = evaluate(record, expected);
  expect(result.checks.filter((check: any) => !check.pass).map((check: any) => `${check.id}: ${JSON.stringify(check.actual)}`)).toEqual([]);
  expect(result.verdict, result.reason ?? '').toBe('passed');
});
