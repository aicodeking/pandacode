import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: every native command is the preview mock; no real update, install, GitHub push,
// channel, worktree, machine link or goal reaches a harness. Each dialog opens through its module's own opener.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/owned-dialogs/extension.json', import.meta.url), 'utf8'));
// [ledger id, band dialog id, host]: module hosts use the app toast, direct hosts the band's own status line.
const OWNED: [string, string, 'module' | 'direct'][] = [
  ['agent-updates', 'agent-updates', 'module'], ['channel-create', 'channel-create', 'module'], ['channel-settings', 'channel-settings', 'module'],
  ['github-import', 'github-import', 'module'], ['github-pr', 'github-pr', 'module'], ['github-link', 'github-link', 'module'],
  ['sketch', 'sketch', 'module'], ['worktree-create', 'worktree-create', 'module'],
  ['command-center', 'command-center', 'direct'], ['goal', 'command-center', 'direct'], ['team-model-add', 'team-model-add', 'direct'],
  ['integrations-direct', 'integrations', 'direct'], ['jev-assist-direct', 'jev-assist', 'direct'], ['jev-tests-direct', 'jev-tests', 'direct'],
];
const TITLES: Record<string, string> = { 'agent-updates': 'Agent updates', 'channel-create': 'New channel', 'channel-settings': 'Channel settings', 'github-import': 'Import from GitHub', 'github-pr': 'Push & open pull request', 'github-link': 'Link pull request', sketch: 'Sketch a mockup', 'worktree-create': 'New worktree', 'command-center': 'Command center', 'team-model-add': 'Models for teams', integrations: 'Tools & integrations', 'jev-assist': 'Jev assistance', 'jev-tests': 'Browser tests', 'progress-lightbox': 'Progress large view', 'tool-image-viewer': 'Tool image viewer' };
const dialog = (page: Page) => page.locator('#dialog');
const band = (page: Page, id: string) => page.locator(`.dialog-extension-extras[data-dialog-accessory="${id}"]`);
const accessory = (page: Page, id: string) => page.evaluate(id => (window as any).__previewOwnedAccessory(id), id);
const admit = (page: Page, id: string, input: unknown) => page.evaluate(([id, input]) => (window as any).__previewOwnedAdmission(id, input), [id, input] as const);
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&dialog-coverage&owned-dialog-coverage&bots=sample'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page, id: string, bandId: string) {
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await page.evaluate(id => (window as any).__previewOpenOwnedDialog(id), id);
  await expect(dialog(page), id).toHaveJSProperty('open', true);
  await expect.poll(async () => (await accessory(page, bandId))?.dialog, { message: id }).toBe(bandId);
  await expect(band(page, bandId)).toHaveCount(1);
}
async function close(page: Page) {
  await page.keyboard.press('Escape');
  if (await dialog(page).evaluate(node => (node as HTMLDialogElement).open)) await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
}
async function install(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${manifest.id}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
}
function companion(notes: number) {
  const value = JSON.parse(JSON.stringify(manifest).replaceAll('sample.owned-dialogs', 'sample.owned-companion'));
  value.contributes.menus = value.contributes.menus.filter((menu: any) => menu.location === 'panda.dialog.command-center.actions' && !menu.items);
  value.contributes.menus[0].text = 'Companion note'; value.contributes.commands[0].title = 'Companion note';
  value.contributes.dialogExtras = Array.from({ length: notes }, (_, index) => ({ id: `sample.owned-companion/cc-${index}`, dialog: 'command-center', text: `Companion guidance ${index + 1}.` }));
  return value;
}

test('Owned dialogs: zero extensions keep every module-owned and direct dialog unchanged; protected Link a machine has no band', async ({ page }) => {
  test.setTimeout(120_000); await setup(page);
  for (const [id, bandId] of OWNED) {
    await open(page, id, bandId);
    await expect(band(page, bandId)).toBeHidden(); await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
    await close(page);
  }
  await page.evaluate(() => (window as any).__previewOpenOwnedDialog('machine-link'));
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(dialog(page).locator('#machine-link-form')).toHaveCount(1);
  // R1003: Link a machine takes a band only from packages holding ui.presentation; none is installed here.
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
  await close(page);
});

