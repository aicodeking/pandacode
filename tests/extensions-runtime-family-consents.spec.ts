import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const scenario = JSON.parse(read('tests/fixtures/extensions/runtime-family-consents/scenario.json')) as {
  packages: Record<string, any>[]; families: { family: string; covering: string[] }[]; irreversible: string[]; userOnly: string[];
};

async function boot(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); });
  await page.goto('/?family-consents'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionFamilyConsents);
}

test('extensions family consents: the Rust table, the TypeScript mirror and the fixture list the same eight families', () => {
  const rust = read('src-tauri/src/extensions/runtime_family_consents.rs');
  const names = [...rust.match(/pub fn name\(self\)[\s\S]*?\n    \}/)![0].matchAll(/=> "([A-Za-z]+)"/g)].map(match => match[1]);
  expect(names).toEqual(scenario.families.map(row => row.family));
  const ts = read('src/extensions/runtime-family-consents.ts');
  expect([...ts.matchAll(/\{ family: '([A-Za-z]+)', covering: \[([^\]]*)\] \}/g)].map(match => [match[1], [...match[2].matchAll(/'([A-Za-z.]+)'/g)].map(name => name[1])])).toEqual(scenario.families.map(row => [row.family, row.covering]));
  const irreversible = [...rust.match(/const IRREVERSIBLE[\s\S]*?\];/)![0].matchAll(/\("([a-z.]+)", /g)].map(match => match[1]);
  expect(irreversible).toEqual(scenario.irreversible);
  expect([...ts.match(/export const IRREVERSIBLE[\s\S]*?\];/)![0].matchAll(/\['([a-z.]+)', /g)].map(match => match[1])).toEqual(scenario.irreversible);
  expect(scenario.userOnly.every(name => rust.includes(`"${name}"`) && ts.includes(`'${name}'`))).toBe(true);
});

const run = (page: Page, body: string) => page.evaluate(async ({ scenario, body }) => {
  const { createFamilyConsentsPreview, createRuntimeGrantsPreview } = (window as any).__extensionFamilyConsents;
  const memory = new Map<string, string>(), store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } };
  const snapshot = { safeMode: false, packages: scenario.packages };
  const open = () => { const grants = createRuntimeGrantsPreview(store); const family = createFamilyConsentsPreview(grants, store); grants.sync(snapshot); return { grants, family }; };
  const attempt = (action: () => unknown) => { try { return { ok: action() }; } catch (error) { return { error: (error as Error).message }; } };
  const fn = new Function('open', 'attempt', 'scenario', `return (async () => { ${body} })();`);
  return fn(open, attempt, scenario);
}, { scenario, body });

test('extensions family consents: a granted package acts without a prompt, an API-1 package keeps the prior choice and restart keeps it', async ({ page }) => {
  await boot(page);
  const out = await run(page, `
    let { grants, family } = open();
    const holder = 'sample.family-holder', api1 = 'sample.family-api1';
    const rows = {};
    for (const row of scenario.families) {
      grants.change({ op: 'revokeAll', id: holder });
      const before = family.handle({ op: 'gate', id: holder, family: row.family, project: 'project-a' }).decision;
      for (const permission of row.covering) grants.change({ op: 'grant', id: holder, permission, scope: { projects: ['project-a'] } });
      rows[row.family] = [before, family.handle({ op: 'gate', id: holder, family: row.family, project: 'project-a' }).decision, family.handle({ op: 'gate', id: holder, family: row.family, project: 'project-b' }).decision, family.handle({ op: 'gate', id: api1, family: row.family, project: 'project-a' }).decision];
    }
    const offer = family.handle({ op: 'gate', id: api1, family: 'machineControl', project: 'project-a' });
    family.handle({ op: 'choice', ticket: offer.ticket, allow: true });
    const stored = [family.handle({ op: 'gate', id: api1, family: 'machineControl', project: 'project-a' }).decision, family.handle({ op: 'gate', id: api1, family: 'machineControl', project: 'project-b' }).decision, family.handle({ op: 'gate', id: api1, family: 'cloudControl', project: 'project-a' }).decision];
    ({ grants, family } = open()); // restart
    const restarted = family.handle({ op: 'gate', id: api1, family: 'machineControl', project: 'project-a' }).decision;
    const projection = family.handle({ op: 'projection' }).packages;
    let undeclared = 'none'; try { grants.change({ op: 'grant', id: api1, permission: 'tasks.control', scope: {} }); } catch (error) { undeclared = error.message; }
    return { rows, stored, restarted, projection, undeclared };
  `);
  for (const [name, row] of Object.entries(out.rows)) expect(row, name).toEqual(['prompt', 'granted', 'prompt', 'prompt']);
  expect(Object.keys(out.rows)).toHaveLength(8);
  expect(out.stored).toEqual(['granted', 'prompt', 'prompt']);
  expect(out.restarted).toBe('granted');
  expect(out.projection).toEqual([{ id: 'sample.family-api1', confirmDeletions: true, consents: [{ family: 'machineControl', projects: ['project-a'] }] }]);
  expect(out.undeclared).toBe('PermissionDenied');
});

