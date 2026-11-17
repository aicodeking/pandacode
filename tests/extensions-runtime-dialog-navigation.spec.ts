import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { DialogSlots, checkReveal, performReveal, type NavigationHost, type RevealTarget, type World } from '../src/extensions/runtime-dialog-navigation';

// Preview column of R0206 (dialog answers and reveal). The first group runs the deterministic model in
// src/extensions/runtime-dialog-navigation.ts, which mirrors src-tauri/src/extensions/runtime_dialog_navigation.rs (whose
// own unit tests are `runtime_dialog_navigation::tests`); the second group drives the host's real extension dialog in the
// preview app. The installed service under the pinned runtime is the native test
// `runtime_service_lifetime::tests::installed::dialog_navigation_*` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-dialog-navigation/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-dialog-navigation/main.cjs');
const OWNER = 'sample.dialog-navigation';
const DIALOG = { title: 'Pick a name', fields: [{ id: 'name', label: 'Name', kind: 'text' as const, required: true }, { id: 'sure', label: 'Sure', kind: 'switch' as const }], successMessage: 'Answered' };
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;

const world = (over: Partial<World> = {}): World => ({
  granted: true, views: [`${OWNER}/board`], settingsPages: [`${OWNER}/settings`],
  taskExists: id => id === 't1', projectDir: id => id === 'A' ? '/work/a' : null, fileExists: (_directory, path) => path === 'src/main.rs', ...over,
});

test('extensions dialog navigation: the fixture package declares the permission and a service and uses both calls', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', 'ui.dynamic']));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(validateContract('dialog', DIALOG).ok).toBe(true);
  for (const call of ['panda.ui.showDialog', 'panda.ui.reveal', "case 'twice'"]) expect(fixtureSource, call).toContain(call);
});

test('extensions dialog navigation: an answer reaches the awaiting service once, and cancel resolves as cancelled', async () => {
  const slots = new DialogSlots();
  const opened = slots.begin(OWNER, DIALOG);
  if (!opened.ok) throw new Error('begin');
  expect(slots.pending()).toEqual([{ id: opened.value.id, owner: OWNER, dialog: DIALOG }]);
  expect(code(slots.answer(opened.value.id, { status: 'confirmed', values: { name: 'Ada', sure: true } }))).toBe('ok');
  await expect(opened.value.answer).resolves.toEqual({ status: 'confirmed', values: { name: 'Ada', sure: true } });
  // The dialog is gone: a second answer is stale and reaches nobody.
  expect(code(slots.answer(opened.value.id, { status: 'cancelled' }))).toBe('NotFound');
  const second = slots.begin(OWNER, DIALOG);
  if (!second.ok) throw new Error('begin');
  slots.answer(second.value.id, { status: 'cancelled' });
  await expect(second.value.answer).resolves.toEqual({ status: 'cancelled' });
});

test('extensions dialog navigation: a second dialog by the same owner is a Conflict and the first stays open', async () => {
  const slots = new DialogSlots();
  const first = slots.begin(OWNER, DIALOG);
  if (!first.ok) throw new Error('begin');
  expect(code(slots.begin(OWNER, DIALOG))).toBe('Conflict');
  expect(slots.count(OWNER)).toBe(1);
  expect(slots.begin('sample.other', DIALOG).ok).toBe(true);
  let settled = false; void first.value.answer.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  slots.answer(first.value.id, { status: 'cancelled' });
  expect(slots.begin(OWNER, DIALOG).ok).toBe(true);
});

test('extensions dialog navigation: the service ending resolves its dialog as cancelled, only its own, and a late answer is refused', async () => {
  const slots = new DialogSlots();
  const mine = slots.begin(OWNER, DIALOG), other = slots.begin('sample.other', DIALOG);
  if (!mine.ok || !other.ok) throw new Error('begin');
  expect(slots.cancelOwner(OWNER)).toEqual([mine.value.id]);
  await expect(mine.value.answer).resolves.toEqual({ status: 'cancelled' });
  expect(slots.count('sample.other')).toBe(1);
  expect(code(slots.answer(mine.value.id, { status: 'confirmed', values: { name: 'late' } }))).toBe('NotFound');
  expect(slots.cancelOwner(OWNER)).toEqual([]);
});

