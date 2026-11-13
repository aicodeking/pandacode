import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/diff/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page, packages: unknown[] = [], failDiff = false) {
  await page.addInitScript(({ packages, failDiff }) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], ...(failDiff ? { failOnce: 'git_diff' } : {}) };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, failDiff });
  await page.goto('/?extensions-baseline&diff-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  const toggle = page.locator('#inspector-toggle');
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  await openInspectorTab(page, 'Changes');
  await page.locator('.inspector-tab[data-view="changes"] [role="tab"]').click();
  if (failDiff) await expect(page.locator('.cv-error')).toContainText('Baseline rejected git_diff');
  else await expect(page.locator('.changes-view .diff-viewer').first()).toHaveAttribute('data-diff-state', /ready|fallback/);
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Changes presentation', { exact: true }).selectOption('sample.diff/commit'); await back(page); }
async function menu(page: Page, name: string) { await page.getByRole('button', { name: 'More actions', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); }
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function action(page: Page, controlId: string, file = false) {
  return page.evaluate(({ controlId, file }) => {
    const props = (window as any).__previewChanges(), entry = file ? props.files[0] : undefined;
    const action = { contractVersion: 1, context: props.context, repository: props.repository, revision: props.revision, fileId: entry?.id ?? '', diffId: entry?.diffId ?? '', fileRevision: entry?.revision ?? 0, hunkId: '', hunkRevision: 0, controlId, requestId: crypto.randomUUID() };
    (window as any).__capturedChangesAction = action;
    return (window as any).__previewChangesAction(action);
  }, { controlId, file });
}
test('diff: zero extensions retain original scope, fold, viewer controls, stage and commit policy', async ({ page }) => {
  await setup(page);
  await expect(page.locator('[data-changes-provider]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.locator('.cv-file.collapsed')).toHaveCount(3);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await expect(page.locator('.diff-viewer-toolbar').first()).toBeHidden();
  await menu(page, 'Commit…'); await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Not yet staged');
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Commit message', exact: true }).press('Escape');
  await menu(page, 'Stage all');
  await expect.poll(async () => (await calls(page, 'git_stage')).length).toBe(1);
  await menu(page, 'Commit…'); await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Original staged commit');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.cv-state-clean')).toContainText('Working tree clean');
  expect((await calls(page, 'git_commit')).length).toBe(1);
});
test('diff: installed selected recipe, catalog, context, control visibility/order and compatible form move preserve nodes', async ({ page }) => {
  await setup(page); const viewer = await page.locator('.diff-viewer').first().elementHandle();
  let region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.diff', exact: true }).click();
  await expect(page.locator('[data-changes-provider]')).toHaveCount(0);
  await region.getByLabel('Changes presentation', { exact: true }).selectOption('sample.diff/commit');
  await region.getByRole('button', { name: 'Grant UI customization and select Menu before folds', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.changes.viewer');
  await region.getByRole('button', { name: 'Hide Wrap lines', exact: true }).click();
  await back(page);
  await expect(page.locator('[data-changes-provider="sample.diff/commit"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true }).first()).toBeHidden();
  expect(await page.locator('.cv-header > [data-cv-action]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-cv-action')))).toEqual(['scope', 'menu', 'fold-all']);
  await page.getByRole('button', { name: 'Diff tools', exact: true }).click(); await expect(page.locator('#toast')).toContainText('original host handlers');
  await page.getByRole('button', { name: 'File actions', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Diff tools', exact: true }).click(); await expect(page.locator('#toast')).toContainText('staged scope');
  await menu(page, 'Commit…');
  expect(await page.locator('.cv-commit').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Retained draft');
  region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.changes.viewer');
  await region.getByRole('button', { name: 'Show Wrap lines', exact: true }).click();
  await page.getByRole('button', { name: 'Disable sample.diff', exact: true }).click(); await back(page);
  await expect(page.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue('Retained draft');
  expect(await viewer!.evaluate(node => node === document.querySelector('.diff-viewer'))).toBe(true);
  expect(await page.locator('.cv-commit').evaluate(node => getComputedStyle(node).order)).toBe('0');
  expect(await page.locator('.cv-header > [data-cv-action]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-cv-action')))).toEqual(['scope', 'fold-all', 'menu']);
});
test('diff: structured captured actions stage one file once, retain staged scope and reject stale hunk/repository', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const before = await page.evaluate(() => (window as any).__previewChanges());
  expect(before.files[0].hunks.length).toBeGreaterThan(0);
  expect(await action(page, 'stage', true)).toEqual({ ok: true });
  await expect.poll(async () => (await calls(page, 'git_stage')).length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__previewChanges().pending)).toBe(false);
  expect(await page.evaluate(() => (window as any).__previewChangesAction((window as any).__capturedChangesAction))).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await calls(page, 'git_stage'))[0].args.paths).toHaveLength(1);
  expect(await action(page, 'scope-staged')).toEqual({ ok: true });
  await expect(page.locator('.cv-file')).toHaveCount(1);
  const props = await page.evaluate(() => (window as any).__previewChanges()); expect(props.scope).toBe('staged'); expect(props.files[0].staged).toBe(true);
  expect(await page.evaluate(() => {
    const props = (window as any).__previewChanges(), file = props.files[0];
    return (window as any).__previewChangesAction({ contractVersion: 1, context: props.context, repository: props.repository, revision: props.revision, fileId: file.id, diffId: file.diffId, fileRevision: file.revision, hunkId: 'old-hunk', hunkRevision: 0, controlId: 'stage-hunk', requestId: 'hunk' });
  })).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await calls(page, 'git_stage')).length).toBe(1);
});
test('diff: pending commit survives disable and safe recovery with its staged scope and no duplicate mutation', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await menu(page, 'Stage all');
  await expect.poll(() => page.evaluate(() => (window as any).__previewChanges().pending)).toBe(false);
  await menu(page, 'Commit…'); const input = page.getByRole('textbox', { name: 'Commit message', exact: true }); await input.fill('One pending commit');
  const form = await page.locator('.cv-commit').elementHandle();
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'git_commit'; });
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__extensionsBaseline.releaseCommand))).toBe(true);
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.diff', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  expect(await form!.evaluate(node => node === document.querySelector('.cv-commit'))).toBe(true);
  await expect(input).toHaveValue('One pending commit'); await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  expect((await calls(page, 'git_commit')).length).toBe(1);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect(page.locator('.cv-state-clean')).toContainText('Working tree clean');
  expect((await calls(page, 'git_commit')).length).toBe(1);
});
test('diff: conflicting/future providers and controlled fault retain diff identity, focus, selection and recovery', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.diff'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.diff/commit' }] };
  const future = structuredClone(other); future.id = 'future.diff'; future.contributes.components[0].id = 'future.diff/commit'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  const region = await explorer(page); await expect(region.getByLabel('Changes presentation', { exact: true })).toHaveValue('');
  await expect(region.locator('option[value="future.diff/commit"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Changes presentation', { exact: true }).selectOption('sample.diff/commit'); await back(page);
  const viewer = await page.locator('.diff-viewer').first().elementHandle();
  await page.getByRole('button', { name: 'Wrap lines', exact: true }).first().click();
  await page.locator('.diff-viewer-content').first().focus();
  const before = await page.evaluate(() => (window as any).__previewChanges());
  await page.evaluate(async () => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.cv-name')!); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const api = await (window as any).__previewReplacementModules(); api.applyChangesPresentation(document.querySelector('.changes-view'), () => { throw Error('controlled diff fault'); });
  });
  await expect(page.locator('[data-changes-provider]')).toHaveCount(0);
  await expect(page.locator('.diff-viewer-content').first()).toBeFocused();
  expect(await page.evaluate(() => getSelection()?.toString())).toBeTruthy();
  expect(await viewer!.evaluate(node => node === document.querySelector('.diff-viewer'))).toBe(true);
  const after = await page.evaluate(() => (window as any).__previewChanges());
  expect(after.files.map((file: any) => [file.id, file.diffId, file.hunks])).toEqual(before.files.map((file: any) => [file.id, file.diffId, file.hunks])); expect(after.selected).toBe(before.selected);
  await expect(page.getByRole('button', { name: 'Wrap lines', exact: true, includeHidden: true }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-changes-presentation-status]')).toContainText('Built-in diff remains active');
});
test('diff: loading/error retry and offline state are bounded and never stage implicitly', async ({ page }) => {
  await setup(page, [manifest], true); await select(page);
  await expect(page.locator('.cv-error')).toContainText('Baseline rejected git_diff');
  let region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.changes.file');
  await region.getByRole('button', { name: 'Hide Retry diff', exact: true }).click(); await back(page);
  await expect(page.locator('.cv-error').getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
  region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.changes.file');
  await region.getByRole('button', { name: 'Show Retry diff', exact: true }).click(); await back(page);
  await page.locator('.cv-error').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.cv-error')).toHaveCount(0);
  await expect(page.locator('.diff-viewer').first()).toHaveAttribute('data-diff-state', /ready|fallback/);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); dispatchEvent(new Event('offline')); });
  expect(await action(page, 'stage-all')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect((await calls(page, 'git_stage')).length).toBe(0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); dispatchEvent(new Event('online')); (window as any).__extensionsBaseline.failOnce = 'git_diff'; });
  await page.getByRole('button', { name: 'Refresh project', exact: true }).click();
  await expect(page.locator('.diff-viewer').first()).toBeVisible();
  expect((await calls(page, 'git_stage')).length).toBe(0);
});
test('diff: loading retains bounded state and A-to-B switch never retargets a pending stage', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'git_diff'; });
  expect(await action(page, 'stage', true)).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__extensionsBaseline.releaseCommand))).toBe(true);
  const loading = await page.evaluate(() => (window as any).__previewChanges());
  expect(loading.files.some((file: any) => file.load === 'loading')).toBe(true);
  expect(JSON.stringify(loading).length).toBeLessThan(262144);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(() => page.evaluate(() => (window as any).__previewChanges().files.every((file: any) => file.load === 'loaded'))).toBe(true);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'git_stage'; });
  expect(await action(page, 'unstage', true)).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__extensionsBaseline.releaseCommand))).toBe(true);
  const stageCalls = await calls(page, 'git_stage'); expect(stageCalls).toHaveLength(2); expect(stageCalls[1].args.sessionId).toBe('session-1');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect.poll(() => page.evaluate(previous => (window as any).__previewChanges()?.repository ?? previous, loading.repository)).not.toBe(loading.repository);
  expect(await page.evaluate(() => (window as any).__previewChangesAction((window as any).__capturedChangesAction))).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(() => page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand === undefined)).toBe(true);
  expect((await calls(page, 'git_stage')).length).toBe(2);
  expect((await calls(page, 'git_commit')).length).toBe(0);
});
