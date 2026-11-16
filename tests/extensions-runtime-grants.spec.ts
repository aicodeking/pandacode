import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const json = (path: string) => JSON.parse(read(path));
const corpus = json('tests/fixtures/extensions/examples-v1.json') as { permissions: string[] };
const scenario = json('tests/fixtures/extensions/runtime-grants/scenario.json') as { package: { id: string; version: string; permissions: string[] }; steps: Record<string, unknown>[] };
const layout = json('tests/fixtures/extensions/layout-a/extension.json');
const quoted = (text: string) => [...text.matchAll(/'([a-z][A-Za-z.]+)'/g)].map(match => match[1]);
const section = (text: string, name: string) => text.split(`<!-- ${name}:start -->`)[1].split(`<!-- ${name}:end -->`)[0];

async function boot(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
  }, packages);
  await page.goto('/?runtime-grants'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionRuntimeGrants);
}

test('extensions runtime grants: schema, SDK, native, README, guide and examples agree on the fifty names', () => {
  expect(corpus.permissions).toHaveLength(50);
  expect(new Set(corpus.permissions).size).toBe(50);
  expect(corpus.permissions).toContain('projects.checks.run');
  expect(corpus.permissions).toContain('ui.customize');
  const ts = read('src/extensions/contracts.ts').match(/const capabilities = \[([^\]]*)\]/)![1];
  expect(quoted(ts)).toEqual(corpus.permissions);
  const native = read('src-tauri/src/extensions/runtime_grants.rs').match(/pub const PERMISSIONS: \[&str; 50\] = \[([^\]]*)\]/)![1];
  expect([...native.matchAll(/"([a-z][A-Za-z.]+)"/g)].map(match => match[1])).toEqual(corpus.permissions);
  const sdk = read('src/extensions/sdk/index.d.ts').match(/export type ManifestPermission = ([^;]*);/)![1];
  expect(quoted(sdk)).toEqual(corpus.permissions);
  const table = [...section(read('docs/extensions/README.md'), 'permissions').matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  expect([...table].sort()).toEqual([...corpus.permissions].sort());
  const sentence = read('docs/extensions/contracts.md').match(/`permissions` and `requiredCapabilities` contain only the fifty recognized names[^\n]*/)![0];
  expect([...sentence.matchAll(/\*\*`([^`]+)`\*\*/g)].map(match => match[1])).toEqual(corpus.permissions);
  // The native validator reads the one native list; no copy of the old nineteen remains.
  expect(read('src-tauri/src/extensions/contracts.rs')).toContain('super::runtime_grants::PERMISSIONS.contains');
  expect(read('src-tauri/src/extensions/contracts.rs')).not.toContain('"tasks.tools.read"].contains');
  // ADR-0006: no permission lets a package read a credential value.
  for (const path of ['src/extensions/contracts.ts', 'src/extensions/sdk/index.d.ts', 'tests/fixtures/extensions/examples-v1.json', 'src/extensions/schema-v1.json']) {
    expect(read(path).replaceAll(/There is no `credentials\.read`[^\n]*/g, '').replaceAll(/\/\/[^\n]*/g, '').replaceAll(/\/\*\*[^]*?\*\//g, '')).not.toMatch(/credentials\.read/);
  }
  expect(corpus.permissions).not.toContain('credentials.read');
});

test('extensions runtime grants: the validator accepts every decided name and still refuses an unknown one', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async ({ names, base }) => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    const make = (permissions: string[], extra: Record<string, unknown> = {}) => ({ ...base, ...extra, permissions });
    return {
      all: validateContract('packages', [make(names, { contributes: {} })]).ok,
      checks: validateContract('packages', [make(['projects.checks.run'], { contributes: {} })]).ok,
      unknown: validateContract('packages', [make(['credentials.read'], { contributes: {} })]),
      required: validateContract('packages', [{ ...make(['ui.contribute'], { contributes: {} }), requiredCapabilities: ['credentials.read'] }]),
    };
  }, { names: corpus.permissions, base: { manifestVersion: 1, id: 'sample.grants-laboratory', version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui' } });
  expect(result.all).toBe(true); expect(result.checks).toBe(true);
  for (const refused of [result.unknown, result.required]) { expect(refused.ok).toBe(false); expect(refused.error.code).toBe('UnsupportedCapability'); }
});

test('extensions runtime grants: the two-project scenario holds in the preview store, across a restart and after revoke', async ({ page }) => {
  await boot(page);
  const failures = await page.evaluate(async scenario => {
    const { createRuntimeGrantsPreview } = (window as any).__extensionRuntimeGrants;
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
    let grants = createRuntimeGrantsPreview(storage);
    const { id, version, permissions } = scenario.package;
    grants.register(id, version, permissions, 'fixture-digest'); grants.trust(id, true);
    const failures: string[] = [];
    for (const step of scenario.steps) {
      const target = { project: step.project, toolKind: step.toolKind, item: step.item };
      if (step.op === 'grant' || step.op === 'narrow') grants.change({ op: step.op, id, permission: step.permission, scope: step.scope });
      else if (step.op === 'revoke') grants.change({ op: 'revoke', id, permission: step.permission });
      else if (step.op === 'restart') grants = createRuntimeGrantsPreview(storage);
      else if (step.op === 'check') { const got = grants.check(id, version, step.permission, target); if (got !== step.expect) failures.push(`${JSON.stringify(step)} -> ${got}`); }
      else failures.push(`unknown step ${step.op}`);
    }
    return failures;
  }, scenario);
  expect(failures).toEqual([]);
});

test('extensions runtime grants: narrowing never widens, an undeclared name cannot be granted, update and untrust follow the native rules', async ({ page }) => {
  await boot(page);
  const outcome = await page.evaluate(async () => {
    const { createRuntimeGrantsPreview } = (window as any).__extensionRuntimeGrants;
    const memory = new Map<string, string>();
    const grants = createRuntimeGrantsPreview({ getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } });
    const code = (action: () => void) => { try { action(); return 'ok'; } catch (error) { return (error as Error).message; } };
    const id = 'sample.grants-laboratory';
    grants.register(id, '1.0.0', ['tasks.start', 'ui.customize', 'credentials.use'], 'digest-a'); grants.trust(id, true);
    grants.change({ op: 'grant', id, permission: 'tasks.start', scope: { projects: ['A'] } });
    grants.change({ op: 'grant', id, permission: 'ui.customize' });
    const result = {
      widen: code(() => grants.change({ op: 'narrow', id, permission: 'tasks.start', scope: { projects: ['A', 'B'] } })),
      all: code(() => grants.change({ op: 'narrow', id, permission: 'tasks.start' })),
      scope: code(() => grants.change({ op: 'grant', id, permission: 'ui.customize', scope: { projects: ['A'] } })),
      undeclared: code(() => grants.change({ op: 'grant', id, permission: 'tasks.control' })),
      unknown: code(() => grants.change({ op: 'grant', id, permission: 'credentials.read' })),
      before: grants.check(id, '1.0.0', 'tasks.start', { project: 'B' }),
    };
    grants.register(id, '1.1.0', ['tasks.start', 'ui.customize'], 'digest-a');
    const updated = { oldVersion: grants.check(id, '1.0.0', 'ui.customize'), kept: grants.check(id, '1.1.0', 'tasks.start', { project: 'A' }), dropped: grants.projection().packages[0].declared.includes('credentials.use') };
    grants.register(id, '1.2.0', ['tasks.start', 'ui.customize'], 'digest-b');
    const changed = { untrusted: grants.check(id, '1.2.0', 'ui.customize'), projection: grants.projection().packages[0].uiCustomize };
    grants.trust(id, true); const retrusted = grants.check(id, '1.2.0', 'ui.customize');
    grants.archive(id, true); const archived = { check: grants.check(id, '1.2.0', 'ui.customize'), projection: grants.projection().packages[0].uiCustomize };
    return { result, updated, changed, retrusted, archived };
  });
  expect(outcome.result).toEqual({ widen: 'InvalidArguments', all: 'InvalidArguments', scope: 'InvalidArguments', undeclared: 'PermissionDenied', unknown: 'UnsupportedCapability', before: 'PermissionDenied' });
  expect(outcome.updated).toEqual({ oldVersion: 'PermissionDenied', kept: 'ok', dropped: false });
  expect(outcome.changed).toEqual({ untrusted: 'PermissionDenied', projection: false });
  expect(outcome.retrusted).toBe('ok');
  expect(outcome.archived).toEqual({ check: 'PermissionDenied', projection: false });
});

test('extensions runtime grants: the ui.customize grant reaches the webview through the bridge and survives a reload', async ({ page }) => {
  await boot(page, [{ manifest: layout, enabled: true, icons: {} }]);
  const read = () => page.evaluate(async id => {
    const { loadRuntimeGrants, uiCustomizeGranted } = (window as any).__extensionRuntimeGrants;
    const projection = await loadRuntimeGrants();
    return { available: projection.available, declared: projection.packages.find((item: { id: string }) => item.id === id)?.declared ?? null, granted: uiCustomizeGranted(projection, id) };
  }, layout.id);
  const before = await read();
  expect(before.available).toBe(true); expect(before.declared).toContain('ui.customize'); expect(before.granted).toBe(false);
  const changed = await page.evaluate(async id => {
    const { changeRuntimeGrant, uiCustomizeGranted } = (window as any).__extensionRuntimeGrants;
    const granted = await changeRuntimeGrant({ op: 'grant', id, permission: 'ui.customize' });
    let refused = '';
    try { await changeRuntimeGrant({ op: 'grant', id, permission: 'tasks.control' }); } catch (error) { refused = (error as Error).message; }
    return { granted: uiCustomizeGranted(granted, id), refused };
  }, layout.id);
  expect(changed.granted).toBe(true); expect(changed.refused).toContain('PermissionDenied');
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  expect((await read()).granted).toBe(true);
  await page.evaluate(async id => { const { changeRuntimeGrant } = (window as any).__extensionRuntimeGrants; await changeRuntimeGrant({ op: 'revoke', id, permission: 'ui.customize' }); }, layout.id);
  expect((await read()).granted).toBe(false);
});

test('extensions runtime grants: a damaged projection is reported unavailable, never partly trusted', async ({ page }) => {
  await boot(page);
  const parsed = await page.evaluate(async () => {
    const { parseGrants } = (window as any).__extensionRuntimeGrants;
    const good = { schemaVersion: 1, available: true, revision: 3, vocabulary: ['ui.customize'], packages: [{ id: 'a.b', version: '1.0.0', declared: ['ui.customize'], archived: false, authorized: true, trusted: true, grants: [{ permission: 'ui.customize', scope: {} }], uiCustomize: true }] };
    const bad = (change: (value: any) => void) => { const copy = structuredClone(good); change(copy); return parseGrants(copy).available; };
    return {
      good: parseGrants(good).packages.length, version: bad(value => { value.schemaVersion = 2; }), name: bad(value => { value.packages[0].grants[0].permission = 'credentials.read'; }),
      scope: bad(value => { value.packages[0].grants[0].scope = { secret: ['x'] }; }), flag: bad(value => { delete value.packages[0].uiCustomize; }), none: parseGrants(null).available,
    };
  });
  expect(parsed).toEqual({ good: 1, version: false, name: false, scope: false, flag: false, none: false });
});