test('extensions family consents: BTW content and control become native grants through the choice and survive a restart', async ({ page }) => {
  await boot(page);
  const out = await run(page, `
    let { grants, family } = open();
    const holder = 'sample.family-holder', result = {};
    for (const [name, permission] of [['btwContent', 'btw.content'], ['btwControl', 'btw.taskControl']]) {
      const offer = family.handle({ op: 'gate', id: holder, family: name, project: 'project-a' });
      family.handle({ op: 'choice', ticket: offer.ticket, allow: true });
      result[name] = [offer.decision, grants.check(holder, '1.0.0', permission, { project: 'project-a' }), grants.check(holder, '1.0.0', permission, { project: 'project-b' })];
    }
    ({ grants, family } = open());
    result.restarted = family.handle({ op: 'gate', id: holder, family: 'btwContent', project: 'project-a' }).decision;
    const widen = family.handle({ op: 'gate', id: holder, family: 'btwContent', project: 'project-b' });
    family.handle({ op: 'choice', ticket: widen.ticket, allow: true });
    result.scope = grants.projection().packages.find(item => item.id === holder).grants.find(grant => grant.permission === 'btw.content').scope;
    const withdraw = family.handle({ op: 'gate', id: holder, family: 'btwContent', project: 'project-c' });
    family.handle({ op: 'choice', ticket: withdraw.ticket, allow: false });
    result.unchanged = grants.check(holder, '1.0.0', 'btw.content', { project: 'project-a' });
    return result;
  `);
  expect(out.btwContent).toEqual(['prompt', 'ok', 'PermissionDenied']);
  expect(out.btwControl).toEqual(['prompt', 'ok', 'PermissionDenied']);
  expect(out.restarted).toBe('granted');
  expect(out.scope).toEqual({ projects: ['project-a', 'project-b'] });
  expect(out.unchanged).toBe('ok');
});

test('extensions family consents: a forged webview consent is rejected for BTW and all six families and changes nothing', async ({ page }) => {
  await boot(page);
  const out = await run(page, `
    const { grants, family } = open();
    const api1 = 'sample.family-api1', holder = 'sample.family-holder', before = JSON.stringify(grants.projection()), forged = [];
    for (const row of scenario.families) {
      for (const key of ['consent', 'granted', 'confirmed', 'approved', row.family, 'permission']) forged.push([row.family, key, attempt(() => family.handle({ op: 'gate', id: api1, family: row.family, [key]: true })).error]);
      forged.push([row.family, 'ticket', attempt(() => family.handle({ op: 'choice', ticket: 'forged', allow: true })).error]);
      const token = family.handle({ op: 'gate', id: api1, family: row.family, project: 'project-a' }).ticket;
      family.handle({ op: 'choice', ticket: token, allow: false });
      forged.push([row.family, 'reuse', attempt(() => family.handle({ op: 'choice', ticket: token, allow: true })).error]);
    }
    const after = JSON.stringify(grants.projection());
    const unknown = attempt(() => family.handle({ op: 'gate', id: api1, family: 'machineControl', extra: 1 })).error;
    const deleteForged = attempt(() => family.handle({ op: 'delete', id: holder, action: 'projects.remove', confirmed: true })).error;
    grants.change({ op: 'grant', id: holder, permission: 'workspace.manage', scope: {} });
    const confirm = family.handle({ op: 'delete', id: holder, action: 'projects.remove', what: 'x' });
    const crossKind = attempt(() => family.handle({ op: 'choice', ticket: confirm.ticket, allow: true })).error;
    const userOnly = scenario.userOnly.map(name => attempt(() => family.handle({ op: 'gate', id: holder, family: name })).error);
    const credentials = attempt(() => family.handle({ op: 'gate', id: holder, family: 'credentials.read' })).error;
    return { forged, same: before === after, unknown, deleteForged, crossKind, userOnly, credentials, granted: family.handle({ op: 'gate', id: api1, family: 'machineControl', project: 'project-a' }).decision };
  `);
  expect(out.forged).toHaveLength(8 * 8);
  expect(out.forged.every(([, , error]: [string, string, string]) => error === 'PermissionDenied')).toBe(true);
  expect(out.same).toBe(true);
  expect(out.unknown).toBe('InvalidArguments');
  expect(out.deleteForged).toBe('PermissionDenied');
  expect(out.crossKind).toBe('PermissionDenied');
  expect(out.userOnly).toEqual(['PermissionDenied', 'PermissionDenied', 'PermissionDenied']);
  expect(out.credentials).toBe('UnsupportedCapability');
  expect(out.granted).toBe('prompt');
});