test('Owned dialogs: an installed package adds owner-labelled notes and clickable actions to every owned dialog, never a protected one', async ({ page }) => {
  test.setTimeout(150_000); await setup(page); await install(page);
  for (const [id, bandId, host] of OWNED) {
    await open(page, id, bandId);
    const slot = band(page, bandId);
    await expect(slot).toBeVisible();
    await expect(slot.locator(`[data-extension-location="panda.dialog.${bandId}.bodyExtras"]`)).toHaveText(`${manifest.id}: Owned guidance for ${TITLES[bandId]}; the host keeps its fields and actions.`);
    const action = slot.locator(`[data-extension-location="panda.dialog.${bandId}.actions"] [data-extension-contribution="${manifest.id}/${bandId}"]`);
    await expect(action.locator('svg')).toHaveCount(1); await expect(action).not.toHaveAttribute('data-extension-icon-fallback', 'true');
    const before = await accessory(page, bandId);
    // A module host captures its own target through modal(); a direct host gets its own per-host mount.
    expect(before.mount).toMatch(host === 'module' ? /^main\/\d+$/ : new RegExp(`^(${bandId}/\\d+)$`));
    await page.evaluate(() => { document.querySelector('#toast')!.textContent = ''; });
    await action.click();
    if (host === 'module') await expect(page.locator('#toast')).toHaveText('Owned dialog note: the host keeps this dialog');
    else await expect(slot.locator('.dialog-extension-status')).toHaveText('Owned dialog note: the host keeps this dialog');
    await expect(dialog(page)).toHaveJSProperty('open', true); expect(await accessory(page, bandId)).toEqual(before);
    await expect(slot.locator('.primary-button')).toHaveCount(0);
    await close(page);
    await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
  }
  await page.evaluate(() => (window as any).__previewOpenOwnedDialog('machine-link'));
  await expect(dialog(page).locator('#machine-link-form')).toHaveCount(1);
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
  await close(page);
});

test('Owned dialogs: the goal panel keeps fields, IME, Escape, focus and one submit through a band menu and a nested follow-up form', async ({ page }) => {
  await setup(page, [manifest]); await open(page, 'goal', 'command-center');
  const objective = dialog(page).getByLabel('Goal objective', { exact: true }), slot = band(page, 'command-center');
  const captured = await accessory(page, 'command-center');
  expect(captured).toMatchObject({ contractVersion: 1, window: 'main', dialog: 'command-center', target: 'task' }); expect(captured.task).not.toBe('');
  await expect(dialog(page).getByRole('button', { name: 'Start goal', exact: true })).toBeEnabled();
  await objective.fill('Ship the owned band'); await objective.focus();
  await objective.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(objective).toHaveValue('Ship the owned band');
  const more = slot.getByRole('button', { name: 'More owned dialog actions', exact: true });
  await more.click(); await expect(page.getByRole('menuitem', { name: 'Show owned note', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Unavailable owned action', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Show owned note', exact: true })).toHaveCount(0);
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(more).toBeFocused();
  await more.click(); await page.getByRole('menuitem', { name: 'Open owned follow-up…', exact: true }).click();
  const nested = page.getByRole('dialog', { name: `Owned follow-up — ${manifest.id}`, exact: true });
  await expect(nested).toBeVisible(); await expect(dialog(page)).toHaveJSProperty('open', true);
  const note = nested.getByLabel('Follow-up note', { exact: true }); await expect(note).toBeFocused();
  await note.fill('Later'); await note.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }); await expect(nested).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nested).toBeHidden(); await expect(slot.locator('.dialog-extension-status')).toHaveText('Owned follow-up cancelled');
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(objective).toHaveValue('Ship the owned band');
  expect(await dialog(page).evaluate(node => node.contains(document.activeElement))).toBe(true);
  await more.click(); await page.getByRole('menuitem', { name: 'Open owned follow-up…', exact: true }).click();
  await nested.getByLabel('Follow-up note', { exact: true }).fill('Share it');
  await nested.getByLabel('Follow-up kind', { exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Share with team' }).click();
  await nested.getByLabel('Remind me', { exact: true }).check();
  await nested.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(nested).toBeHidden(); await expect(slot.locator('.dialog-extension-status')).toHaveText('Owned follow-up recorded');
  await expect(objective).toHaveValue('Ship the owned band');
  // The host's own submit runs once, for the captured task.
  await dialog(page).getByRole('button', { name: 'Start goal', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'task_goal')).filter((call: any) => call.args.request?.action === 'set').map((call: any) => [call.args.sessionId, call.args.request.objective])).toEqual([[captured.task, 'Ship the owned band']]);
  await close(page); await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
});

