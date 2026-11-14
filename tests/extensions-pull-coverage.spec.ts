import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/pull/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewPull());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const view = (page: Page) => page.locator('#inspector .pull-view');
const FILE = 'src/lib/search-index.ts';
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&pull-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page) {
  await page.locator('.composer-context .link-chip').filter({ hasText: 'PR #130' }).click();
  await expect(view(page).locator('.pull-title')).toHaveText('Debounce library search'); await expect.poll(async () => (await props(page))?.loading).toBe(false);
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Pull request presentation', { exact: true }).selectOption('sample.pull/sections'); await back(page); await expect(page.locator('[data-pull-provider]')).toBeVisible(); }
/** Builds a captured action from the live presentation; `path` picks a file control by its permissioned summary. */
async function action(page: Page, controlId: string, path = '', changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, path, changes }) => {
    const p = (window as any).__previewPull(), file = p.files.find((item: any) => item.path === path);
    const control = p.controls.find((control: any) => control.controlId === controlId && (!path || control.resource === file?.id));
    if (!control) throw Error(`Missing ${controlId}/${path}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, repository: p.repository, pull: p.pull, base: p.base, head: p.head, section: p.section, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, path, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewPullAction(input), input);
const act = async (page: Page, controlId: string, path = '', changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, path, changes));
const allow = (page: Page) => page.getByRole('button', { name: 'Allow Pull request control for sample.pull', exact: true }).click();
const markViewer = (page: Page) => page.locator(`.pull-file-diff[data-diff-path="${FILE}"] > *`).first().evaluate(node => { (node as HTMLElement).dataset.liveMarker = 'kept'; });
const viewerKept = (page: Page) => expect(page.locator(`.pull-file-diff[data-diff-path="${FILE}"] [data-live-marker="kept"]`)).toHaveCount(1);
async function openDiff(page: Page) {
  expect(await act(page, 'files')).toEqual({ ok: true }); await expect(view(page).locator('.pull-tabs [aria-selected="true"]')).toHaveText('Files');
  expect(await act(page, 'file', FILE)).toEqual({ ok: true }); await expect(view(page).locator(`.pull-file-diff[data-diff-path="${FILE}"]`)).not.toContainText('Loading diff');
  await markViewer(page);
}

test('Pull extension: discovery/install/enable never fetches or merges; selected sections-first state uses original handlers', async ({ page }) => {
  await setup(page); await open(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.pull', exact: true }).click();
  await expect(region.getByLabel('Pull request presentation')).toHaveValue(''); await region.getByLabel('Pull request presentation').selectOption('sample.pull/sections'); await back(page);
  expect(await calls(page, 'github_pull_request')).toHaveLength(1); expect(await calls(page, 'github_pull_request_diff')).toHaveLength(0); expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
  await expect(view(page).locator('.pull-tabs')).toHaveCSS('order', '-1'); const p = await props(page);
  expect(p).toMatchObject({ title: 'Debounce library search', section: 'overview', state: 'open', merge: 'idle', method: 'squash', visible: true, busy: false, error: false });
  expect(p.files.map((file: any) => file.path)).toEqual([FILE, 'src/components/search.ts']); expect(p.base).not.toBe(''); expect(p.head).not.toBe(p.base);
  expect(p.controls.some((control: any) => control.controlId === 'merge-confirm')).toBe(false);
  await openDiff(page); expect(await calls(page, 'github_pull_request_diff')).toHaveLength(1);
  const button = view(page).locator('.pull-file').first(); await button.focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Pull request tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(button).toBeFocused();
  expect(await act(page, 'refresh')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'github_pull_request').then(calls => calls.length)).toBe(2);
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0); expect(await calls(page, 'set_task_link')).toHaveLength(0);
});

test('Pull extension: zero extensions keep the original view, withhold metadata and select nothing', async ({ page }) => {
  await setup(page); await open(page); const p = await props(page);
  expect(p.title).toBe(''); expect(p.files.every((file: any) => file.path === '')).toBe(true); await expect(page.locator('[data-pull-provider]')).toHaveCount(0);
  expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Revoked' });
  await view(page).getByRole('button', { name: 'Merge: Squash and merge', exact: true }).click();
  const confirm = view(page).getByRole('group', { name: 'Merge pull request #130' }); await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0); expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
});

test('Pull extension: merge confirmation stays host-owned; start needs consent, confirm cannot be forged or hidden, one user merge', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  expect(await act(page, 'merge-start')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'merge-start')).toEqual({ ok: true });
  const confirm = view(page).getByRole('group', { name: 'Merge pull request #130' }); await expect(confirm).toBeVisible(); expect((await props(page)).merge).toBe('confirm');
  expect(await act(page, 'merge-cancel', '', { controlId: 'merge-confirm' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.pull.merge');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button')).toHaveCount(0); await back(page);
  // A forged stored overlay can hide an eligible control, never the protected confirmation.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.pull.controls/unlink': false, 'panda.pull.merge/merge-confirm': false, 'panda.pull.merge/merge-cancel': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new Event('pandacode-components-change')); });
  await expect(view(page).getByRole('button', { name: 'Unlink pull request' })).toBeHidden();
  await expect(confirm.getByRole('button', { name: 'Confirm merge', exact: true })).toBeVisible(); await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(confirm.getByRole('combobox', { name: 'Merge method' })).toHaveValue('squash');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'github_merge_pull_request'; });
  await confirm.getByRole('combobox', { name: 'Merge method' }).selectOption('rebase'); await confirm.getByRole('button', { name: 'Confirm merge', exact: true }).click();
  await expect.poll(async () => (await props(page)).busy).toBe(true); expect((await props(page)).merge).toBe('merging');
  expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(page.locator('#toast')).toContainText('Merged pull request #130');
  await expect(view(page).locator('.pull-state')).toHaveText('Merged'); expect((await props(page)).merge).toBe('unavailable');
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(1); expect((await calls(page, 'github_merge_pull_request'))[0].args).toEqual({ sessionId: 'session-1', method: 'rebase' });
});

test('Pull extension: pending merge on A survives switching to B and disable without retargeting B', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  const stale = await action(page, 'refresh');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'github_merge_pull_request'; });
  await view(page).getByRole('button', { name: 'Merge: Squash and merge', exact: true }).click(); await view(page).getByRole('button', { name: 'Confirm merge', exact: true }).click();
  await expect.poll(() => calls(page, 'github_merge_pull_request').then(calls => calls.length)).toBe(1);
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(view(page).locator('.pull-title')).toHaveText('Cache the icon lookups'); await expect.poll(async () => (await props(page))?.loading).toBe(false);
  const b = await props(page); expect(b.pull).not.toBe(stale.pull); expect(b.busy).toBe(false);
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.pull', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(page.locator('#toast')).toContainText('Merged pull request #130');
  await expect(view(page).locator('.pull-title')).toHaveText('Cache the icon lookups'); await expect(view(page).locator('.pull-state')).toHaveText('Open');
  expect((await props(page)).pull).toBe(b.pull); expect((await props(page)).merge).toBe('idle');
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(1); expect((await calls(page, 'github_merge_pull_request'))[0].args.sessionId).toBe('session-1');
});

test('Pull extension: a delayed reply for A is never applied to B', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'github_pull_request'; });
  expect(await act(page, 'refresh')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'github_pull_request').then(calls => calls.length)).toBe(2);
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(view(page).locator('.pull-title')).toHaveText('Cache the icon lookups');
  const b = await props(page); await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(() => calls(page, 'github_pull_request').then(calls => calls.length)).toBe(3);
  await page.waitForFunction(() => !(window as any).__extensionsBaseline.releaseCommand);
  await expect(view(page).locator('.pull-title')).toHaveText('Cache the icon lookups'); expect((await props(page)).pull).toBe(b.pull);
  await page.locator('.task-item[data-id="session-1"]').click(); await expect(view(page).locator('.pull-title')).toHaveText('Debounce library search');
});

test('Pull extension: diff viewers, selection and focus survive reselection, fault, conflict-free recovery, disable and safe mode', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await openDiff(page);
  const button = view(page).locator('.pull-file').first(); await button.focus(); const before = await props(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await viewerKept(page); await expect(button).toBeFocused();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyPullPresentation(document.querySelector('#inspector .pull-view'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-pull-presentation-status]')).toContainText('Built-in view remains active'); expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Revoked' });
  await viewerKept(page); await expect(button).toBeFocused(); expect((await props(page)).section).toBe('files'); expect((await props(page)).pull).toBe(before.pull);
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.pull', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-pull-provider]')).toHaveCount(0); await expect(view(page).locator('.pull-tabs')).toHaveCSS('order', '0');
  expect((await props(page)).pull).toBe(before.pull); expect((await props(page)).section).toBe('files'); await expect(view(page).locator(`.pull-file-diff[data-diff-path="${FILE}"]`)).not.toBeEmpty();
  expect(await calls(page, 'github_pull_request')).toHaveLength(1); expect(await calls(page, 'github_pull_request_diff')).toHaveLength(1);
});

test('Pull extension: conflict and future providers never auto-select; safe-mode keeps built-in', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.pull'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.pull/sections' }] };
  const future = structuredClone(other); future.id = 'future.pull'; future.contributes.components[0].id = 'future.pull/sections'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); await open(page); const region = await explorer(page);
  await expect(region.getByLabel('Pull request presentation')).toHaveValue(''); await expect(region.locator('option[value="future.pull/sections"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Pull request presentation').selectOption('other.pull/sections'); await back(page);
  await expect(page.locator('[data-pull-provider="other.pull/sections"]')).toBeVisible();
  expect(await act(page, 'overview')).toEqual({ ok: true });
  await page.context().setOffline(true); expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Offline' }); await page.context().setOffline(false);
  expect(await act(page, 'refresh', '', { pull: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'refresh', '', { repository: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'refresh', '', { base: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
});

test('Pull extension: unlink needs consent and runs the original handler once', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  expect(await act(page, 'unlink')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'set_task_link'; });
  expect(await act(page, 'unlink')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'set_task_link').then(calls => calls.length)).toBe(1);
  expect(await act(page, 'unlink')).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(page.locator('#toast')).toContainText('Pull request #130 unlinked');
  expect(await calls(page, 'set_task_link')).toHaveLength(1); expect((await calls(page, 'set_task_link'))[0].args).toMatchObject({ sessionId: 'session-1', kind: 'pull', link: null });
  await expect(view(page)).toHaveCount(0);
});

test('Pull extension: external link, review and check entries require a fresh host user choice', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  expect(await act(page, 'link')).toEqual({ ok: true }); await expect(page.getByRole('menuitemradio', { name: 'Continue with original GitHub action', exact: true })).toBeVisible();
  expect(await calls(page, 'open_external_url')).toHaveLength(0); await page.keyboard.press('Escape');
  expect(await act(page, 'review')).toEqual({ ok: true }); await page.getByRole('menuitemradio', { name: 'Continue with original GitHub action', exact: true }).click();
  await expect.poll(() => calls(page, 'open_external_url').then(calls => calls.length)).toBe(1); expect((await calls(page, 'open_external_url'))[0].args.url).toBe('https://github.com/orbit-labs/orbit/pull/130');
  expect(await act(page, 'checks')).toEqual({ ok: true }); await expect(view(page).locator('.pull-checks')).toBeVisible(); expect((await props(page)).checks).toBe(true);
  expect(await act(page, 'check')).toEqual({ ok: true }); await page.getByRole('menuitemradio', { name: 'Continue with original GitHub action', exact: true }).click();
  await expect.poll(() => calls(page, 'open_external_url').then(calls => calls.length)).toBe(2); expect((await calls(page, 'open_external_url'))[1].args.url).toBe('https://github.com/orbit-labs/orbit/actions/runs/1');
  expect(await act(page, 'conflicts')).toEqual({ ok: true }); await expect(view(page).locator('.pull-tabs [aria-selected="true"]')).toHaveText('Commits');
  expect(await act(page, 'commits')).toEqual({ ok: true }); expect(await act(page, 'overview')).toEqual({ ok: true }); expect(await act(page, 'merge-method')).toEqual({ ok: true });
  await expect(page.getByRole('menu', { name: 'Merge method' })).toBeVisible(); await page.keyboard.press('Escape'); expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
});

test('Pull extension: compatible sibling order, reversible visibility and safe recovery', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  const order = () => view(page).locator('.pull-actions').evaluate(node => [...node.children].filter(item => (item as HTMLElement).dataset.pullAction).map(item => (item as HTMLElement).getAttribute('aria-label')));
  expect(await order()).toEqual(['Refresh pull request', 'Open on GitHub', 'Unlink pull request']);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.pull.controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Open on GitHub before refresh', exact: true }).click(); await back(page);
  expect(await order()).toEqual(['Open on GitHub', 'Refresh pull request', 'Unlink pull request']);
  await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.pull.controls');
  const next = region.getByRole('button', { name: 'Next items', exact: true });
  for (let cursor = 0; cursor < 3 && !await region.getByRole('button', { name: 'Hide Unlink pull request', exact: true }).count(); cursor++) await next.click();
  await region.getByRole('button', { name: 'Hide Unlink pull request', exact: true }).click(); await back(page);
  await expect(view(page).getByRole('button', { name: 'Unlink pull request' })).toBeHidden(); await expect(view(page).getByRole('button', { name: 'Merge: Squash and merge', exact: true })).toBeVisible();
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(view(page).getByRole('button', { name: 'Unlink pull request' })).toBeVisible(); expect(await order()).toEqual(['Refresh pull request', 'Open on GitHub', 'Unlink pull request']);
  expect(await calls(page, 'github_pull_request')).toHaveLength(1);
});

for (let index = 0; index < 3; index++) test(`Pull extension: reversible catalog member page ${index + 1} of 3`, async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.pull.controls');
  for (let cursor = 0; cursor < index; cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  const buttons = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: /^Hide / });
  await expect(buttons).toHaveCount(index === 2 ? 1 : 5);
  for (const button of await buttons.all()) { const label = (await button.innerText()).replace(/^Hide /, ''); await button.click(); await region.getByRole('button', { name: `Show ${label}`, exact: true }).click(); }
});

test('Pull extension: load failure, retry and file diff failure are explicit without duplicate requests', async ({ page }) => {
  await setup(page, [manifest]); await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'github_pull_request'; });
  await page.locator('.composer-context .link-chip').filter({ hasText: 'PR #130' }).click(); await expect(view(page).getByRole('alert')).toContainText('Unable to load the pull request');
  await expect.poll(async () => (await props(page))?.error).toBe(true); await select(page);
  expect((await props(page)).loading).toBe(true); expect(await act(page, 'refresh')).toEqual({ ok: true });
  await expect(view(page).locator('.pull-title')).toHaveText('Debounce library search'); await expect.poll(async () => (await props(page)).error).toBe(false); expect(await calls(page, 'github_pull_request')).toHaveLength(2);
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'github_pull_request_diff'; });
  expect(await act(page, 'files')).toEqual({ ok: true }); expect(await act(page, 'file', FILE)).toEqual({ ok: true });
  await expect.poll(async () => (await props(page)).files[0]).toMatchObject({ expanded: true, error: true });
  expect(await calls(page, 'github_pull_request_diff')).toHaveLength(1);
});
