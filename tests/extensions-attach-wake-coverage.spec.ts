import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with the preview's seeded recipes, wake-ups and files.
// No real harness runs; installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/composer-attach/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.composer-attach/toolbar';
const BASE = '/?extensions-baseline&composer-attach&replacement';
const ENTRIES = ['Attach files…', 'Attach a folder…', 'Project files', 'Sketch a mockup…', 'Workflow recipes…', 'Schedule a wake-up…'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewAttach());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const toast = (page: Page) => page.locator('#toast');
const attachButton = (page: Page) => page.getByRole('button', { name: 'Attach files for context', exact: true });
const attachMenu = (page: Page) => page.getByRole('dialog', { name: 'Attach', exact: true });
const labels = (menu: ReturnType<Page['locator']>) => menu.locator('.choice-menu-option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
/** Draft attachments: Files rows' paths and picked or dropped documents, folders and images. */
const chips = (page: Page) => page.locator('#attachments > span');
const recipes = (page: Page) => page.locator('#recipes-body');
const recipeActions = (page: Page) => recipes(page).locator('.recipe-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action));
const strip = (page: Page) => page.locator('#composer #wake-strip');
const popover = (page: Page) => page.getByRole('dialog', { name: 'Wake this thread later', exact: true });
const presets = (page: Page) => popover(page).locator('[data-preset]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.preset));
const wakeMenu = (page: Page) => page.getByRole('dialog', { name: 'Check the CI run', exact: true });
const fileAttach = (page: Page) => page.locator('#inspector .file-row > [data-action="attach-file"]');
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    // A held synthetic run keeps the composer still once a recipe's first step or a wake-up starts a turn.
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load. */
async function load(page: Page, url: string) { await page.goto(url); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true); }
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', id); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewAttach(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewAttachAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, region: ReturnType<Page['locator']>, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
async function openAttach(page: Page) { await attachButton(page).click(); await expect(attachMenu(page)).toBeVisible(); }
async function choose(page: Page, entry: string) { await openAttach(page); await attachMenu(page).getByRole('menuitem', { name: entry, exact: true }).click(); }
/** The task's Files tab with its rows, opened through the Attach menu's own Project files entry. */
async function files(page: Page) { await choose(page, 'Project files'); await expect(fileAttach(page).first()).toBeAttached(); }
async function openRecipes(page: Page) { await choose(page, 'Workflow recipes…'); await expect(recipes(page).getByRole('button', { name: /review-diff/ })).toBeVisible(); }
async function expand(page: Page) { await expect(strip(page)).toBeVisible(); if (await strip(page).locator('.wake-toggle').getAttribute('aria-expanded') !== 'true') await strip(page).locator('.wake-toggle').click(); await expect(strip(page).locator('.wake-row').first()).toBeVisible(); }
const noScheduleChanges = async (page: Page) => { for (const command of ['schedule_create', 'schedule_delete', 'schedule_snooze', 'schedule_set_enabled', 'schedule_run_now']) expect(await calls(page, command), command).toEqual([]); };
const noRecipeChanges = async (page: Page) => { expect(await calls(page, 'recipes_delete')).toEqual([]); expect(await calls(page, 'recipes_save')).toEqual([]); };

test('Composer attach extension: zero extensions keep the Attach menu, file attach and drops, recipe runs and wake-ups', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await openAttach(page);
  expect(await labels(attachMenu(page))).toEqual(ENTRIES);
  await page.keyboard.press('Escape'); await expect(attachMenu(page)).toHaveCount(0);
  expect(await props(page)).toMatchObject({ visible: true, busy: false, safeMode: false, draft: false, attachments: 0, recipes: false, recipe: '' });
  expect(await act(page, 'attach-open')).toEqual({ ok: false, reason: 'Revoked' });
  // A Files row's own Attach and an OS file drop both join the draft.
  await files(page);
  await fileAttach(page).first().click();
  await expect(chips(page)).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-preview-drop', { detail: ['/Users/you/Documents/notes.md'] })));
  await expect(chips(page)).toHaveCount(2);
  await prompt(page).fill('Keep this draft');
  // Workflow recipes: the dry run and Run queue the steps once; the draft and its attachments stay.
  await openRecipes(page);
  await recipes(page).getByRole('button', { name: /review-diff/ }).click();
  expect(await recipeActions(page)).toEqual(['recipe-delete', 'recipe-edit', 'recipe-run']);
  await expect(recipes(page).locator('[data-recipe-extension-actions], [data-layout-hidden]')).toHaveCount(0);
  await recipes(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(recipes(page)).toBeHidden();
  await expect.poll(async () => (await calls(page, 'queue_add')).length).toBe(4);
  await expect(chips(page)).toHaveCount(2); await expect(prompt(page)).toHaveValue('Keep this draft');
  // Wake-ups: the quick add keeps its choices; the strip's ⋯ menu keeps its entries.
  await choose(page, 'Schedule a wake-up…');
  await expect(popover(page)).toBeVisible();
  expect((await presets(page)).filter(id => id !== 'tonight')).toEqual(['in-15', 'in-60', 'tomorrow']);
  await expect(popover(page).locator('[data-wake-extension-actions], [data-layout-hidden]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(popover(page)).toHaveCount(0);
  await expand(page);
  await strip(page).locator('.wake-row').first().locator('[data-wake="more"]').click();
  expect(await labels(wakeMenu(page))).toEqual(['Snooze 10 min', 'Snooze 1 h', 'Snooze until tomorrow', 'Pause', 'Edit…', 'Remove…']);
  await wakeMenu(page).getByRole('menuitem', { name: 'Snooze 10 min', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'schedule_snooze')).length).toBe(1);
  await expect(chips(page)).toHaveCount(2); await expect(prompt(page)).toHaveValue('Keep this draft');
});

test('Composer attach extension: an installed package adds Attach menu, recipe, quick add and wake-up menu actions that run with the captured target', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.composer-attach', exact: true }).click();
  await expect(region.getByLabel('Composer presentation')).toHaveValue('');
  await back(page);
  await files(page); await fileAttach(page).first().click(); await expect(chips(page)).toHaveCount(1);
  await prompt(page).fill('Draft with notes');
  // The Attach menu: the contributed row follows the menu's own entries and keeps the draft.
  await openAttach(page);
  expect(await labels(attachMenu(page))).toEqual([...ENTRIES, 'Attach notes']);
  await attachMenu(page).getByRole('menuitem', { name: 'Attach notes', exact: true }).click();
  await expect(toast(page)).toContainText('Draft attachments stay with PandaCode.');
  await expect(chips(page)).toHaveCount(1); await expect(prompt(page)).toHaveValue('Draft with notes');
  // The selected recipe carries the contributed action; the steps are not queued.
  await openRecipes(page);
  await recipes(page).getByRole('button', { name: /review-diff/ }).click();
  await recipes(page).getByRole('button', { name: 'Recipe notes', exact: true }).click();
  await expect(toast(page)).toContainText('Recipe steps stay with PandaCode.');
  await expect(recipes(page)).toBeVisible(); expect(await calls(page, 'queue_add')).toEqual([]); await noRecipeChanges(page);
  // A redraw (another recipe) keeps the slot on the new selection.
  await recipes(page).getByRole('button', { name: /needs-ship/ }).click();
  await expect(recipes(page).getByRole('button', { name: 'Recipe notes', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(recipes(page)).toBeHidden();
  // Wake this thread later: the contributed action sits in the footer; nothing is scheduled.
  await choose(page, 'Schedule a wake-up…');
  await popover(page).getByRole('button', { name: 'Wake notes', exact: true }).click();
  await expect(toast(page)).toContainText("Wake-ups stay the user's choice.");
  // WebKit leaves focus where it was on a click, so the quick add's own Cancel closes it.
  await popover(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(popover(page)).toHaveCount(0);
  // A wake-up's ⋯ menu: the contributed row follows the menu's own entries.
  await expand(page);
  await strip(page).locator('.wake-row').first().locator('[data-wake="more"]').click();
  expect(await labels(wakeMenu(page))).toEqual(['Snooze 10 min', 'Snooze 1 h', 'Snooze until tomorrow', 'Pause', 'Edit…', 'Remove…', 'Schedule notes']);
  await wakeMenu(page).getByRole('menuitem', { name: 'Schedule notes', exact: true }).click();
  await expect(toast(page)).toContainText('This wake-up stays as scheduled.');
  await noScheduleChanges(page);
  await expect(chips(page)).toHaveCount(1); await expect(prompt(page)).toHaveValue('Draft with notes');
});

test('Composer attach extension: captured attach, recipe and wake-up actions run original handlers; protected, stale and forged requests fail', async ({ page }) => {
  // Several Settings round trips, a dialog and the strip: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  // A package never attaches paths, removes attachments, deletes or saves recipes or creates, removes or snoozes wake-ups.
  for (const controlId of ['attach-paths', 'attach-remove', 'recipe-delete', 'recipe-save', 'recipe-cancel', 'wake-create', 'wake-remove', 'wake-snooze', 'wake-set']) expect(await act(page, 'attach-open', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'attach-open', { path: '/etc/passwd' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'attach-open', { selector: '#prompt' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'attach-open', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'attach-open', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await noScheduleChanges(page); await noRecipeChanges(page); await expect(chips(page)).toHaveCount(0);
  // The Attach button opens the original menu.
  expect(await act(page, 'attach-open')).toEqual({ ok: true }); await expect(attachMenu(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(attachMenu(page)).toHaveCount(0);
  // A Files row's Attach asks first; Escape declines it and the draft stays empty.
  await files(page);
  expect(await act(page, 'attach-file')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  const continueAttach = page.getByRole('menuitemradio', { name: /^Continue: Attach / });
  await expect(continueAttach).toBeVisible();
  expect(await act(page, 'attach-open')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(continueAttach).toHaveCount(0); await expect(chips(page)).toHaveCount(0);
  // A draft edited after the request was captured is another target.
  const stale = await action(page, 'attach-file');
  await prompt(page).fill('Edited after capture');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'attach-file')).toEqual({ ok: true }); await continueAttach.click();
  await expect(chips(page)).toHaveCount(1); expect((await props(page)).attachments).toBe(1);
  // Recipes: pick and Edit run their original handlers; Run asks first and queues the captured recipe's steps once.
  await openRecipes(page);
  expect((await props(page)).recipes).toBe(true);
  expect(await act(page, 'recipe-pick')).toEqual({ ok: true });
  await expect(recipes(page).getByRole('table', { name: 'Dry run for review-diff' })).toBeVisible();
  // The dry run redraws the detail (a new revision) once it settles: capture after it.
  await expect(recipes(page).getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  expect(await act(page, 'recipe-edit')).toEqual({ ok: true });
  await expect(recipes(page).getByRole('textbox', { name: 'Recipe JSON' })).toBeVisible();
  await recipes(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await act(page, 'recipe-run')).toEqual({ ok: true });
  const continueRun = page.getByRole('menuitemradio', { name: "Continue: Queue this recipe's steps as messages", exact: true });
  await expect(continueRun).toBeVisible(); await page.keyboard.press('Escape'); await expect(continueRun).toHaveCount(0);
  await expect(recipes(page)).toBeVisible(); expect(await calls(page, 'queue_add')).toEqual([]);
  expect(await act(page, 'recipe-run')).toEqual({ ok: true }); await continueRun.click();
  await expect(recipes(page)).toBeHidden();
  await expect.poll(async () => (await calls(page, 'queue_add')).map((call: any) => call.args.sessionId)).toEqual(['session-1', 'session-1', 'session-1', 'session-1']);
  await noRecipeChanges(page);
  // Wake-ups: the disclosure opens the strip; Run now asks first and runs the captured wake-up once.
  expect(await act(page, 'wake-expand')).toEqual({ ok: true });
  await expect(strip(page).locator('.wake-row').first()).toBeVisible();
  expect(await act(page, 'wake-run')).toEqual({ ok: true });
  const continueWake = page.getByRole('menuitemradio', { name: /^Continue: Run now: / });
  await expect(continueWake).toBeVisible(); await continueWake.click();
  await expect.poll(async () => (await calls(page, 'schedule_run_now')).length).toBe(1);
  // The user's own switch changes the wake-up: a request captured before is another target.
  // Run now finished the one-off wake-up; the user pauses the first one still enabled (rows follow the captured order).
  const rows = await strip(page).locator('.wake-row').evaluateAll(nodes => nodes.map(node => [(node as HTMLElement).dataset.id, (node as HTMLElement).dataset.enabled]));
  const index = rows.findIndex(([, enabled]) => enabled === 'true'), id = rows[index][0]!;
  const paused = await action(page, 'wake-enable', {}, index);
  await strip(page).locator('.wake-row').nth(index).locator('.wake-switch').click();
  await expect.poll(async () => (await calls(page, 'schedule_set_enabled')).length).toBe(1);
  await expect(strip(page).locator(`.wake-row[data-id="${id}"]`)).toHaveAttribute('data-enabled', 'false');
  expect(await send(page, paused)).toEqual({ ok: false, reason: 'StaleContext' });
  // More opens the original ⋯ menu of the first row (the paused wake-up may have moved down the list).
  expect(await act(page, 'wake-more')).toEqual({ ok: true }); await expect(page.getByRole('dialog', { name: /^(Check the CI run|Morning summary)$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Switching task changes the captured task: a request made for the first task is refused there.
  const elsewhere = await action(page, 'attach-open');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  await expect(attachMenu(page)).toHaveCount(0);
  expect((await calls(page, 'schedule_run_now')).length).toBe(1); expect((await calls(page, 'queue_add')).length).toBe(4);
});

test('Composer attach extension: Attach menu, recipe, quick add and wake-up menu order and hiding persist across a reload and never touch protected entries', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.composer.attach.actions', 'Schedule a wake-up before Attach a folder'); await back(page);
  await proposal(page, 'panda.composer.recipes.controls', 'Run before Edit'); await back(page);
  await proposal(page, 'panda.composer.wake.controls', 'Tomorrow before In 15 min'); await back(page);
  await proposal(page, 'panda.composer.wake.context', 'Edit before the snoozes'); await back(page);
  const region = await explorer(page);
  await hide(page, region, 'panda.composer.attach.actions', 'Project files');
  await hide(page, region, 'panda.composer.recipes.controls', 'Edit recipe');
  await hide(page, region, 'panda.composer.wake.controls', 'In 15 min');
  await hide(page, region, 'panda.composer.wake.context', 'Snooze 1 h');
  await expect(region.getByRole('button', { name: /^Hide Remove…/ })).toHaveCount(0);
  await back(page);
  // A proposal moves its target: "A before B" places B right after A.
  const check = async () => {
    await openAttach(page);
    await expect.poll(() => labels(attachMenu(page))).toEqual(['Attach files…', 'Sketch a mockup…', 'Workflow recipes…', 'Schedule a wake-up…', 'Attach a folder…', 'Attach notes']);
    await page.keyboard.press('Escape'); await expect(attachMenu(page)).toHaveCount(0);
    await openRecipes(page);
    await recipes(page).getByRole('button', { name: /review-diff/ }).click();
    await expect.poll(() => recipeActions(page)).toEqual(['recipe-delete', 'recipe-run', 'recipe-edit']);
    await expect(recipes(page).locator('[data-action="recipe-edit"]')).toBeHidden(); await expect(recipes(page).getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(recipes(page)).toBeHidden();
    await choose(page, 'Schedule a wake-up…');
    expect((await presets(page)).filter(id => id !== 'tonight')).toEqual(['in-60', 'tomorrow', 'in-15']);
    await expect(popover(page).locator('[data-preset="in-15"]')).toBeHidden(); await expect(popover(page).locator('[data-preset="in-60"]')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape'); await expect(popover(page)).toHaveCount(0);
    await expand(page);
    await strip(page).locator('.wake-row').first().locator('[data-wake="more"]').click();
    await expect.poll(() => labels(wakeMenu(page))).toEqual(['Snooze until tomorrow', 'Pause', 'Edit…', 'Snooze 10 min', 'Remove…', 'Schedule notes']);
    await page.keyboard.press('Escape');
  };
  await check();
  expect(await act(page, 'recipe-edit')).toEqual({ ok: false, reason: 'StaleContext' });
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await check();
  // A forged overlay cannot hide Attach files, Run, In 1 h or Remove.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.composer.attach.actions/files': false, 'panda.composer.recipes.controls/run': false, 'panda.composer.wake.controls/in-60': false, 'panda.composer.wake.context/remove': false, 'panda.composer.attach.protected/recipe-delete': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await openAttach(page); await expect(attachMenu(page).getByRole('menuitem', { name: 'Attach files…', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await openRecipes(page); await recipes(page).getByRole('button', { name: /review-diff/ }).click();
  await expect(recipes(page).getByRole('button', { name: 'Run', exact: true })).toBeVisible(); await expect(recipes(page).getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await choose(page, 'Schedule a wake-up…'); await expect(popover(page).locator('[data-preset="in-60"]')).toBeVisible(); await page.keyboard.press('Escape');
  await strip(page).locator('.wake-row').first().locator('[data-wake="more"]').click();
  await expect(wakeMenu(page).getByRole('menuitem', { name: 'Remove…', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await noScheduleChanges(page); await noRecipeChanges(page);
});

test('Composer attach extension: draft attachments, recipe steps, wake-ups and focus survive conflict, fault, disable and safe mode with no duplicate run', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.composer-attach'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.composer-attach/toolbar' }], commands: [{ id: 'other.composer-attach/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.composer-attach/attach', command: 'other.composer-attach/notes', location: 'panda.composer.attach.actions', presentation: 'button', text: 'Other notes' }] };
  await setup(page, [manifest, other]);
  // Two compatible providers: neither is selected automatically.
  await explorer(page); await expect(page.getByLabel('Composer presentation', { exact: true })).toHaveValue(''); await back(page);
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await select(page, 'other.composer-attach/toolbar');
  // Both packages contribute to the Attach menu; neither displaces its own entries.
  await openAttach(page);
  expect(await labels(attachMenu(page))).toEqual([...ENTRIES, 'Other notes', 'Attach notes']);
  await page.keyboard.press('Escape');
  await files(page); await fileAttach(page).first().click(); await expect(chips(page)).toHaveCount(1);
  await prompt(page).fill('Keep this draft'); await prompt(page).focus();
  const schedules = (await props(page)).schedules;
  const check = async () => {
    await expect(chips(page)).toHaveCount(1);
    await expect(prompt(page)).toHaveValue('Keep this draft'); await expect(prompt(page)).toBeFocused();
    expect((await props(page)).schedules).toEqual(schedules);
    await noScheduleChanges(page); await noRecipeChanges(page); expect(await calls(page, 'queue_add')).toEqual([]);
  };
  await check();
  // A faulting composer recipe falls back to the built-in composer: captured actions stop; the menus stay.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'attach-open')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.composer-attach'));
  await openAttach(page); expect(await labels(attachMenu(page))).toEqual([...ENTRIES, 'Attach notes']); await page.keyboard.press('Escape');
  await prompt(page).focus(); await check();
  await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', PROVIDER);
  await prompt(page).focus(); await check();
  // A captured Run now asks first; Escape declines it and the wake-up stays.
  expect(await act(page, 'wake-expand')).toEqual({ ok: true }); await expect(strip(page).locator('.wake-row').first()).toBeVisible();
  expect(await act(page, 'wake-run')).toEqual({ ok: true });
  const continueWake = page.getByRole('menuitemradio', { name: /^Continue: Run now: / });
  await expect(continueWake).toBeVisible(); await page.keyboard.press('Escape'); await expect(continueWake).toHaveCount(0);
  await prompt(page).focus(); await check();
  // Safe mode restores the built-in menus: no contributed rows, nothing captured; the draft, wake-ups and focus stay.
  await page.evaluate(() => (window as any).__previewAttachSafeMode());
  await expect.poll(async () => (await props(page)).safeMode).toBe(true);
  expect(await act(page, 'attach-open')).toEqual({ ok: false, reason: 'Revoked' });
  await openAttach(page); expect(await labels(attachMenu(page))).toEqual(ENTRIES); await page.keyboard.press('Escape');
  await prompt(page).focus(); await check();
  // The host still runs a recipe: once.
  await openRecipes(page); await recipes(page).getByRole('button', { name: /review-diff/ }).click();
  await expect(recipes(page).locator('[data-recipe-extension-actions]')).toHaveCount(0);
  await recipes(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'queue_add')).length).toBe(4);
  await expect(chips(page)).toHaveCount(1); await expect(prompt(page)).toHaveValue('Keep this draft');
  expect((await calls(page, 'queue_add')).length).toBe(4);
});
