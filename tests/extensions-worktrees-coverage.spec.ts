import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: every git/worktree command is the in-memory preview; no real checkout is created or removed.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/worktree/extension.json', import.meta.url), 'utf8'));
const MUTATIONS = ['git_switch_branch', 'create_worktree', 'attach_worktree', 'remove_worktree', 'merge_worktree', 'recreate_worktree'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewWorktree());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const mutations = (page: Page) => page.evaluate(names => (window as any).__extensionsBaseline.calls.filter((call: any) => names.includes(call.command)).length, MUTATIONS);
const chip = (page: Page) => page.locator('#branch-chip');
const bar = (page: Page) => page.locator('#composer-context');
const menu = (page: Page) => page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
const dialog = (page: Page) => page.locator('#dialog');
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&worktree-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(chip(page)).toContainText('feat/instant-search'); await expect.poll(async () => (await props(page))?.checkout).toBe('local');
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page, id = 'sample.worktree/branch-first') { const region = await explorer(page); await region.getByLabel('Branch and worktree presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator(`#composer-context[data-worktree-provider="${id}"]`)).toBeVisible(); }
/** Builds a captured action from the live presentation. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, changes }) => {
    const p = (window as any).__previewWorktree(), control = p.controls.find((control: any) => control.controlId === controlId);
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, repository: p.repository, branch: p.branch, base: p.base, worktree: p.worktree, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewWorktreeAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, changes));
async function allow(page: Page) {
  await chip(page).click(); await menu(page).getByRole('menuitem', { name: /Allow branch and worktree control for sample\.worktree/ }).click(); await expect(menu(page)).toBeHidden();
  await chip(page).click(); await expect(menu(page).getByRole('menuitem', { name: /Revoke branch and worktree control for sample\.worktree/ })).toBeVisible(); await page.keyboard.press('Escape');
}
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
async function worktreeTask(page: Page, branch: string) {
  await page.locator('.new-task-button').click(); await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await dialog(page).getByRole('textbox', { name: 'Branch name', exact: true }).fill(branch);
  await dialog(page).getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(dialog(page)).toBeHidden(); await expect(chip(page)).toContainText(`pandacode/${branch}`);
  await expect.poll(async () => (await props(page)).checkout).toBe('worktree');
}

test('Worktree extension: discovery/install/enable never touches git; selected branch-first state uses original handlers', async ({ page }) => {
  await setup(page); const branches = (await calls(page, 'git_branches')).length; const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.worktree', exact: true }).click();
  await expect(region.getByLabel('Branch and worktree presentation')).toHaveValue(''); await region.getByLabel('Branch and worktree presentation').selectOption('sample.worktree/branch-first'); await back(page);
  expect(await mutations(page)).toBe(0); expect(await calls(page, 'git_branches')).toHaveLength(branches); expect(await calls(page, 'worktree_status')).toHaveLength(0);
  await expect(chip(page)).toHaveCSS('order', '1'); await expect(bar(page).locator('.composer-local')).toHaveCSS('order', '2');
  const p = await props(page);
  expect(p).toMatchObject({ checkout: 'local', branchName: 'feat/instant-search', visible: true, busy: false, pending: 'none', form: 'none', cleanup: 'none', linked: { issue: true, pull: true } });
  expect(p.controls.map((control: any) => control.controlId)).toEqual(['branch-menu', 'switch-default', 'switch-other', 'worktree-new', 'copy-path', 'open-pull', 'open-url']);
  expect(await act(page, 'branch-menu')).toEqual({ ok: true });
  await expect(menu(page).getByRole('menuitem', { name: /New task in a worktree/ })).toBeVisible(); await expect(menu(page).getByRole('menuitem', { name: 'Branch tools', exact: true })).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Branch tools', exact: true }).click(); await expect(page.locator('#toast')).toContainText('ownership stays with PandaCode');
  await chip(page).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Branch tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(chip(page)).toBeFocused();
  expect(await mutations(page)).toBe(0); expect((await props(page)).base).not.toBe('');
});

test('Worktree extension: zero extensions keep the original controls, withhold metadata and select nothing', async ({ page }) => {
  await setup(page); const p = await props(page);
  expect(p.branchName).toBe(''); await expect(page.locator('[data-worktree-provider]')).toHaveCount(0); await expect(chip(page)).toHaveCSS('order', '0');
  expect(await act(page, 'switch-other')).toEqual({ ok: false, reason: 'Revoked' });
  await chip(page).click(); await expect(menu(page).getByRole('menuitem', { name: /branch and worktree control/ })).toHaveCount(0);
  await menu(page).getByRole('menuitem', { name: /Switch to main/ }).click(); await expect(chip(page)).toContainText('main');
  expect(await calls(page, 'git_switch_branch')).toHaveLength(1);
});

test('Worktree extension: switching needs consent and a fresh choice; stale, replayed and forged requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const stale = await action(page, 'switch-other');
  expect(await act(page, 'switch-default')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'switch-other', { controlId: 'worktree-confirm' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'switch-other', { branchName: 'main' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  const request = await action(page, 'switch-default');
  expect(await send(page, request)).toEqual({ ok: true }); expect(await calls(page, 'git_switch_branch')).toHaveLength(0);
  await proceed(page, 'Switch to the main branch');
  await expect(chip(page)).toContainText('main'); expect(await calls(page, 'git_switch_branch')).toHaveLength(1);
  expect((await calls(page, 'git_switch_branch'))[0].args).toMatchObject({ sessionId: 'session-1', branch: 'main' });
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'switch-other')).toEqual({ ok: true }); await expect(page.getByRole('dialog', { name: 'Switch branch', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); expect(await calls(page, 'git_switch_branch')).toHaveLength(1);
});

test('Worktree extension: a pending switch on A is exclusive and never applies to B', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'git_switch_branch'; });
  expect(await act(page, 'switch-default')).toEqual({ ok: true }); await proceed(page, 'Switch to the main branch');
  await expect.poll(async () => (await props(page)).pending).toBe('switch');
  const a = await action(page, 'switch-other'); expect(await send(page, a)).toEqual({ ok: false, reason: 'Busy' });
  await chip(page).click(); await menu(page).getByRole('menuitem', { name: /Switch to main/ }).click(); await expect(page.locator('#toast')).toContainText('Wait for the current branch action to finish');
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  expect(await send(page, a)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(page.locator('#toast')).toContainText('Switched to main');
  expect(await calls(page, 'git_switch_branch')).toHaveLength(1); expect((await calls(page, 'git_switch_branch'))[0].args.sessionId).toBe('session-1');
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2'); expect((await props(page)).pending).toBe('none');
});

test('Worktree extension: the create form keeps its inputs and creates once through fault, disable and safe mode', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'worktree-new')).toEqual({ ok: true }); await expect(dialog(page).getByRole('heading', { name: 'New task in a worktree' })).toBeVisible();
  const input = dialog(page).getByRole('textbox', { name: 'Branch name', exact: true }); await input.fill('extension-form');
  await expect.poll(async () => (await props(page)).form).toBe('new'); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'switch-other')).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyWorktreePresentation(document.querySelector('#composer-context'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'switch-other')).toEqual({ ok: false, reason: 'Revoked' });
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.worktree')); await expect(page.locator('[data-worktree-provider]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__previewWorktreeSafeMode());
  await expect(input).toHaveValue('extension-form'); await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  expect(await mutations(page)).toBe(0);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'create_worktree'; });
  const submit = dialog(page).getByRole('button', { name: 'Create worktree task', exact: true });
  await submit.click(); await expect.poll(() => calls(page, 'create_worktree').then(calls => calls.length)).toBe(1);
  // The host disables its button; a forged second submission is ignored by the single-operation guard.
  await dialog(page).locator('#worktree-form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Worktree task created'); await expect(chip(page)).toContainText('pandacode/extension-form');
  expect(await calls(page, 'create_worktree')).toHaveLength(1); expect((await calls(page, 'create_worktree'))[0].args).toMatchObject({ sessionId: 'session-1', branch: 'extension-form' });
});

test('Worktree extension: the cleanup offer stays host-confirmed; cancel needs consent, remove runs once', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await worktreeTask(page, 'cleanup-offer');
  expect(await act(page, 'worktree-remove')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'worktree-remove')).toEqual({ ok: true }); await expect(dialog(page).getByRole('heading', { name: 'Remove worktree' })).toBeVisible();
  await expect.poll(async () => (await props(page)).cleanup).toBe('remove'); expect(await act(page, 'worktree-merge')).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'cleanup-cancel', { controlId: 'cleanup-confirm' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'cleanup-cancel')).toEqual({ ok: true }); await expect(dialog(page)).toBeHidden();
  expect(await calls(page, 'remove_worktree')).toHaveLength(0); expect((await props(page)).cleanup).toBe('none');
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.worktree.protected');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button')).toHaveCount(0); await back(page);
  expect(await act(page, 'worktree-remove')).toEqual({ ok: true });
  await dialog(page).getByRole('button', { name: 'Remove and settle', exact: true }).click(); await expect(dialog(page)).toBeHidden();
  await expect.poll(() => calls(page, 'remove_worktree').then(calls => calls.length)).toBe(1);
  expect((await calls(page, 'remove_worktree'))[0].args.deleteBranch).toBe(true); expect(await calls(page, 'merge_worktree')).toHaveLength(0);
});

test('Worktree extension: recovery rows stay pinned against forged overlays; recreate needs consent and a fresh choice', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await worktreeTask(page, 'vanish');
  await page.evaluate(() => (window as any).__previewWorktreeVanish(document.querySelector<HTMLElement>('#prompt')!.dataset.sessionId));
  await page.locator('.task-item[data-id="session-1"]').click(); await page.locator('.new-task-button').click();
  await expect(chip(page)).toContainText('Worktree missing'); await expect.poll(async () => (await props(page)).checkout).toBe('missing');
  expect((await props(page)).controls.map((control: any) => control.controlId)).toEqual(['branch-menu', 'worktree-recreate', 'settle-task']);
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.worktree.actions/worktree-recreate': false, 'panda.worktree.actions/settle-task': false, 'panda.worktree.actions/checkout': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await chip(page).click();
  for (const name of ['Recreate worktree', 'Settle task']) await expect(menu(page).getByRole('menuitem', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /Worktree missing|unknown branch|pandacode\/vanish/ }).first()).toBeVisible(); await page.keyboard.press('Escape');
  expect(await act(page, 'worktree-recreate')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'worktree-recreate')).toEqual({ ok: true }); expect(await calls(page, 'recreate_worktree')).toHaveLength(0);
  await proceed(page, 'Recreate the worktree'); await expect(page.locator('#toast')).toContainText('Worktree restored on pandacode/vanish');
  expect(await calls(page, 'recreate_worktree')).toHaveLength(1); await expect(chip(page)).toContainText('pandacode/vanish');
});

test('Worktree extension: linked pull opens in the inspector; the issue needs a fresh choice; offline refuses only network entries', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'open-pull')).toEqual({ ok: true }); await expect(page.locator('#inspector .pull-view .pull-title')).toHaveText('Debounce library search');
  expect(await act(page, 'open-url')).toEqual({ ok: true }); expect(await calls(page, 'open_external_url')).toHaveLength(0);
  await proceed(page, 'Open the linked issue on GitHub');
  await expect.poll(() => calls(page, 'open_external_url').then(calls => calls.length)).toBe(1); expect((await calls(page, 'open_external_url'))[0].args.url).toBe('https://github.com/orbit-labs/orbit/issues/41');
  await page.context().setOffline(true);
  expect(await act(page, 'open-url')).toEqual({ ok: false, reason: 'Offline' }); expect(await act(page, 'open-pull')).toEqual({ ok: false, reason: 'Offline' });
  expect(await act(page, 'branch-menu')).toEqual({ ok: true }); await expect(menu(page)).toBeVisible(); await page.keyboard.press('Escape');
  await page.context().setOffline(false);
});

test('Worktree extension: conflict and future providers never auto-select; forged identity is stale', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.worktree'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.worktree/branch-first' }] };
  const future = structuredClone(other); future.id = 'future.worktree'; future.contributes.components[0].id = 'future.worktree/branch-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Branch and worktree presentation')).toHaveValue(''); await expect(region.locator('option[value="future.worktree/branch-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(page.locator('[data-worktree-provider]')).toHaveCount(0);
  await select(page, 'other.worktree/branch-first'); await expect(chip(page)).toHaveCSS('order', '1');
  for (const field of ['project', 'task', 'repository', 'branch', 'base', 'worktree']) expect(await act(page, 'switch-other', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'switch-other', { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await mutations(page)).toBe(0);
});

test('Worktree extension: compatible menu order, reversible chip and row visibility, focus-safe recovery', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const rows = async () => { await chip(page).click(); const labels = await menu(page).getByRole('menuitem').evaluateAll(nodes => nodes.map(node => node.textContent?.trim() ?? '')); await page.keyboard.press('Escape'); return labels; };
  const index = (labels: string[], prefix: string) => labels.findIndex(label => label.startsWith(prefix));
  let labels = await rows(); expect(index(labels, 'Switch to main')).toBeLessThan(index(labels, 'Copy project path'));
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.worktree.actions');
  await region.getByRole('button', { name: 'Grant UI customization and select Copy path before switching', exact: true }).click();
  const next = region.getByRole('button', { name: 'Next items', exact: true });
  for (let cursor = 0; cursor < 3 && !await region.getByRole('button', { name: 'Hide Other branch', exact: true }).count(); cursor++) await next.click();
  await region.getByRole('button', { name: 'Hide Other branch', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.worktree.controls');
  await region.getByRole('button', { name: 'Hide Linked issue', exact: true }).click(); await back(page);
  labels = await rows(); expect(index(labels, 'Copy project path')).toBeLessThan(index(labels, 'Switch to main')); expect(index(labels, 'Other branch')).toBe(-1);
  await expect(bar(page).locator('.link-chip[data-action="open-url"]')).toBeHidden(); await expect(bar(page).locator('.link-chip[data-action="open-pull"]')).toBeVisible();
  await chip(page).focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(chip(page)).toBeFocused();
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(bar(page).locator('.link-chip[data-action="open-url"]')).toBeVisible(); await expect(chip(page)).toHaveCSS('order', '0');
  labels = await rows(); expect(index(labels, 'Switch to main')).toBeLessThan(index(labels, 'Copy project path')); expect(index(labels, 'Other branch')).toBeGreaterThan(-1);
  expect(await mutations(page)).toBe(0);
});
