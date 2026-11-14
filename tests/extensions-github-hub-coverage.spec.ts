import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/github-hub/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewGithubHub());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&github-hub-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page) { await page.locator('#view-menu').click(); await page.getByRole('menuitemradio', { name: 'GitHub', exact: true }).click(); await expect(page.locator('.gh-thread')).toHaveCount(3); await expect.poll(async () => (await props(page))?.loading).toBe(false); }
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('GitHub hub presentation', { exact: true }).selectOption('sample.github-hub/tabs'); await back(page); await expect(page.locator('[data-github-hub-provider]')).toBeVisible(); }
async function act(page: Page, controlId: string, title = '', value = '', changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, title, value, changes }) => {
    const p = (window as any).__previewGithubHub(), rows = p.rows.filter((row: any) => row.title === title);
    const control = p.controls.find((control: any) => control.controlId === controlId && (!title || rows.some((row: any) => control.resource === row.id)));
    if (!control) throw Error(`Missing ${controlId}/${title}`);
    const action = { contractVersion: 1, window: 'main', context: p.context, repository: p.repository, project: p.project, tab: p.tab, revision: p.revision, control: control.id, controlId, resource: control.resource, attempt: control.attempt, value, requestId: crypto.randomUUID(), ...changes };
    (window as any).__capturedGithubHub = action; return (window as any).__previewGithubHubAction(action);
  }, { controlId, title, value, changes });
}
const idle = (page: Page) => expect.poll(async () => (await props(page)).busy).toBe(false);
const allow = (page: Page) => page.getByRole('button', { name: 'Allow GitHub task control for sample.github-hub', exact: true }).click();
test('GitHub hub extension: discovery/install/enable never fetches or signs in; selected original state/actions/context', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.github-hub', exact: true }).click();
  expect(await calls(page, 'github_repos')).toHaveLength(0);
  await expect(region.getByLabel('GitHub hub presentation')).toHaveValue(''); await region.getByLabel('GitHub hub presentation').selectOption('sample.github-hub/tabs'); await back(page); await open(page);
  await expect(page.locator('.gh-bar')).toHaveCSS('order', '-1'); expect((await props(page)).rows.some((row: any) => row.title === 'orbit-labs/orbit')).toBe(true);
  expect(await act(page, 'query', '', 'shortcuts')).toEqual({ ok: true }); await expect(page.getByRole('searchbox', { name: 'Search this tab' })).toHaveValue('shortcuts');
  const search = page.getByRole('searchbox', { name: 'Search this tab' }); await search.focus(); await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menuitem', { name: 'GitHub tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(search).toBeFocused();
  expect(await act(page, 'refresh')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'github_repos').then(calls => calls.length)).toBe(2);
  expect(await calls(page, 'github_clone_repo')).toHaveLength(0); expect(await calls(page, 'github_login')).toHaveLength(0);
});
test('GitHub hub extension: zero extensions preserve original fixture, metadata withheld and no automatic provider', async ({ page }) => {
  await setup(page); await open(page); expect((await props(page)).rows.every((row: any) => row.title === '')).toBe(true); await expect(page.locator('[data-github-hub-provider]')).toHaveCount(0);
  await page.getByRole('tab', { name: /^Actions/ }).click(); await page.locator('[data-gh-run="9087"]').hover(); await page.locator('[data-gh-run="9087"] [data-gh-run-toggle]').click(); await expect(page.locator('#gh-run-9087')).toContainText('Earlier attempts');
  await page.locator('[data-gh-run="9087"]').hover(); await page.locator('[data-gh-run="9087"] [data-gh-run-toggle]').click(); await page.locator('[data-gh-run="9087"]').hover(); await page.locator('[data-gh-run="9087"] [data-gh-run-toggle]').click(); expect(await calls(page, 'github_run_details')).toHaveLength(1);
});
test('GitHub hub extension: consented review/solve/fix/workflow use original task handlers, no external mutation', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  await page.getByRole('tab', { name: /^Issues/ }).click(); expect(await act(page, 'solve', 'Search index rebuilds on every keystroke')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'solve', 'Search index rebuilds on every keystroke')).toEqual({ ok: true }); await idle(page); await expect(page.locator('#transcript .user-message').last()).toContainText('Fix issue #128');
  await page.getByRole('button', { name: 'Close task details', exact: true }).click(); await page.getByRole('tab', { name: /^Pull requests/ }).click();
  expect(await act(page, 'review', 'Debounce library search and cache the index')).toEqual({ ok: true }); await idle(page); await expect(page.locator('#transcript .user-message').last()).toContainText('#130'); await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await page.getByRole('tab', { name: /^Actions/ }).click(); expect(await act(page, 'fix', 'Fix dark mode contrast for muted text')).toEqual({ ok: true }); await idle(page); await expect(page.locator('#transcript .user-message').last()).toContainText('9087'); await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  expect(await act(page, 'workflow')).toEqual({ ok: true }); await idle(page); await expect(page.locator('#transcript .user-message').last()).toContainText('.github/workflows');
  expect(await calls(page, 'github_clone_repo')).toHaveLength(0); expect(await calls(page, 'create_session')).toHaveLength(4);
});
test('GitHub hub extension: details loading, no duplicate expansion request, filters and recovery preserve state/focus', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await page.getByRole('tab', { name: /^Actions/ }).click();
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'github_run_details'; });
  expect(await act(page, 'details', 'Fix dark mode contrast for muted text')).toEqual({ ok: true });
  await expect.poll(async () => (await props(page)).rows.find((row: any) => row.title === 'Fix dark mode contrast for muted text' && row.kind === 'run')?.loading).toBe(true);
  expect(await act(page, 'details', 'Fix dark mode contrast for muted text')).toEqual({ ok: true }); expect(await act(page, 'details', 'Fix dark mode contrast for muted text')).toEqual({ ok: true }); expect(await calls(page, 'github_run_details')).toHaveLength(1);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(page.locator('#gh-run-9087')).toContainText('Earlier attempts');
  expect(await act(page, 'query', '', 'contrast')).toEqual({ ok: true }); const before = await props(page), search = page.getByRole('searchbox', { name: 'Search this tab' }); await search.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(search).toBeFocused(); await expect(page.locator('#gh-run-9087')).toContainText('Earlier attempts');
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.github-hub', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-github-hub-provider]')).toHaveCount(0); await expect(search).toHaveValue('contrast'); expect((await props(page)).repository).toBe(before.repository); expect((await props(page)).tab).toBe('actions'); await expect(page.locator('#gh-run-9087')).toContainText('Earlier attempts'); expect(await calls(page, 'github_run_details')).toHaveLength(1);
});
test('GitHub hub extension: selected conflict/future/fault/revocation/offline and captured repository cannot retarget', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.github-hub'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.github-hub/tabs' }] };
  const future = structuredClone(other); future.id = 'future.github-hub'; future.contributes.components[0].id = 'future.github-hub/tabs'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); await open(page); const region = await explorer(page); await expect(region.getByLabel('GitHub hub presentation')).toHaveValue(''); await expect(region.locator('option[value="future.github-hub/tabs"]')).toHaveAttribute('disabled', ''); await back(page); await select(page);
  expect(await act(page, 'query', '', 'CI', { repository: 'foreign' })).toEqual({ ok: false, reason: 'StaleContext' });
  await page.context().setOffline(true); expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Offline' }); await page.context().setOffline(false);
  expect(await act(page, 'query', '', 'CI')).toEqual({ ok: true }); await page.evaluate(() => { (window as any).__staleGithubHub = (window as any).__capturedGithubHub; });
  await page.locator('[data-gh-repo="orbit-labs/orbit-api"]').click(); expect(await page.evaluate(() => (window as any).__previewGithubHubAction((window as any).__staleGithubHub))).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyGithubHubPresentation(document.querySelector('#github-hub'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-github-hub-presentation-status]')).toContainText('Built-in hub remains active'); expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.getByRole('heading', { name: 'orbit-labs/orbit-api', exact: true })).toBeVisible(); expect(await calls(page, 'create_session')).toHaveLength(0);
});
test('GitHub hub extension: pending task stays on A through repo B, disable and recovery', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await page.getByRole('tab', { name: /^Issues/ }).click(); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'create_session'; });
  expect(await act(page, 'solve', 'Search index rebuilds on every keystroke')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'create_session').then(calls => calls.length)).toBe(1);
  expect(await act(page, 'solve', 'Search index rebuilds on every keystroke')).toEqual({ ok: false, reason: 'Busy' }); await page.locator('[data-gh-repo="orbit-labs/orbit-api"]').click(); const repository = (await props(page)).repository;
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.github-hub', exact: true }).click(); await back(page); await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await idle(page);
  expect((await props(page)).repository).toBe(repository); await expect(page.getByRole('heading', { name: 'orbit-labs/orbit-api', exact: true })).toBeVisible(); expect((await calls(page, 'create_session'))[0].args.projectId).toBe('project-1'); expect(await calls(page, 'create_session')).toHaveLength(1);
});
test('GitHub hub extension: external and clone entries require fresh original host user choice', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page);
  expect(await act(page, 'open')).toEqual({ ok: true }); await expect(page.getByRole('menuitemradio', { name: 'Continue with original GitHub action', exact: true })).toBeVisible(); expect(await calls(page, 'open_external_url')).toHaveLength(0); await page.keyboard.press('Escape');
  await page.locator('[data-gh-repo="you/meadow"]').click(); expect(await act(page, 'clone')).toEqual({ ok: true }); expect(await calls(page, 'github_clone_repo')).toHaveLength(0); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clone repository', exact: true }).click(); await expect.poll(() => calls(page, 'github_clone_repo').then(calls => calls.length)).toBe(1); await idle(page); expect((await calls(page, 'github_clone_repo'))[0].args.repo).toBe('you/meadow');
});
test('GitHub hub extension: original clone pending survives repository switch and disable without cross-repo delivery', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await page.locator('[data-gh-repo="you/meadow"]').click();
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'github_clone_repo'; });
  await page.getByRole('button', { name: 'Clone repository', exact: true }).click(); await expect.poll(() => calls(page, 'github_clone_repo').then(calls => calls.length)).toBe(1);
  expect(await act(page, 'refresh')).toEqual({ ok: false, reason: 'Busy' }); await page.locator('[data-gh-repo="orbit-labs/orbit-api"]').click(); const selected = (await props(page)).repository;
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.github-hub', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await idle(page); expect((await props(page)).repository).toBe(selected);
  expect(await calls(page, 'github_clone_repo')).toHaveLength(1); expect((await calls(page, 'github_clone_repo'))[0].args.repo).toBe('you/meadow');
  await expect(page.getByRole('heading', { name: 'orbit-labs/orbit-api', exact: true })).toBeVisible(); await expect(page.locator('.gh-head [data-gh="clone"]')).toBeEnabled();
});
test('GitHub hub extension: compatible sibling order, filters and safe recovery', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await page.getByRole('tab', { name: /^Actions/ }).click();
  expect(await act(page, 'event', '', 'schedule')).toEqual({ ok: true }); expect(await act(page, 'latest', '', 'true')).toEqual({ ok: true });
  const before = await props(page); expect(JSON.parse(before.filter)).toMatchObject({ event: 'schedule', latest: true });
  expect(await act(page, 'event', '', 'forged')).toEqual({ ok: false, reason: 'InvalidArguments' }); expect(await act(page, 'latest', '', 'forged')).toEqual({ ok: false, reason: 'InvalidArguments' });
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.githubHub.controls');
  const next = region.getByRole('button', { name: 'Next items', exact: true });
  await region.getByRole('button', { name: 'Grant UI customization and select Fix before details', exact: true }).click();
  await back(page);
  expect(await page.locator('[data-gh-run="9060"] .gh-actions').evaluate(node => [...node.children].map(item => (item as HTMLElement).hasAttribute('data-gh-run-fix') ? 'fix' : (item as HTMLElement).hasAttribute('data-gh-run-toggle') ? 'details' : 'open'))).toEqual(['fix', 'details', 'open']);
  await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.githubHub.controls');
  for (let cursor = 0; cursor < 5 && !await region.getByRole('button', { name: 'Hide Fix workflow run', exact: true }).count(); cursor++) await next.click();
  await region.getByRole('button', { name: 'Hide Fix workflow run', exact: true }).click(); await back(page); await expect(page.locator('[data-gh-run-fix]').first()).toBeHidden();
  expect((await props(page)).repository).toBe(before.repository); expect(JSON.parse((await props(page)).filter)).toMatchObject({ event: 'schedule', latest: true });
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-gh-run-fix]').first()).toBeVisible(); await expect(page.locator('.gh-bar')).toHaveCSS('order', '0');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(page.locator('[data-gh-run-fix]').first()).toBeVisible();
});
for (let index = 0; index < 5; index++) test(`GitHub hub extension: reversible catalog member page ${index + 1} of 5`, async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.githubHub.controls');
  for (let cursor = 0; cursor < index; cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  const buttons = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: /^Hide / });
  await expect(buttons).toHaveCount(index === 4 ? 2 : 5);
  for (const button of await buttons.all()) { const label = (await button.innerText()).replace(/^Hide /, ''); await button.click(); await region.getByRole('button', { name: `Show ${label}`, exact: true }).click(); }
});
test('GitHub hub extension: bounded detail errors and captured attempt revision never duplicate or retarget loads', async ({ page }) => {
  await setup(page, [manifest]); await open(page); await select(page); await page.getByRole('tab', { name: /^Actions/ }).click();
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'github_run_details'; });
  expect(await act(page, 'details', 'Fix dark mode contrast for muted text')).toEqual({ ok: true }); await expect(page.locator('#gh-run-9087')).toContainText('Couldn’t load jobs');
  const p = await props(page), row = p.rows.find((row: any) => row.kind === 'run' && row.attempt === 2); expect(row.error).toBe(true); expect(row.expanded).toBe(true);
  expect(await act(page, 'details', 'Fix dark mode contrast for muted text', '', { attempt: 1 })).toEqual({ ok: false, reason: 'StaleContext' });
  await page.locator('[data-gh-repo="orbit-labs/orbit-api"]').click(); await page.locator('[data-gh-repo="orbit-labs/orbit"]').click();
  await expect(page.locator('#gh-run-9087')).toContainText('Couldn’t load jobs'); expect(await calls(page, 'github_run_details')).toHaveLength(1);
});