test('Owned dialogs: a task switch keeps the captured target; replacement and close cancel only owned extras and refuse late requests', async ({ page }) => {
  await setup(page, [manifest]); await open(page, 'command-center', 'command-center');
  const captured = await accessory(page, 'command-center');
  expect(await admit(page, 'command-center', captured)).toEqual({ ok: true });
  const next = await page.evaluate(id => [...document.querySelectorAll<HTMLElement>('.task-item[data-id]')].map(node => node.dataset.id).find(value => value && value !== id), captured.task);
  expect(next).toBeTruthy();
  await page.evaluate(id => (window as any).__previewSelectTask(id), next);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.task-item[aria-current="page"]')?.dataset.id)).toBe(next);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(await accessory(page, 'command-center')).toEqual(captured); expect(await admit(page, 'command-center', captured)).toEqual({ ok: true });
  await band(page, 'command-center').getByRole('button', { name: 'More owned dialog actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open owned follow-up…', exact: true }).click();
  const nested = page.getByRole('dialog', { name: `Owned follow-up — ${manifest.id}`, exact: true });
  await nested.getByLabel('Follow-up note', { exact: true }).fill('Pending');
  // Another opening replaces the panel: the band's form unloads without a success or retargeted reply.
  await page.evaluate(() => (window as any).__previewOpenMainDialog('task-status'));
  await expect(nested).toBeHidden(); await expect(page.locator('#dialog .dialog-extension-extras[data-dialog-accessory="command-center"]')).toHaveCount(0);
  await expect(page.locator('.dialog-extension-status')).toHaveCount(0);
  expect(await admit(page, 'command-center', captured)).toEqual({ ok: false, reason: 'Revoked' });
  await close(page);
  // Reopening is a new mount: the old capture stays stale against it.
  await open(page, 'command-center', 'command-center');
  const reopened = await accessory(page, 'command-center');
  expect(reopened.mount).not.toBe(captured.mount);
  expect(await admit(page, 'command-center', captured)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await admit(page, 'command-center', { ...captured, dialog: 'extension-form' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await close(page);
  expect(await admit(page, 'command-center', reopened)).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
});

test('Owned dialogs: conflict is bounded and owner-labelled; disable, fault and safe mode remove only extras and keep the host draft and focus', async ({ page }) => {
  await setup(page, [manifest, companion(9)]); await open(page, 'goal', 'command-center');
  const slot = band(page, 'command-center'), notes = slot.locator('[data-extension-location="panda.dialog.command-center.bodyExtras"] p');
  await expect(notes).toHaveCount(9);
  await expect(notes.first()).toHaveText(`${manifest.id}: Owned guidance for Command center; the host keeps its fields and actions.`);
  await expect(notes.last()).toHaveText('2 more extension notes are not shown.');
  await expect(slot.getByRole('button', { name: 'Companion note', exact: true })).toBeVisible();
  await expect(slot.getByRole('button', { name: 'Owned dialog note', exact: true })).toBeVisible();
  const objective = dialog(page).getByLabel('Goal objective', { exact: true }); await objective.fill('Unsaved goal'); await objective.focus();
  const node = await objective.elementHandle();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.owned-companion'); });
  await expect(slot.getByRole('button', { name: 'Companion note', exact: true })).toHaveCount(0); await expect(notes).toHaveCount(1);
  await expect(objective).toHaveValue('Unsaved goal'); await expect(objective).toBeFocused(); expect(await node!.evaluate(node => node.isConnected)).toBe(true);
  await page.evaluate(async () => { localStorage.setItem('pandacode.preview.extensions.v1', '{"broken":'); await (window as any).__previewDialogRefresh(); });
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0); await expect(slot).toBeHidden();
  await expect(objective).toHaveValue('Unsaved goal'); await expect(objective).toBeFocused(); await expect(dialog(page)).toHaveJSProperty('open', true);
  await page.evaluate(async manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); await (window as any).__previewDialogRefresh(); }, manifest);
  await expect(slot.getByRole('button', { name: 'Owned dialog note', exact: true })).toBeVisible(); await expect(objective).toBeFocused();
  await page.evaluate(async () => { await (window as any).__previewDialogSafeMode(); });
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
  await expect(objective).toHaveValue('Unsaved goal'); await expect(objective).toBeFocused(); await expect(dialog(page)).toHaveJSProperty('open', true);
  await close(page); expect(await calls(page, 'task_goal').then(list => list.filter((call: any) => call.args.request?.action === 'set'))).toEqual([]);
});