test('extensions family consents: irreversible deletion confirms by default, refusal is Cancelled and the switch is per package', async ({ page }) => {
  await boot(page);
  const out = await run(page, `
    let { grants, family } = open();
    const holder = 'sample.family-holder', other = 'sample.family-other', api1 = 'sample.family-api1';
    for (const id of [holder, other]) grants.change({ op: 'grant', id, permission: 'workspace.manage', scope: {} });
    const actions = {};
    for (const action of scenario.irreversible) {
      const first = family.handle({ op: 'delete', id: holder, action, what: 'Project\\u0007 Alpha' });
      const refused = attempt(() => family.handle({ op: 'answer', ticket: first.ticket, accepted: false })).error;
      const second = family.handle({ op: 'delete', id: holder, action, what: 'x' });
      const accepted = family.handle({ op: 'answer', ticket: second.ticket, accepted: true }).decision;
      const again = attempt(() => family.handle({ op: 'answer', ticket: second.ticket, accepted: true })).error;
      actions[action] = [first.decision, first.what, refused, accepted, again];
    }
    const unknown = attempt(() => family.handle({ op: 'delete', id: holder, action: 'packages.format' })).error;
    family.handle({ op: 'preference', id: holder, confirmDeletions: false });
    const off = [family.handle({ op: 'delete', id: holder, action: 'tasks.remove' }).decision, family.handle({ op: 'delete', id: other, action: 'tasks.remove' }).decision];
    ({ grants, family } = open()); // restart
    const restarted = [family.handle({ op: 'delete', id: holder, action: 'tasks.remove' }).decision, family.handle({ op: 'delete', id: other, action: 'tasks.remove' }).decision];
    family.handle({ op: 'preference', id: holder, confirmDeletions: true });
    const back = family.handle({ op: 'delete', id: holder, action: 'tasks.remove' }).decision, stored = family.projection().packages.length;
    family.handle({ op: 'preference', id: api1, confirmDeletions: false });
    const withoutPermission = ['projects.remove', 'cloud.machines.remove', 'pulls.merge'].map(action => attempt(() => family.handle({ op: 'delete', id: api1, action })).error);
    const pending = family.handle({ op: 'delete', id: other, action: 'pulls.merge' });
    grants.change({ op: 'revoke', id: other, permission: 'workspace.manage' });
    const revoked = attempt(() => family.handle({ op: 'answer', ticket: pending.ticket, accepted: true })).error;
    return { actions, unknown, off, restarted, back, stored, withoutPermission, revoked };
  `);
  expect(Object.keys(out.actions)).toEqual(scenario.irreversible);
  for (const [action, row] of Object.entries(out.actions)) expect(row, action).toEqual(['confirm', 'Project Alpha', 'Cancelled', 'proceed', 'PermissionDenied']);
  expect(out.unknown).toBe('UnsupportedCapability');
  expect(out.off).toEqual(['proceed', 'confirm']);
  expect(out.restarted).toEqual(['proceed', 'confirm']);
  expect(out.back).toBe('confirm');
  expect(out.stored).toBe(0);
  expect(out.withoutPermission).toEqual(['PermissionDenied', 'PermissionDenied', 'PermissionDenied']);
  expect(out.revoked).toBe('PermissionDenied');
});

test('extensions family consents: the preview command shares one store and the guide names the rules', async ({ page }) => {
  await boot(page);
  await page.evaluate(snapshot => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(snapshot)); }, scenario.packages.map(item => ({ manifest: item.manifest, enabled: true, icons: {} })));
  const guide = read('docs/extensions/runtime-family-consents.md');
  for (const phrase of ['prior host choice', 'single-use ticket', 'Cancelled', 'only this package', 'user-only', 'extensions_family_consents', 'PermissionDenied']) expect(guide).toContain(phrase);
  expect(guide).not.toMatch(/credentials\.read[^\n]*(grant|allow)/);
});
