import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/replacement/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page, packages: any[] = [], running = false, selected = {}) {
  await page.addInitScript(({ packages, running, selected }) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: running };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
    localStorage.setItem('pandacode.components.v1', JSON.stringify({ schemaVersion: 1, selected }));
  }, { packages, running, selected });
  await page.goto('/?extensions-baseline&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__previewReplacementModules)).toBe('function');
  if (packages.length) await expect.poll(() => page.evaluate(async () => (await (window as any).__previewReplacementModules()).componentProviders().length)).toBe(packages.length * 2);
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
test('extensions replacement: install, explicit selection, project actions and file/folder actions use core services', async ({ page }) => {
  await setup(page);
  let region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.replacement', exact: true }).click();
  await expect(page.locator('[data-component-provider]')).toHaveCount(0);
  await region.getByLabel('Project presentation', { exact: true }).selectOption('sample.replacement/projects');
  await region.getByLabel('File presentation', { exact: true }).selectOption('sample.replacement/files'); await back(page);
  const cards = page.getByRole('region', { name: 'Project cards', exact: true });
  await cards.getByRole('button', { name: 'pandacode', exact: true }).click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
  await cards.getByRole('button', { name: 'orbit', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await openInspectorTab(page, 'Files'); await page.locator('[data-action="tab-files"]').click();
  const files = page.getByRole('region', { name: 'Compact files', exact: true });
  await files.getByRole('button', { name: 'src ▸', exact: true }).click();
  await expect(files.getByRole('button', { name: 'main.ts', exact: true })).toBeVisible();
  await files.getByRole('button', { name: 'main.ts', exact: true }).click();
  await expect(page.locator('#file-tabs')).toContainText('main.ts');
  await expect(page.locator('#file-view')).toContainText('createSearchIndex');
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.some((call: any) => call.command === 'list_files' && call.args.path === 'src')).toBe(true);
  expect(calls.some((call: any) => call.command === 'read_file' && call.args.path === 'src/main.ts' && call.args.projectId === 'project-1')).toBe(true);
});
test('extensions replacement: E18 failure and disable preserve the same selected task, draft, stream and focus recovery', async ({ page }) => {
  await setup(page, [manifest], true, { 'panda.projects': 'sample.replacement/projects', 'panda.files': 'sample.replacement/files' });
  await page.locator('#prompt').fill('Hold running task'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.locator('#prompt').fill('Draft survives replacement recovery');
  const prompt = await page.locator('#prompt').elementHandle();
  const selected = await page.locator('.task-item.selected').getAttribute('data-id');
  await page.getByRole('region', { name: 'Project cards' }).getByRole('button', { name: 'orbit', exact: true }).focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); const host = document.createElement('div'); const props = { contractVersion: 1, slot: 'panda.projects', context: 'test', revision: 0, objects: [], state: { selected: '', focused: '', visible: true, loading: false, offline: false } }; api.renderComponent(host, props, () => props, () => {}, () => { throw Error('controlled rendering crash'); }); dispatchEvent(new Event('pandacode-components-change')); });
  await expect(page.locator('#project-filter')).toBeVisible(); await expect(page.locator('#project-filter')).toBeFocused();
  await expect(page.getByRole('region', { name: 'Project cards' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'text', text: 'Stream after presentation crash.' }));
  await expect(page.locator('#transcript')).toContainText('Stream after presentation crash.');
  await openInspectorTab(page, 'Files'); await page.locator('[data-action="tab-files"]').click();
  await page.getByRole('region', { name: 'Compact files' }).getByRole('button', { name: 'README.md', exact: true }).focus();
  await page.evaluate(async () => (window as any).__previewDisableExtension('sample.replacement'));
  await expect(page.locator('[data-component-provider]')).toHaveCount(0);
  await expect(page.locator('#inspector-content [data-path="README.md"]').first()).toBeFocused();
  await expect(page.locator('#prompt')).toHaveValue('Draft survives replacement recovery');
  expect(await prompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', selected!);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.filter((call: any) => ['cancel_session', 'delete_session'].includes(call.command))).toEqual([]);
});
test('extensions replacement: competing providers require a user winner; incompatible, safe mode and Built-in recover deterministically', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.cards'; other.contributes.components.forEach((item: any) => { item.id = item.id.replace('sample.replacement', 'other.cards'); item.title = `Other ${item.title}`; });
  const incompatible = structuredClone(manifest); incompatible.id = 'future.cards'; incompatible.contributes.components.forEach((item: any) => { item.id = item.id.replace('sample.replacement', 'future.cards'); item.contractVersion = 2; });
  await setup(page, [other, manifest, incompatible], false, { 'panda.files': 'future.cards/files' });
  await expect(page.locator('#project-filter')).toBeVisible(); await expect(page.locator('[data-component-provider]')).toHaveCount(0);
  const region = await explorer(page);
  await expect(region.locator('option[value="future.cards/projects"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Project presentation', { exact: true }).selectOption('other.cards/projects'); await back(page);
  await expect(page.locator('[data-component-provider="other.cards/projects"]')).toBeVisible();
  await expect(page.locator('[data-component-provider="sample.replacement/projects"]')).toHaveCount(0);
  await explorer(page); await page.getByLabel('Project presentation', { exact: true }).selectOption(''); await back(page);
  await expect(page.locator('#project-filter')).toBeVisible();
  await explorer(page); await page.getByLabel('Project presentation', { exact: true }).selectOption('sample.replacement/projects');
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('#project-filter')).toBeVisible(); await expect(page.locator('[data-component-provider]')).toHaveCount(0);
});
test('extensions replacement: v1 host renderer conforms to loading, offline, hidden, immutable props, focus and listener disposal', async ({ page }) => {
  await setup(page, [manifest], false, { 'panda.files': 'sample.replacement/files' });
  const result = await page.evaluate(async () => {
    const api = await (window as any).__previewReplacementModules();
    const host = document.createElement('div'); document.body.append(host);
    let latest = { contractVersion: 1, slot: 'panda.files', context: 'A', revision: 1, objects: [{ id: 'file', label: 'File <script>', revision: 1 }], state: { selected: 'file', focused: 'file', loading: false, offline: false, visible: true } };
    let calls = 0;
    const checks = [];
    for (const state of [{ loading: true }, { offline: true }, { visible: false }, {}]) {
      latest = { ...latest, state: { selected: 'file', focused: 'file', loading: false, offline: false, visible: true, ...state } };
      const dispose = api.renderComponent(host, latest, () => latest, () => calls++);
      const button = host.querySelector('button')!;
      if (!state.loading && !state.offline && state.visible !== false) button.focus();
      checks.push({ status: host.querySelector('[role="status"]')?.textContent ?? '', disabled: button.disabled, hidden: host.querySelector('section')!.hidden, escaped: host.querySelectorAll('script').length === 0, selected: button.getAttribute('aria-current'), focus: document.activeElement === button });
      dispose(); button.click();
    }
    const disposedCalls = calls;
    const dispose = api.renderComponent(host, latest, () => latest, () => calls++);
    const button = host.querySelector('button')!; latest = { ...latest, context: 'B' }; button.click();
    const staleCalls = calls;
    latest = { ...latest, context: 'A' }; button.click(); dispose(); host.remove();
    return { checks, disposedCalls, staleCalls, calls };
  });
  expect(result.disposedCalls).toBe(0); expect(result.staleCalls).toBe(0); expect(result.calls).toBe(1);
  expect(result.checks[0].status).toBe('Loading…'); expect(result.checks[0].disabled).toBe(true);
  expect(result.checks[1].status).toContain('Offline'); expect(result.checks[1].disabled).toBe(true);
  expect(result.checks[2].hidden).toBe(true); expect(result.checks[3].focus).toBe(true);
  expect(result.checks.every(item => item.escaped && item.selected === 'true')).toBe(true);
});
