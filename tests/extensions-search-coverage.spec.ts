import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/search/extension.json', import.meta.url), 'utf8'));
const input = (page: Page) => page.getByRole('searchbox', { name: 'Search in files' });
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&search-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  if (await page.locator('#inspector-toggle').getAttribute('aria-pressed') === 'false') await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'Search'); await page.locator('[data-view="search"] [role="tab"]').click();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
const props = (page: Page) => page.evaluate(() => (window as any).__previewSearch());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function search(page: Page) { await input(page).fill('search'); await expect(page.locator('.search-line').first()).toBeVisible(); }
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Search presentation', { exact: true }).selectOption('sample.search/results'); await back(page); }
async function action(page: Page, controlId: string, result = false, value = '') {
  return page.evaluate(({ controlId, result, value }) => {
    const p = (window as any).__previewSearch();
    const a = { contractVersion: 1, context: p.context, project: p.project, revision: p.revision, query: p.query, resultId: result ? p.results[0].id : '', controlId, value, requestId: crypto.randomUUID() };
    (window as any).__capturedSearch = a; return (window as any).__previewSearchAction(a);
  }, { controlId, result, value });
}
test('search: zero extensions preserve typing, IME, keyboard, original query/options and result navigation', async ({ page }) => {
  await setup(page); await expect(input(page)).toBeFocused();
  await input(page).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await input(page).fill('sea');
  await input(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  expect(await calls(page, 'search_text')).toHaveLength(0);
  await input(page).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await input(page).fill('search'); await expect(page.locator('.search-line').first()).toBeVisible();
  expect((await calls(page, 'search_text')).map((call: any) => call.args.query)).toEqual(['search']);
  await expect(page.locator('[data-search-provider]')).toHaveCount(0);
  const group = page.locator('.search-group-title').first(); await group.focus(); await page.keyboard.press('Enter'); await expect(group).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter'); await expect(group).toHaveAttribute('aria-expanded', 'true');
  const line = page.locator('.search-line').first(), path = await line.getAttribute('data-search-open');
  await line.focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await calls(page, 'read_file')).at(-1)?.args.path).toBe(path);
});
test('search: local install/selection, controls/context/layout and results-first move retain the same input and requests', async ({ page }) => {
  await setup(page); await search(page); const field = await input(page).elementHandle(); const before = await calls(page, 'search_text');
  let region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.search', exact: true }).click();
  await region.getByLabel('Search presentation', { exact: true }).selectOption('sample.search/results');
  await region.getByRole('button', { name: 'Grant UI customization and select Regex before case', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.search.controls');
  await region.getByRole('button', { name: 'Hide Match whole word', exact: true }).click(); await back(page);
  await expect(page.locator('[data-search-provider="sample.search/results"]')).toBeVisible();
  expect(await page.locator('.search-results').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  await expect(page.getByRole('button', { name: 'Match whole word', exact: true })).toBeHidden();
  expect(await page.locator('.search-toggles > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-search-toggle')))).toEqual(['wholeWord', 'regex', 'matchCase']);
  expect(await field!.evaluate(node => node === document.querySelector('.search-input'))).toBe(true);
  expect(await calls(page, 'search_text')).toHaveLength(before.length);
  await page.getByRole('button', { name: 'Search tools', exact: true }).click(); await expect(page.locator('#toast')).toContainText('original host query');
  await page.locator('.search-line').first().click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Search tools', exact: true }).click(); await expect(page.locator('#toast')).toContainText('original host query');
  region = await explorer(page); await page.getByRole('button', { name: 'Disable sample.search', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  expect(await field!.evaluate(node => node === document.querySelector('.search-input'))).toBe(true);
  await expect(input(page)).toHaveValue('search'); expect(await calls(page, 'search_text')).toHaveLength(before.length);
  expect(await page.locator('.search-results').evaluate(node => getComputedStyle(node).order)).toBe('0');
});
test('search: captured actions use original handlers, reject stale query/project/result and preserve selection', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await search(page);
  expect(await action(page, 'collapse', true)).toEqual({ ok: true });
  const p = await props(page); expect(p.results[0].collapsed).toBe(true);
  expect(await action(page, 'open', true)).toEqual({ ok: true });
  await expect.poll(async () => (await calls(page, 'read_file')).at(-1)?.args.path).toBe(p.results[0].path);
  await page.locator('[data-view="search"] [role="tab"]').click();
  const selected = (await props(page)).selected; expect(selected).toBeTruthy();
  expect(await action(page, 'query', false, 'new query')).toEqual({ ok: true });
  await expect(page.locator('.search-line')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__previewSearchAction((window as any).__capturedSearch))).toEqual({ ok: false, reason: 'StaleContext' });
  await expect(input(page)).toHaveValue('new query');
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await page.evaluate(() => (window as any).__previewSearchAction((window as any).__capturedSearch))).toEqual({ ok: false, reason: 'StaleContext' });
});
test('search: delayed old delivery is suppressed immediately when query or checkout changes', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'search_text'; });
  await input(page).fill('old-query'); await expect.poll(() => page.evaluate(() => Boolean((window as any).__extensionsBaseline.releaseCommand))).toBe(true);
  await input(page).fill('search');
  await expect(page.locator('.search-line')).toHaveCount(0);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect(page.locator('.search-line').first()).toBeVisible();
  expect((await props(page)).query).toBe('search'); expect((await calls(page, 'search_text')).map((call: any) => call.args.query)).toEqual(['old-query', 'search']);
  const captured = await props(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'search_text'; });
  await input(page).fill('checkout-query'); await expect.poll(() => page.evaluate(() => Boolean((window as any).__extensionsBaseline.releaseCommand))).toBe(true);
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(async () => (await props(page)).project).not.toBe(captured.project);
  expect((await calls(page, 'search_text')).filter((call: any) => call.args.query === 'checkout-query' && call.args.sessionId === 'session-1')).toHaveLength(1);
});
test('search: conflicts/future/fault and disable recover query/caret without remount or duplicate searches', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.search'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.search/results' }] };
  const future = structuredClone(other); future.id = 'future.search'; future.contributes.components[0].id = 'future.search/results'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); await search(page);
  const region = await explorer(page); await expect(region.getByLabel('Search presentation', { exact: true })).toHaveValue('');
  await expect(region.locator('option[value="future.search/results"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Search presentation', { exact: true }).selectOption('sample.search/results'); await back(page);
  const field = await input(page).elementHandle(), before = await calls(page, 'search_text'); await input(page).focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySearchPresentation(document.querySelector('.search-panel'), () => { throw Error('controlled fault'); }); });
  await expect(input(page)).toBeFocused(); await expect(input(page)).toHaveValue('search');
  await expect(page.locator('[data-search-presentation-status]')).toContainText('Built-in search remains active');
  expect(await field!.evaluate(node => node === document.querySelector('.search-input'))).toBe(true); expect(await calls(page, 'search_text')).toHaveLength(before.length);
  expect(await action(page, 'query', false, 'forbidden')).toEqual({ ok: false, reason: 'Revoked' });
});
test('search: metadata permission is independent and unknown cursor explicitly requires resync', async ({ page }) => {
  const denied = structuredClone(manifest); denied.permissions = ['ui.contribute']; denied.contributes.layouts = [];
  await setup(page, [denied]); await select(page); await search(page);
  expect(await page.evaluate(() => (window as any).__previewSearchPage())).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await action(page, 'open', true)).toEqual({ ok: false, reason: 'PermissionDenied' });
});
test('search: hiding the query control is presentation only and does not revoke structured options', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await search(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.search.controls');
  await region.getByRole('button', { name: 'Hide Search query', exact: true }).click(); await back(page);
  await expect(input(page)).toBeHidden();
  expect(await action(page, 'wholeWord')).toEqual({ ok: true });
  await expect.poll(async () => (await calls(page, 'search_text')).at(-1)?.args.wholeWord).toBe(true);
  await expect(page.getByRole('button', { name: 'Match whole word', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('search: bounded metadata pages, stale cursors and invalid regex errors are explicit', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await input(page).fill('paged-fixture'); await expect(page.locator('.search-line')).toHaveCount(130);
  const first = await page.evaluate(() => (window as any).__previewSearchPage()); expect(first.ok).toBe(true); expect(first.value.results.length).toBeLessThanOrEqual(64);
  expect(first.value.next).toBeTruthy();
  const collected = await page.evaluate(() => {
    const ids: string[] = []; let cursor = '';
    do { const page = (window as any).__previewSearchPage(cursor); ids.push(...page.value.results.map((item: any) => item.id)); cursor = page.value.next; } while (cursor);
    return ids;
  }); expect(collected).toHaveLength(260); expect(new Set(collected).size).toBe(260);
  expect(JSON.stringify(first)).not.toContain('ranges');
  expect(await page.evaluate(() => (window as any).__previewSearchPage('forged'))).toEqual({ ok: false, reason: 'ResyncRequired' });
  expect(await action(page, 'regex')).toEqual({ ok: true }); await input(page).fill('(unclosed');
  expect(await page.evaluate(cursor => (window as any).__previewSearchPage(cursor), first.value.next)).toEqual({ ok: false, reason: 'ResyncRequired' });
  await expect(page.locator('.search-error')).toContainText('Invalid regular expression'); expect((await props(page)).error).toBe(true);
});