test('extensions dialog navigation: malformed answers are refused with their reason and leave the dialog open', () => {
  const slots = new DialogSlots();
  const opened = slots.begin(OWNER, DIALOG);
  if (!opened.ok) throw new Error('begin');
  // Retained for predictability: the declared shape, declared fields only, a bound on size.
  for (const [answer, expected] of [[{ status: 'maybe' }, 'InvalidShape'], [{ status: 'confirmed' }, 'InvalidShape'], [{ status: 'confirmed', values: { ghost: 1 } }, 'InvalidShape'],
    [{ status: 'cancelled', values: {} }, 'InvalidShape'], [{ status: 'confirmed', values: { name: 'x'.repeat(70_000) } }, 'LimitExceeded'], ['confirmed', 'InvalidShape']] as const) {
    expect(code(slots.answer(opened.value.id, answer)), JSON.stringify(answer).slice(0, 60)).toBe(expected);
  }
  expect(slots.count(OWNER)).toBe(1);
});

test('extensions dialog navigation: reveal names a view, a task, a file or a settings page that exist now', () => {
  const targets: RevealTarget[] = [{ view: `${OWNER}/board` }, { taskId: 't1' }, { settingsPage: `${OWNER}/settings` }, { projectId: 'A', path: 'src/main.rs', line: 12 }, { projectId: 'A', path: 'src/main.rs', editor: `${OWNER}/editor` }];
  for (const target of targets) expect(checkReveal(OWNER, world(), target)).toEqual({ ok: true, value: target });
});

test('extensions dialog navigation: reveal refuses unknown and stale context, foreign owners and bad shapes, each with its reason', () => {
  for (const [raw, expected] of [
    // Unknown or stale context: the task or project is gone, the file is gone, the view or page does not exist.
    [{ taskId: 'ghost' }, 'NotFound'], [{ view: `${OWNER}/ghost` }, 'NotFound'], [{ settingsPage: `${OWNER}/ghost` }, 'NotFound'], [{ projectId: 'B', path: 'src/main.rs' }, 'NotFound'], [{ projectId: 'A', path: 'src/gone.rs' }, 'NotFound'],
    // Foreign owner: an id names its own package's things.
    [{ view: 'sample.other/board' }, 'PermissionDenied'], [{ settingsPage: 'sample.other/settings' }, 'PermissionDenied'], [{ projectId: 'A', path: 'src/main.rs', editor: 'sample.other/editor' }, 'PermissionDenied'],
    // Shape: a path is relative and stays inside the project; a line is positive; one target at a time.
    [{ projectId: 'A', path: '../secret' }, 'InvalidShape'], [{ projectId: 'A', path: '/etc/passwd' }, 'InvalidShape'], [{ projectId: 'A', path: 'src/main.rs', line: 0 }, 'InvalidShape'],
    [{ taskId: 't1', view: `${OWNER}/board` }, 'InvalidShape'], [{}, 'InvalidShape'], ['t1', 'InvalidShape'], [{ taskId: 7 }, 'InvalidShape'],
  ] as const) expect(code(checkReveal(OWNER, world(), raw)), JSON.stringify(raw)).toBe(expected);
  // Without the grant nothing is revealed.
  expect(code(checkReveal(OWNER, world({ granted: false }), { taskId: 't1' }))).toBe('PermissionDenied');
});

