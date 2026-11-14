import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/design/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewDesign());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&design-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-design'); await page.locator('.inspector-tabs [data-action="tab-design"]').click();
  await expect(page.locator('.design-board iframe')).toHaveCount(2);
  await expect.poll(async () => (await props(page))?.loading).toBe(false);
  await expect(page.frameLocator('iframe[title="home.html"]').getByRole('heading', { name: 'Ship calmer releases' })).toBeAttached();
}
async function explorer(page: Page) { await page.locator('[data-design="comment"]').focus(); await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Design presentation', { exact: true }).selectOption('sample.design/comments'); await back(page); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, changes }) => {
    const p = (window as any).__previewDesign();
    const a = { contractVersion: 1, context: p.context, project: p.project, session: p.session, revision: p.revision, selection: p.selection, artboard: '', comment: '', resourceRevision: '', controlId, value: '', x: 0, y: 0, requestId: crypto.randomUUID(), ...changes };
    (window as any).__capturedDesign = a; return (window as any).__previewDesignAction(a);
  }, { controlId, changes });
}
const settled = async (page: Page) => expect.poll(async () => (await props(page)).busy).toBe(false);
async function pick(page: Page) {
  if (!(await props(page)).commenting) expect(await action(page, 'comment')).toEqual({ ok: true });
  const b = (await props(page)).artboards[0];
  expect(await action(page, 'select', { artboard: b.id, resourceRevision: b.revision, x: 50, y: 150 })).toEqual({ ok: true });
  await expect(page.locator('#design-comment-text')).toBeVisible();
}
async function commentAction(page: Page, id: string, index = 0) {
  const c = (await props(page)).comments[index];
  return action(page, id, { artboard: c.artboard, comment: c.id, resourceRevision: c.revision });
}
test('design: zero extensions retain original pan/zoom/pick/save/compose and hidden-frame policy', async ({ page }) => {
  await setup(page); await expect(page.locator('[data-design-provider]')).toHaveCount(0);
  expect((await props(page)).artboards.every((b: any) => b.label === '')).toBe(true);
  const world = page.locator('.design-world'), before = await world.evaluate(node => (node as HTMLElement).style.transform);
  await page.locator('[data-design="in"]').click(); expect(await world.evaluate(node => (node as HTMLElement).style.transform)).not.toBe(before);
  await page.locator('.design-viewport').dispatchEvent('wheel', { deltaY: 32, shiftKey: true, bubbles: true });
  await page.locator('[data-design="fit"]').click();
  await page.locator('[data-design="comment"]').click();
  const point = await page.locator('iframe[title="home.html"]').evaluate((f: HTMLIFrameElement) => {
    const r = f.getBoundingClientRect(), t = f.contentDocument!.querySelector('h1')!.getBoundingClientRect(), z = r.width / f.offsetWidth;
    return { x: r.x + (t.x + 30) * z, y: r.y + (t.y + 10) * z };
  });
  await page.mouse.click(point.x, point.y); await page.locator('#design-comment-text').fill('Original draft');
  await page.locator('.design-new [type="submit"]').click(); await settled(page);
  expect(await calls(page, 'design_save_comments')).toHaveLength(1);
  await page.locator('[data-design="send"]').click();
  expect(await page.locator('#prompt').inputValue()).toContain('Original draft');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await expect(page.locator('.design-board iframe')).toHaveCount(0);
  await page.locator('.inspector-tabs [data-action="tab-design"]').click(); await expect(page.locator('.design-board iframe')).toHaveCount(2);
  expect((await props(page)).comments).toHaveLength(2);
});
test('design: install/explicit selection, every original action, context and compatible recipe retain frame documents', async ({ page }) => {
  await setup(page);
  await page.locator('iframe[title="home.html"]').evaluate((f: HTMLIFrameElement) => { (window as any).__designDocument = f.contentDocument; });
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.design', exact: true }).click();
  await expect(region.getByLabel('Design presentation', { exact: true })).toHaveValue('');
  await region.getByLabel('Design presentation', { exact: true }).selectOption('sample.design/comments');
  await region.getByRole('button', { name: 'Grant UI customization and select Fit before zoom', exact: true }).click(); await back(page);
  await expect(page.locator('[data-design-provider="sample.design/comments"]')).toBeVisible();
  expect(await page.locator('.design-comments').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  expect(await page.locator('.design-toolbar > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-design')))).toEqual(['comment', 'fit', 'out', 'in', 'refresh', 'send']);
  for (const control of ['in', 'out', 'fit']) expect(await action(page, control)).toEqual({ ok: true });
  for (const value of ['left', 'right', 'up', 'down']) expect(await action(page, 'pan', { value })).toEqual({ ok: true });
  await pick(page); expect(await action(page, 'draft')).toEqual({ ok: true }); await expect(page.locator('#design-comment-text')).toBeFocused();
  await page.locator('#design-comment-text').fill('Public captured save');
  expect(await action(page, 'save')).toEqual({ ok: true }); await settled(page);
  expect(await calls(page, 'design_save_comments')).toHaveLength(1);
  expect(await commentAction(page, 'resolve')).toEqual({ ok: true }); await settled(page);
  expect(await commentAction(page, 'reopen')).toEqual({ ok: true }); await settled(page);
  expect(await commentAction(page, 'delete', 1)).toEqual({ ok: true }); await settled(page);
  expect(await action(page, 'compose')).toEqual({ ok: true }); expect(await page.locator('#prompt').inputValue()).toContain('pandacode_design_resolve');
  await pick(page); expect(await action(page, 'cancel')).toEqual({ ok: true }); await expect(page.locator('#design-comment-text')).toHaveCount(0);
  expect(await action(page, 'refresh')).toEqual({ ok: true }); await expect.poll(async () => (await props(page)).loading).toBe(false);
  await page.getByRole('button', { name: 'Design tools', exact: true }).click();
  await page.locator('[data-design="comment"]').focus(); await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menuitem', { name: 'Design tools', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-design="comment"]')).toBeFocused();
  expect(await page.locator('iframe[title="home.html"]').evaluate((f: HTMLIFrameElement) => f.contentDocument === (window as any).__designDocument)).toBe(true);
  expect(await calls(page, 'send_prompt')).toHaveLength(0);
});
test('design: pending save plus live input, disable/safe mode and hide preserve draft without duplicate save', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await pick(page);
  const textarea = await page.locator('#design-comment-text').elementHandle(), selection = (await props(page)).selection;
  await page.locator('#design-comment-text').fill('Captured first');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'design_save_comments'; });
  expect(await action(page, 'save')).toEqual({ ok: true }); expect(await action(page, 'save')).toEqual({ ok: false, reason: 'Busy' });
  await page.locator('#design-comment-text').fill('Second draft during save');
  await page.locator('#design-comment-text').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true })));
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.design', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  await expect(page.locator('#design-comment-text')).toHaveValue('Second draft during save');
  expect(await textarea!.evaluate(node => node === document.querySelector('#design-comment-text'))).toBe(true);
  expect((await props(page)).selection).toBe(selection); expect(await calls(page, 'design_save_comments')).toHaveLength(1);
  expect((await calls(page, 'design_save_comments'))[0].args.comments.at(-1).text).toBe('Captured first');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await expect(page.locator('.design-board iframe')).toHaveCount(0);
  await page.locator('.inspector-tabs [data-action="tab-design"]').click(); await expect(page.locator('#design-comment-text')).toHaveValue('Second draft during save');
  await expect(page.locator('[data-design-provider]')).toHaveCount(0);
  await page.locator('.design-new [type="submit"]').click(); await settled(page); expect(await calls(page, 'design_save_comments')).toHaveLength(2);
  expect(await calls(page, 'send_prompt')).toHaveLength(0);
});
test('design: save failure, conflict/future/fault recovery, stale project and replay fail closed', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.design'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.design/comments' }] };
  const future = structuredClone(other); future.id = 'future.design'; future.contributes.components[0].id = 'future.design/comments'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Design presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.design/comments"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Design presentation', { exact: true }).selectOption('sample.design/comments'); await back(page); await pick(page);
  await page.locator('#design-comment-text').fill('Keep after failure'); await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'design_save_comments'; });
  expect(await action(page, 'save')).toEqual({ ok: true }); await settled(page); await expect(page.locator('#design-comment-text')).toHaveValue('Keep after failure');
  expect((await props(page)).comments).toHaveLength(1);
  expect(await action(page, 'draft')).toEqual({ ok: true });
  expect(await page.evaluate(() => (window as any).__previewDesignAction((window as any).__capturedDesign))).toEqual({ ok: false, reason: 'AlreadyApplied' });
  expect(await action(page, 'execute')).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await commentAction(page, 'resolve')).toEqual({ ok: true }); await settled(page);
  await page.evaluate(() => { (window as any).__staleDesign = (window as any).__capturedDesign; });
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await page.evaluate(() => (window as any).__previewDesignAction((window as any).__staleDesign))).toEqual({ ok: false, reason: 'StaleContext' });
  await openInspectorTab(page, 'tab-design'); await page.locator('.inspector-tabs [data-action="tab-design"]').click();
  await expect.poll(async () => (await props(page)).loading).toBe(false);
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyDesignPresentation(document.querySelector('#design-panel'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-design-presentation-status]')).toContainText('Built-in canvas remains active');
  expect(await action(page, 'comment')).toEqual({ ok: false, reason: 'Revoked' });
  const mode = (await props(page)).commenting;
  await page.locator('[data-design="comment"]').click(); await expect(page.locator('[data-design="comment"]')).toHaveAttribute('aria-pressed', String(!mode));
});
test('design: every catalogued control visibility is reversible and recovery retains current draft/view', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await pick(page); await page.locator('#design-comment-text').fill('Layout draft');
  const before = await props(page), transform = await page.locator('.design-world').evaluate(node => (node as HTMLElement).style.transform), region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.design.controls');
  for (const names of [['Cancel comment', 'Comment mode', 'Compose comments', 'Delete comment', 'Comment draft'], ['Fit artboards', 'Zoom in', 'Zoom out', 'Pan canvas', 'Reload artboards'], ['Reopen comment', 'Resolve comment', 'Add comment', 'Select element']]) {
    for (const name of names) { await region.getByRole('button', { name: `Hide ${name}`, exact: true }).click(); await region.getByRole('button', { name: `Show ${name}`, exact: true }).click(); }
    if (names[0] !== 'Reopen comment') await region.getByRole('button', { name: 'Next items', exact: true }).click();
  }
  await back(page); await expect(page.locator('#design-comment-text')).toHaveValue('Layout draft');
  expect((await props(page)).selection).toBe(before.selection); expect(await page.locator('.design-world').evaluate(node => (node as HTMLElement).style.transform)).toBe(transform);
  expect(await calls(page, 'design_save_comments')).toHaveLength(0);
});
test('design: hidden pending save and project switch complete only in the captured original task', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await pick(page); await page.locator('#design-comment-text').fill('Task A only');
  const captured = await props(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'design_save_comments'; });
  expect(await action(page, 'save')).toEqual({ ok: true });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await expect(page.locator('.design-board iframe')).toHaveCount(0);
  const request = (await calls(page, 'design_save_comments'))[0];
  await page.locator('.task-item[data-id="session-2"]').click();
  await openInspectorTab(page, 'tab-design'); await page.locator('.inspector-tabs [data-action="tab-design"]').click();
  await expect.poll(async () => (await props(page)).session).not.toBe(captured.session);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  expect(await calls(page, 'design_save_comments')).toHaveLength(1);
  expect(request.args.sessionId).toBe('session-1'); expect(request.args.comments.at(-1).text).toBe('Task A only');
  await expect(page.locator('#design-comment-text')).toHaveCount(0);
  expect(await calls(page, 'send_prompt')).toHaveLength(0);
});
test('design: reload/offline recovery and fault while editing preserve the same draft and view', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await pick(page); await page.locator('#design-comment-text').fill('Offline draft');
  const node = await page.locator('#design-comment-text').elementHandle(), before = await props(page), view = await page.locator('.design-world').evaluate(node => (node as HTMLElement).style.transform);
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'design_list'; });
  expect(await action(page, 'refresh')).toEqual({ ok: true }); await expect.poll(async () => (await props(page)).loading).toBe(false);
  await expect(page.locator('.design-empty')).toContainText('Baseline rejected design_list'); await expect(page.locator('#design-comment-text')).toHaveValue('Offline draft');
  expect(await action(page, 'refresh')).toEqual({ ok: true }); await expect.poll(async () => (await props(page)).loading).toBe(false);
  await expect(page.locator('.design-empty')).toBeHidden();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyDesignPresentation(document.querySelector('#design-panel'), () => { throw Error('controlled editing fault'); }); });
  await expect(page.locator('#design-comment-text')).toHaveValue('Offline draft');
  expect(await node!.evaluate(node => node === document.querySelector('#design-comment-text'))).toBe(true);
  expect((await props(page)).selection).toBe(before.selection); expect(await page.locator('.design-world').evaluate(node => (node as HTMLElement).style.transform)).toBe(view);
  expect(await calls(page, 'design_save_comments')).toHaveLength(0);
});
test('design: changed artboard invalidates captured resource/selection save without discarding the draft', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await pick(page); await page.locator('#design-comment-text').fill('Keep while artboard changes');
  const before = await props(page);
  expect(await action(page, 'draft')).toEqual({ ok: true });
  await page.evaluate(async () => { (window as any).__previewDesignWrite('home.html', '<h1 id="new-title">Changed artboard</h1>'); await (window as any).__previewDesignRefresh(); });
  await expect(page.frameLocator('iframe[title="home.html"]').getByRole('heading', { name: 'Changed artboard' })).toBeAttached();
  expect((await props(page)).artboards[0].revision).not.toBe(before.artboards[0].revision);
  expect(await page.evaluate(() => (window as any).__previewDesignAction((window as any).__capturedDesign))).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await action(page, 'save')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await expect(page.locator('.design-new [type="submit"]')).toBeDisabled(); await expect(page.locator('#design-comment-text')).toHaveValue('Keep while artboard changes');
  expect(await calls(page, 'design_save_comments')).toHaveLength(0);
});
