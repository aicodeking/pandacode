import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
/**
 * Integrated workspace audit (T55H): installed packages contribute real toolbar and context actions to the Board,
 * GitHub hub and Pull surfaces. Each click must reach the package command through the public context contract,
 * leave the core selection where it was and call no core handler.
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, query: string, packages: unknown[]) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto(`/?extensions-baseline&${query}&replacement`); await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
const toast = (page: Page) => page.locator('#toast');

test('Workspace audit: every host selection kind passed to contributed actions is accepted by the public context contract', () => {
  const kinds = new Set<string>(schema.$defs.context.properties.selection.properties.kind.enum);
  const sources = ['src', 'src/extensions'].flatMap(dir => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(name => name.endsWith('.ts')).map(name => readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')));
  const used = new Set(sources.flatMap(source => [...source.matchAll(/selection: \{ kind: ([^,]+),/g)].flatMap(match => [...match[1].matchAll(/'([a-z-]+)'/g)].map(literal => literal[1]))));
  for (const kind of ['board', 'github-hub', 'pull', 'moodboard', 'moodboard-image', 'task', 'machine']) expect(used).toContain(kind);
  expect([...used].filter(kind => !kinds.has(kind))).toEqual([]);
});

test('Workspace audit: every panda.project and Board/GitHub/Pull ledger row maps to an implemented family with executed evidence', () => {
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8')), audit = ledger.workspaceAudit;
  const project = ledger.families.find((family: any) => family.id === 'panda.project');
  expect(audit.families.map((family: any) => family.ledger).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index).sort()).toEqual(project.members.map(([id]: string[]) => id).sort());
  expect(audit.families.map((family: any) => family.lead).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)).toEqual(['T55A', 'T55B', 'T55C', 'T55D', 'T55E', 'T55F', 'T55G']);
  const configs = ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  for (const family of audit.families) {
    const row = ledger[family.details[0]][family.details[1]];
    expect(row.status, family.slot).toBe('implemented-experimental'); expect(row.adapter).toBe(family.slot);
    for (const field of ['members', 'action', 'control', 'visibility', 'order', 'move', 'replacement', 'evidence']) expect(row[field], `${family.slot}.${field}`).toBeTruthy();
    expect(ledger.implementedAdapters.some((adapter: any) => adapter.id === family.slot)).toBe(true);
    expect(schema.$defs.context.properties.selection.properties.kind.enum).toContain(family.contextKind);
    for (const path of new Set([...family.evidence, ...row.evidence])) expect(() => readFileSync(new URL(`../${path}`, import.meta.url)), path).not.toThrow();
    for (const spec of [...family.evidence, family.contributedActions].filter((path: string) => path.endsWith('-coverage.spec.ts'))) for (const config of configs) expect(config).toContain(spec.replace('tests/', ''));
  }
});

test('Workspace audit: Board header and context actions run the package command without moving the task selection', async ({ page }) => {
  const props = () => page.evaluate(() => (window as any).__previewBoard());
  await setup(page, 'board-coverage', [fixture('board')]);
  await page.locator('#view-menu').click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.locator('#project-board')).toBeVisible(); await expect.poll(async () => (await props())?.rows.length).toBeGreaterThan(0);
  const before = await props(), header = page.locator('#project-board [data-extension-location="panda.board.header"]');
  await header.getByRole('button', { name: 'Board tools', exact: true }).click(); await expect(toast(page)).toContainText('Task stages, drafts and running agents remain host-owned.');
  const filter = page.locator('#board-project-filter'); await filter.focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Board tools', exact: true }).click(); await expect(toast(page)).toContainText('remain host-owned');
  const after = await props(); expect(after.task).toBe(before.task); expect(after.project).toBe(before.project); expect(after.filter).toBe(before.filter);
  for (const command of ['set_task_stage', 'start_session', 'delete_session']) expect(await calls(page, command)).toHaveLength(0);
  // Disable removes the contribution and keeps the built-in Board and its selection.
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.board', exact: true }).click(); await back(page);
  await expect(header.getByRole('button', { name: 'Board tools', exact: true })).toHaveCount(0); await expect(page.locator('#project-board')).toBeVisible();
  expect((await props()).task).toBe(before.task);
});

test('Workspace audit: GitHub hub toolbar and context actions run the package command without fetching or retargeting', async ({ page }) => {
  const props = () => page.evaluate(() => (window as any).__previewGithubHub());
  await setup(page, 'github-hub-coverage', [fixture('github-hub')]);
  await page.locator('#view-menu').click(); await page.getByRole('menuitemradio', { name: 'GitHub', exact: true }).click();
  await expect(page.locator('.gh-thread')).toHaveCount(3); await expect.poll(async () => (await props())?.loading).toBe(false);
  const before = await props(), fetched = (await calls(page, 'github_repos')).length;
  await page.locator('[data-extension-location="panda.githubHub.actions"]').getByRole('button', { name: 'GitHub tools', exact: true }).click();
  await expect(toast(page)).toContainText('Repository, task and workflow ownership stays with PandaCode.');
  const search = page.getByRole('searchbox', { name: 'Search this tab' }); await search.focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'GitHub tools', exact: true }).click(); await expect(toast(page)).toContainText('ownership stays with PandaCode');
  const after = await props(); expect(after.repository).toBe(before.repository); expect(after.tab).toBe(before.tab);
  expect(await calls(page, 'github_repos')).toHaveLength(fetched); for (const command of ['github_clone_repo', 'github_login', 'open_external_url']) expect(await calls(page, command)).toHaveLength(0);
});

test('Workspace audit: Pull toolbar and context actions run the package command without fetching, merging or retargeting', async ({ page }) => {
  const props = () => page.evaluate(() => (window as any).__previewPull()), view = page.locator('#inspector .pull-view');
  await setup(page, 'pull-coverage', [fixture('pull')]);
  await page.locator('.composer-context .link-chip').filter({ hasText: 'PR #130' }).click();
  await expect(view.locator('.pull-title')).toHaveText('Debounce library search'); await expect.poll(async () => (await props())?.loading).toBe(false);
  const before = await props(), action = view.locator('.pull-actions [data-extension-location="panda.pull.actions"]').getByRole('button', { name: 'Pull request tools', exact: true });
  await expect(action).toBeEnabled(); await action.click(); await expect(toast(page)).toContainText('Pull request, diff and merge ownership stays with PandaCode.');
  const refresh = view.getByRole('button', { name: 'Refresh pull request', exact: true }); await refresh.focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Pull request tools', exact: true }).click(); await expect(toast(page)).toContainText('merge ownership stays with PandaCode');
  const after = await props(); expect(after.pull).toBe(before.pull); expect(after.section).toBe(before.section); expect(after.merge).toBe('idle');
  expect(await calls(page, 'github_pull_request')).toHaveLength(1);
  for (const command of ['github_merge_pull_request', 'github_pull_request_diff', 'set_task_link', 'open_external_url']) expect(await calls(page, command)).toHaveLength(0);
  await expect(refresh).toBeFocused();
  // Switching to B keeps the contribution bound to the live pull; disable removes it and leaves B selected.
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(view.locator('.pull-title')).toHaveText('Cache the icon lookups');
  await expect.poll(async () => (await props())?.loading).toBe(false); const b = await props(); expect(b.pull).not.toBe(before.pull);
  await action.click(); await expect(toast(page)).toContainText('merge ownership stays with PandaCode');
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.pull', exact: true }).click(); await back(page);
  await expect(action).toHaveCount(0); expect((await props()).pull).toBe(b.pull);
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
});
