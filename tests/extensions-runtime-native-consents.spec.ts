import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const scenario = JSON.parse(read('tests/fixtures/extensions/runtime-native-consents/scenario.json')) as {
  kinds: { family: string; permission: string }[]; packages: Record<string, any>[]; legacy: Record<string, unknown>[];
  expect: { granted: string[]; neverGranted: string[]; projectsSummaryProjects: string[] };
};

async function boot(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); });
  await page.goto('/?native-consents'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionNativeConsents);
}

test('extensions native consents: the Rust module, fixture and TypeScript mirror list the same twelve families', () => {
  const native = read('src-tauri/src/extensions/runtime_native_consents.rs').match(/LEGACY_PERMISSIONS: \[&str; 12\] = \[([^\]]*)\]/)![1];
  const names = [...native.matchAll(/"([a-z][A-Za-z.]+)"/g)].map(match => match[1]);
  const ts = read('src/extensions/runtime-native-consents.ts').match(/LEGACY_PERMISSIONS = \[([^\]]*)\]/)![1];
  expect([...ts.matchAll(/'([a-z][A-Za-z.]+)'/g)].map(match => match[1])).toEqual(names);
  expect(scenario.kinds.map(kind => kind.permission)).toEqual(names);
  expect(new Set(scenario.kinds.map(kind => kind.family))).toEqual(new Set(['context', 'files', 'git', 'jobs', 'connections', 'services', 'storage']));
  expect(names).not.toContain('credentials.read');
});

test('extensions native consents: persisted storage consent survives restart and upgrade; denied and missing never become grants', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async scenario => {
    const { createNativeConsentsPreview, createRuntimeGrantsPreview } = (window as any).__extensionNativeConsents;
    const make = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
    const store = make(), marks = make();
    const open = () => { const grants = createRuntimeGrantsPreview(store); return { grants, migrator: createNativeConsentsPreview(grants, marks) }; };
    const snapshot = { safeMode: false, packages: scenario.packages };
    const version = (id: string) => scenario.packages.find((item: any) => item.manifest.id === id).manifest.version;
    let { grants, migrator } = open();
    const first = migrator.migrate(snapshot, scenario.legacy);
    ({ grants, migrator } = open()); // restart
    const held = (pair: string, project?: string) => { const [id, permission] = pair.split('/'); return grants.check(id, version(id), permission, { project }); };
    const granted = scenario.expect.granted.map((pair: string) => [pair, held(pair, 'project-a')]);
    const never = scenario.expect.neverGranted.map((pair: string) => [pair, held(pair, 'project-a'), held(pair)]);
    const summary = grants.projection().packages.find((item: any) => item.id === 'sample.consent-granted').grants.find((grant: any) => grant.permission === 'projects.summary').scope;
    const outside = held('sample.consent-granted/projects.summary', 'project-c');
    const second = migrator.migrate(snapshot, scenario.legacy);
    const before = JSON.stringify(grants.projection());
    migrator.migrate(snapshot, scenario.legacy);
    const stable = before === JSON.stringify(grants.projection());
    grants.change({ op: 'revoke', id: 'sample.consent-granted', permission: 'storage.private' });
    ({ grants, migrator } = open());
    migrator.migrate(snapshot, scenario.legacy);
    const revoked = grants.check('sample.consent-granted', '1.0.0', 'storage.private', {});
    let bad = 'none'; try { migrator.migrate(snapshot, [{ id: 'sample.consent-granted', permission: 'credentials.read', allow: true }]); } catch (error) { bad = (error as Error).message; }
    return { first: first.adopted.length, second: second.adopted.length, granted, never, summary, outside, stable, revoked, bad };
  }, scenario);
  expect(out.first).toBeGreaterThan(0);
  expect(out.second).toBe(0);
  expect(out.granted.every(([, result]: [string, string]) => result === 'ok')).toBe(true);
  expect(out.never.every(([, a, b]: [string, string, string]) => a === 'PermissionDenied' && b === 'PermissionDenied')).toBe(true);
  expect(out.summary).toEqual({ projects: scenario.expect.projectsSummaryProjects });
  expect(out.outside).toBe('PermissionDenied');
  expect(out.stable).toBe(true);
  expect(out.revoked).toBe('PermissionDenied');
  expect(out.bad).toContain('UnsupportedCapability');
});

test('extensions native consents: every legacy family prompts without a grant, proceeds with one and prompts again after revocation', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(async scenario => {
    const { createRuntimeGrantsPreview, gate, allows, LEGACY_PERMISSIONS } = (window as any).__extensionNativeConsents;
    const m = new Map<string, string>();
    const grants = createRuntimeGrantsPreview({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } });
    const id = 'sample.consent-all', version = '1.0.0';
    grants.register(id, version, [...LEGACY_PERMISSIONS], null);
    const scoped = new Set(['projects.summary', 'tasks.summary', 'connections.request', 'projects.files.metadata', 'projects.files.read', 'projects.git.read']);
    const rows: Record<string, string[]> = {};
    for (const permission of LEGACY_PERMISSIONS as string[]) {
      const project = scoped.has(permission) ? 'project-a' : undefined;
      const row: string[] = [];
      row.push(gate(grants.projection(), id, version, permission, project), String(allows(grants.projection(), id, version, permission, project, false)), String(allows(grants.projection(), id, version, permission, project, true)));
      grants.change({ op: 'grant', id, permission, scope: scoped.has(permission) ? { projects: ['project-a'] } : {} });
      row.push(gate(grants.projection(), id, version, permission, project));
      if (scoped.has(permission)) row.push(gate(grants.projection(), id, version, permission, 'project-b'));
      grants.change({ op: 'revoke', id, permission });
      row.push(gate(grants.projection(), id, version, permission, project), String(allows(grants.projection(), id, version, permission, project, false)));
      rows[permission] = row;
    }
    let unsupported = 'none'; try { gate(grants.projection(), id, version, 'credentials.read'); } catch (error) { unsupported = (error as Error).message; }
    return { rows, unsupported };
  }, scenario);
  for (const [permission, row] of Object.entries(out.rows)) {
    const scoped = row.length === 7;
    expect(row, permission).toEqual(scoped ? ['prompt', 'false', 'true', 'granted', 'prompt', 'prompt', 'false'] : ['prompt', 'false', 'true', 'granted', 'prompt', 'false']);
  }
  expect(Object.keys(out.rows)).toHaveLength(12);
  expect(out.unsupported).toBe('UnsupportedCapability');
});

test('extensions native consents: the preview command answers the migration report and the guide names the rules', async ({ page }) => {
  await boot(page);
  await page.evaluate(snapshot => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(snapshot)); }, scenario.packages.map(item => ({ manifest: item.manifest, enabled: true, icons: {}, storageGranted: item.storageGranted })));
  const guide = read('docs/extensions/runtime-native-consents.md');
  for (const phrase of ['never become grants', 'one write', 'previous prompt', 'extensions_runtime_native_consents']) expect(guide).toContain(phrase);
  expect(guide).not.toMatch(/credentials\.read[^\n]*(grant|allow)/);
});