test('Owned dialogs: the progress large view carries its own band in the plate; Escape and close dispose only the band', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('pp-seeded')) { sessionStorage.setItem('pp-seeded', '1'); localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner: 'tl' })); } });
  await page.addInitScript(manifest => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
  }, manifest);
  await page.goto('/?extensions-baseline&owned-dialog-coverage&progress'); await expect(page.locator('#prompt')).toBeEnabled();
  const card = page.locator('#progress-pip .pp-card');
  const pill = page.getByRole('button', { name: /^Show visual progress/ });
  await expect(card.or(pill).first()).toBeVisible();
  if (await pill.isVisible()) await pill.click();
  await expect(card).toBeVisible();
  const task = await page.evaluate(() => document.querySelector<HTMLElement>('.task-item[aria-current="page"]')?.dataset.id);
  await card.getByRole('button', { name: 'Open large view' }).click();
  const lightbox = page.locator('dialog.pp-lightbox'); await expect(lightbox).toBeVisible();
  const slot = lightbox.locator('.pp-lb-plate > .dialog-extension-extras[data-dialog-accessory="progress-lightbox"]');
  await expect(slot).toBeVisible();
  await expect.poll(async () => (await accessory(page, 'progress-lightbox'))?.task).toBe(task);
  await expect(slot.locator('[data-extension-location="panda.dialog.progress-lightbox.bodyExtras"]')).toHaveText(`${manifest.id}: Owned guidance for Progress large view; the host keeps its fields and actions.`);
  const action = slot.getByRole('button', { name: 'Owned dialog note', exact: true });
  const count = await lightbox.locator('.pp-lb-count').textContent();
  await action.focus(); await page.keyboard.press('ArrowRight');
  await expect(lightbox.locator('.pp-lb-count')).toHaveText(count!);
  await action.click(); await expect(slot.locator('.dialog-extension-status')).toHaveText('Owned dialog note: the host keeps this dialog');
  await expect(lightbox).toBeVisible();
  const captured = await accessory(page, 'progress-lightbox');
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0); await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
  expect(await admit(page, 'progress-lightbox', captured)).toEqual({ ok: false, reason: 'Revoked' });
  await expect(card.getByRole('button', { name: 'Open large view' })).toBeFocused();
});

test('Owned dialogs: the tool image viewer carries its own band in the plate; each image is its own capture and Escape disposes only the band', async ({ page }) => {
  const at = Date.now() - 20_000, paths = ['shots/first.png', 'shots/second.png'];
  const seeded = [
    { id: 92_001, sessionId: 'session-1', role: 'user', content: 'Look at the screenshots.', createdAt: at },
    ...paths.map((path, index) => ({ id: 92_002 + index, sessionId: 'session-1', role: 'tool', createdAt: at + (index + 1) * 100,
      content: JSON.stringify({ type: 'tool_activity', version: 1, id: `viewer-image-${index}`, name: 'Read', status: 'completed', input: JSON.stringify({ file_path: path }), output: '[Non-text content omitted]' }) })),
    { id: 92_100, sessionId: 'session-1', role: 'assistant', content: 'Both screenshots show the settings.', createdAt: at + 5_000 },
  ];
  await page.addInitScript(([seeded, manifest]) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], seedMessages: { 'session-1': seeded } }; localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
  }, [seeded, manifest] as const);
  await page.goto('/?extensions-baseline&owned-dialog-coverage'); await expect(page.locator('#prompt')).toBeEnabled();
  const card = page.locator('.turn-card').last();
  await expect(card).toContainText('Both screenshots show the settings.');
  const activity = card.locator('details.turn-activity');
  if (await activity.getAttribute('open') === null) await activity.locator(':scope > summary').click();
  const group = card.locator('details.tool-group').last();
  if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  const thumb = card.locator(`.tool-image-thumb[data-tool-image="${paths[0]}"]`);
  await expect(thumb).toHaveClass(/\bis-loaded\b/); await thumb.click();
  const viewer = page.locator('dialog.tool-image-viewer'); await expect(viewer).toBeVisible();
  const slot = viewer.locator('.tool-image-viewer-plate > .dialog-extension-extras[data-dialog-accessory="tool-image-viewer"]');
  await expect(slot).toBeVisible();
  await expect.poll(async () => (await accessory(page, 'tool-image-viewer'))?.task).toBe('session-1');
  await expect(slot.locator('[data-extension-location="panda.dialog.tool-image-viewer.bodyExtras"]')).toHaveText(`${manifest.id}: Owned guidance for Tool image viewer; the host keeps its fields and actions.`);
  const action = slot.getByRole('button', { name: 'Owned dialog note', exact: true });
  await action.focus(); await page.keyboard.press('ArrowRight');
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('1 of 2');
  await action.click(); await expect(slot.locator('.dialog-extension-status')).toHaveText('Owned dialog note: the host keeps this dialog');
  const first = await accessory(page, 'tool-image-viewer');
  await viewer.getByRole('button', { name: 'Next image', exact: true }).click();
  await expect(viewer.locator('.tool-image-viewer-count')).toHaveText('2 of 2');
  await expect.poll(async () => (await accessory(page, 'tool-image-viewer'))?.mount).not.toBe(first.mount);
  expect(await admit(page, 'tool-image-viewer', first)).toEqual({ ok: false, reason: 'StaleContext' });
  const captured = await accessory(page, 'tool-image-viewer');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0); await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
  expect(await admit(page, 'tool-image-viewer', captured)).toEqual({ ok: false, reason: 'Revoked' });
  await expect(thumb).toBeFocused();
});