test('extensions dialog navigation: the host navigates only what still exists and never sends a message', async () => {
  const log: string[] = [];
  const host: NavigationHost = {
    selectTask: id => { log.push(`task:${id}`); return id === 't1'; }, openView: id => { log.push(`view:${id}`); return true; },
    openFile: (project, path, options) => { log.push(`file:${project}:${path}:${options.line ?? ''}`); return true; }, openSettingsPage: id => { log.push(`page:${id}`); return true; },
  };
  expect(await performReveal(host, { taskId: 't1' })).toBe(true);
  expect(await performReveal(host, { view: `${OWNER}/board` })).toBe(true);
  expect(await performReveal(host, { projectId: 'A', path: 'src/main.rs', line: 3 })).toBe(true);
  expect(await performReveal(host, { settingsPage: `${OWNER}/settings` })).toBe(true);
  // The task went between the check and the navigation: the host reports it did not navigate.
  expect(await performReveal(host, { taskId: 'gone' })).toBe(false);
  expect(log).toEqual(['task:t1', `view:${OWNER}/board`, 'file:A:src/main.rs:3', `page:${OWNER}/settings`, 'task:gone']);
});

// ---- the host dialog in the preview app ---------------------------------------------------------------------------

const modal = (page: Page) => page.locator('#dialog');
const answers = (page: Page) => page.evaluate(() => (window as unknown as { __runtimeDialogAnswers?: { id: string; answer: unknown }[] }).__runtimeDialogAnswers ?? []);
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __runtimeDialogs?: unknown }).__runtimeDialogs))).toBe(true);
}
const deliver = (page: Page, id: string) => page.evaluate(({ id, dialog }) => (window as any).__runtimeDialogs.receive({ id, owner: 'sample.dialog-navigation', dialog }), { id, dialog: DIALOG });

test('extensions dialog navigation: a service dialog opens in the host modal and a click answers it', async ({ page }) => {
  await setup(page);
  await page.locator('#prompt').focus();
  await deliver(page, 'd1');
  await expect(modal(page)).toBeVisible();
  await expect(modal(page)).toHaveAccessibleName('Pick a name — sample.dialog-navigation');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Ada');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(modal(page)).not.toBeVisible();
  expect(await answers(page)).toEqual([{ id: 'd1', answer: { status: 'confirmed', values: { name: 'Ada', sure: false } } }]);
  // The focus returns to what had it.
  await expect(page.locator('#prompt')).toBeFocused();
});

test('extensions dialog navigation: Escape cancels, and a composing Enter or Escape (IME) does neither', async ({ page }) => {
  await setup(page);
  await deliver(page, 'd2');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Ada');
  // Key events during composition (keyCode 229) must not submit or cancel.
  await name.evaluate(node => { for (const key of ['Enter', 'Escape']) node.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); });
  await expect(modal(page)).toBeVisible();
  expect(await answers(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(modal(page)).not.toBeVisible();
  expect(await answers(page)).toEqual([{ id: 'd2', answer: { status: 'cancelled' } }]);
});

test('extensions dialog navigation: a second dialog waits for the open one, and the service ending removes shown and waiting ones without an answer', async ({ page }) => {
  await setup(page);
  await deliver(page, 'd3'); await expect(modal(page)).toBeVisible();
  await page.evaluate(({ dialog }) => (window as any).__runtimeDialogs.receive({ id: 'd4', owner: 'sample.other', dialog }), { dialog: DIALOG });
  await expect(modal(page)).toHaveAccessibleName('Pick a name — sample.dialog-navigation');
  // The waiting one shows after the first is answered.
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveAccessibleName('Pick a name — sample.other');
  await deliver(page, 'd5');
  // Revoke, disable or safe mode ends the service: the host closes the shown dialog and drops the waiting one.
  await page.evaluate(() => { (window as any).__runtimeDialogs.close('d5'); (window as any).__runtimeDialogs.close('d4'); });
  await expect(modal(page)).not.toBeVisible();
  const sent = await answers(page);
  expect(sent.map(entry => entry.id)).toEqual(['d3']);
});
