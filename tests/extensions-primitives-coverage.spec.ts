import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser preview evidence for the shared declarative primitives through one installable public package
// (tests/fixtures/extensions/primitives). Installed WebView/native menu qualification is separate and not claimed here.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/primitives/extension.json', import.meta.url), 'utf8'));
const OWNER = 'sample.primitives';
const contribution = (page: Page, id: string) => page.locator(`[data-extension-contribution="${OWNER}/${id}"]`);
const trigger = (page: Page) => contribution(page, 'tools');
const modal = (page: Page) => page.locator('#dialog');
const notes = (page: Page) => page.getByRole('textbox', { name: 'Form notes', exact: true });
const calls = (page: Page) => page.evaluate(() => (window as any).__extensionDialogTransport.calls);
const toasts = (page: Page) => page.evaluate(() => (window as any).__primitiveToasts as string[]);
const live = (page: Page) => page.evaluate(() => (window as any).__primitiveLive());

async function setup(page: Page, { seed = true, query = '' } = {}) {
  await page.addInitScript(({ manifest, seed }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(seed ? [{ manifest, enabled: true, icons: {} }] : []));
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    // Live (non-once) listeners on window, document and the shared top-layer dialogs, plus connected observers.
    const listeners = new Map<string, Set<unknown>>(), observers = new Set<MutationObserver>();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const key = (target: unknown, type: string) => target === window ? `window:${type}` : target === document ? `document:${type}` : target instanceof HTMLDialogElement && ['dialog', 'extension-nested-dialog'].includes(target.id) ? `${target.id}:${type}` : '';
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
      const k = key(this, type);
      if (k && listener && !(typeof options === 'object' && options?.once)) {
        if (!listeners.has(k)) listeners.set(k, new Set());
        const set = listeners.get(k)!; set.add(listener);
        const signal: AbortSignal | undefined = typeof options === 'object' ? options?.signal : undefined;
        if (signal) add.call(signal, 'abort', () => set.delete(listener), { once: true });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: any, options?: any) { const k = key(this, type); if (k) listeners.get(k)?.delete(listener); return remove.call(this, type, listener, options); };
    const observe = MutationObserver.prototype.observe, disconnect = MutationObserver.prototype.disconnect;
    MutationObserver.prototype.observe = function (this: MutationObserver, ...args: any[]) { observers.add(this); return (observe as any).apply(this, args); };
    MutationObserver.prototype.disconnect = function (this: MutationObserver) { observers.delete(this); return disconnect.call(this); };
    (window as any).__primitiveLive = () => ({ listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0), observers: observers.size, byKey: Object.fromEntries([...listeners].map(([k, v]) => [k, v.size]).filter(([, size]) => size)) });
  }, { manifest, seed });
  await page.goto(`/?extensions-baseline&primitives-coverage${query}`);
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(() => {
    const toast = document.querySelector('#toast')!; (window as any).__primitiveToasts = [];
    new MutationObserver(() => { const text = toast.textContent?.trim(); if (text) (window as any).__primitiveToasts.push(text); }).observe(toast, { childList: true, characterData: true, subtree: true });
  });
  if (seed) await expect(trigger(page)).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function openForm(page: Page) {
  await trigger(page).click();
  await expect(page.getByRole('menuitem', { name: 'Primitives', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Forms', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Open form', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(modal(page)).toBeVisible(); await expect(modal(page)).toHaveAccessibleName(`Primitive form — ${OWNER}`);
}
async function fill(page: Page) {
  await page.getByRole('textbox', { name: 'Form name', exact: true }).fill('Weekly');
  await notes(page).fill('First line\nSecond line');
  await page.getByRole('button', { name: 'Form format', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Full', exact: true }).click();
}

test('extensions primitives: the public package installs from zero and renders every action, icon and recursive menu primitive', async ({ page }) => {
  await setup(page, { seed: false });
  await expect(page.locator(`[data-extension-contribution^="${OWNER}/"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Primitive preferences', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Enable ${OWNER}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  // Icon button: accessible name from the command, decorative validated SVG hidden from assistive technology.
  await expect(trigger(page)).toHaveAccessibleName('Primitive form'); await expect(trigger(page)).toHaveAttribute('aria-haspopup', 'menu');
  await expect(trigger(page).locator('svg[aria-hidden="true"]')).toHaveCount(1); await expect(trigger(page)).not.toHaveAttribute('data-extension-icon-fallback', 'true');
  await expect(contribution(page, 'gallery-button')).toHaveAccessibleName('Primitive gallery'); await expect(contribution(page, 'gallery-button')).toHaveText('Primitive gallery');
  await expect(contribution(page, 'count')).toHaveAttribute('aria-label', 'Primitive notification: 3'); await expect(contribution(page, 'count')).toContainText('3');
  await expect(page.getByRole('status', { name: 'Primitives ready', exact: true })).toBeVisible();
  // Recursive menu: Right opens, Left returns, Up/Down/Home/End stay in a level, Escape closes one level.
  await trigger(page).click();
  await expect(page.getByRole('menuitem', { name: 'Primitives', exact: true })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: 'Primitives', exact: true }).locator('svg[aria-hidden="true"]')).not.toHaveCount(0);
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Forms', exact: true })).toBeFocused();
  await expect(page.locator('.choice-menu').getByRole('separator')).toHaveCount(1);
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show details', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { name: 'Compact', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Comfortable', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('End'); await expect(page.getByRole('menuitemradio', { name: 'Comfortable', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem', { name: 'Forms', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('menuitem', { name: 'Open form', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(page.getByRole('menuitem', { name: 'Forms', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem', { name: 'Primitives', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  // Checkbox state and the notification primitive; each activation shows one host toast.
  await trigger(page).click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show details', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Primitive details toggled'); await expect(trigger(page)).toBeFocused();
  await trigger(page).click(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show details', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Send notification', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Primitive notification');
  expect((await toasts(page)).filter(text => text.startsWith('Primitive '))).toEqual(['Primitive details toggled', 'Primitive notification']);
});

test('extensions primitives: text, textarea, switch, select and async multi-select keep IME, Enter, validation and focus contracts', async ({ page }) => {
  await setup(page); await openForm(page);
  await expect(page.getByRole('textbox', { name: 'Form name', exact: true })).toBeFocused();
  await expect(notes(page)).toHaveAttribute('rows', '5'); await expect(notes(page)).toHaveAttribute('maxlength', '4096'); await expect(notes(page)).toHaveAttribute('aria-required', 'true');
  expect(await notes(page).evaluate(node => node.tagName)).toBe('TEXTAREA');
  // Enter inserts a line break and never submits; IME composition keys are swallowed before the form sees them.
  await notes(page).focus(); await page.keyboard.type('First line'); await page.keyboard.press('Enter'); await page.keyboard.type('Second line');
  await expect(notes(page)).toHaveValue('First line\nSecond line'); expect(await calls(page)).toEqual([]);
  const prevented = await notes(page).evaluate(node => [
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })),
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })),
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })),
  ]);
  expect(prevented).toEqual([true, true, true]); await expect(modal(page)).toBeVisible(); expect(await calls(page)).toEqual([]);
  // Local validation keeps every value and marks the invalid fields.
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(modal(page).getByRole('alert')).toHaveText('Check the highlighted fields.');
  await expect(page.getByRole('textbox', { name: 'Form name', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('textbox', { name: 'Form name', exact: true })).toBeFocused();
  await expect(notes(page)).toHaveAttribute('aria-invalid', 'false'); await expect(notes(page)).toHaveValue('First line\nSecond line');
  // Select: label/value separation, placeholder, disabled option, keyboard search, Escape returns to the field.
  await expect(page.getByRole('button', { name: 'Form format', exact: true })).toHaveText('Choose a format');
  await page.getByRole('button', { name: 'Form format', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Archived', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search Form format', exact: true }).fill('ful');
  await expect(page.getByRole('menuitemradio', { name: 'Brief', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Form format', exact: true })).toBeFocused();
  await fill(page);
  await expect(page.getByRole('button', { name: 'Form format', exact: true })).toHaveText('Full');
  // Async quick pick: loading, error/retry (offline transport) and multi-select.
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await page.getByRole('button', { name: 'Form tags', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading options…' })).toBeVisible();
  await page.evaluate(() => { const t = (window as any).__extensionDialogTransport; t.failOptions = true; t.holdOptions = false; t.releaseAll(); });
  await expect(page.getByRole('alert').filter({ hasText: 'Options could not be loaded.' })).toBeVisible();
  await page.evaluate(() => { (window as any).__extensionDialogTransport.failOptions = false; });
  await page.getByRole('button', { name: 'Retry options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click(); await page.getByRole('menuitemcheckbox', { name: 'Gamma', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Form tags', exact: true })).toHaveText('Alpha, Gamma');
  await expect(page.getByRole('switch', { name: 'Form enabled', exact: true })).toBeChecked();
  await page.getByRole('switch', { name: 'Form enabled', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
  await expect(page.locator('#toast')).toHaveText('Primitive form saved');
  const validation = (await calls(page)).filter((call: any) => call.kind === 'validate');
  expect(validation).toHaveLength(1);
  expect(validation[0].values).toEqual({ name: 'Weekly', notes: 'First line\nSecond line', enabled: false, format: 'full', tags: ['alpha', 'gamma'] });
  expect((await toasts(page)).filter(text => text.startsWith('Primitive form'))).toEqual(['Primitive form saved']);
});

test('extensions primitives: cancel, disable and fault settle once and leave zero owned listeners or observers', async ({ page }) => {
  await setup(page);
  const cycle = async () => {
    await openForm(page); await notes(page).fill('Draft');
    await page.getByRole('button', { name: 'Form tags', exact: true }).click(); await expect(page.getByRole('menuitemcheckbox', { name: 'Beta', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Form tags', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
  };
  await cycle(); // Warm lazily loaded host modules once.
  const baseline = await live(page);
  for (let i = 0; i < 3; i++) await cycle();
  expect(await live(page)).toEqual(baseline);
  expect((await toasts(page)).filter(text => text === 'Primitive form cancelled')).toHaveLength(4);
  // Disable while validation is pending: the request aborts, the late reply is ignored and focus survives.
  await openForm(page); await fill(page);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.getByRole('button', { name: 'Save form', exact: true }).click();
  await expect(modal(page).getByRole('status')).toHaveText('Validating…');
  const pending = (await calls(page)).length - 1;
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.primitives'); });
  await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toHaveCount(0);
  expect((await calls(page))[pending].aborted).toBe(true);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.locator('#prompt')).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.isConnected)).toBe(true);
  expect((await toasts(page)).filter(text => ['Primitive form saved'].includes(text))).toEqual([]);
  expect((await toasts(page)).filter(text => text === 'Primitive form cancelled')).toHaveLength(4);
  expect((await live(page)).listeners).toBeLessThanOrEqual(baseline.listeners); expect((await live(page)).observers).toBeLessThanOrEqual(baseline.observers);
  // Re-enabling restores the same contributions and dormant menu choices; a corrupt package record bypasses activation.
  await page.evaluate(async () => { await (window as any).__previewEnableExtension('sample.primitives'); });
  await expect(trigger(page)).toBeVisible();
  await page.evaluate(manifest => {
    const broken = structuredClone(manifest); broken.contributes.commands[0].action.dialog.fields[1].rows = 99;
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest: broken, enabled: true, icons: {} }]));
  }, manifest);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator(`[data-extension-contribution^="${OWNER}/"]`)).toHaveCount(0);
  await page.locator('#prompt').fill('Core input still works'); await expect(page.locator('#prompt')).toHaveValue('Core input still works');
});

test('extensions primitives: view list, tree, table, tabs, progress and toolbar keep names, keyboard and safe fallback', async ({ page }) => {
  await setup(page);
  await contribution(page, 'gallery-button').click();
  const panel = page.getByRole('region', { name: `Primitive gallery — ${OWNER}`, exact: true });
  await expect(panel).toBeVisible(); await expect(panel).toContainText(`Extension: ${OWNER}`);
  await expect(panel.getByRole('list', { name: 'Primitive list', exact: true }).getByRole('listitem')).toHaveText(['First entry', 'Second entry']);
  await expect(panel.getByRole('table', { name: 'Primitive table', exact: true })).toContainText('BetaPending');
  await expect(panel.getByRole('columnheader')).toHaveText(['Name', 'State']);
  await expect(panel.getByRole('progressbar', { name: 'Primitive progress', exact: true })).toHaveAttribute('value', '40');
  const parent = panel.getByRole('treeitem', { name: 'Parent node', exact: true });
  await expect(parent).toHaveAttribute('tabindex', '0');
  await parent.focus(); await page.keyboard.press('ArrowRight'); await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown'); await expect(panel.getByRole('treeitem', { name: 'Child node', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(panel.getByRole('treeitem', { name: 'Leaf node', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await panel.getByRole('tab', { name: 'Overview', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'History', exact: true })).toBeFocused();
  await expect(panel.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tabpanel')).toHaveText('History content.');
  await panel.getByRole('toolbar', { name: 'Primitive gallery tools', exact: true }).getByRole('button', { name: 'Primitive notification', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('Primitive notification');
  // The same dialog primitive opens from the view toolbar and returns focus there.
  const form = panel.getByRole('button', { name: 'Primitive form', exact: true });
  await form.press('Enter'); await expect(modal(page)).toBeVisible(); await expect(notes(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(modal(page)).not.toBeVisible(); await expect(form).toBeFocused();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.primitives'); });
  await expect(panel).toHaveCount(0); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('.inspector-tab [role="tab"][aria-selected="true"]')).toHaveCount(1);
});

test('extensions primitives: settings textarea saves multi-line values with the IME guard and namespace validation', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Primitive preferences', exact: true }).click();
  const summary = page.getByRole('textbox', { name: 'Preference summary', exact: true });
  await expect(summary).toHaveValue('First line'); await expect(summary).toHaveAttribute('rows', '3');
  await summary.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Second line');
  await summary.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  const stored = () => page.evaluate(() => localStorage.getItem('pandacode.preview.extension-settings.v1.sample.primitives.sample.primitives/preferences'));
  expect(await stored()).toBeNull();
  await page.getByRole('checkbox', { name: 'Preference active', exact: true }).check();
  await page.getByRole('button', { name: 'Save extension settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Extension settings saved.' })).toBeVisible();
  expect(JSON.parse((await stored())!)).toEqual({ summary: 'First line\nSecond line', active: true });
});

test('extensions primitives: shared tokens hold in light, dark, increased contrast, forced colors, reduced motion and transparency', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await setup(page);
  const probe = () => page.evaluate(() => {
    const dialog = document.querySelector('#dialog')!, textarea = dialog.querySelector('textarea')!, input = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
    const reference = document.createElement('div'); reference.style.border = '1px solid var(--ds-border)'; dialog.append(reference);
    const style = getComputedStyle(textarea), result = {
      border: style.borderTopColor, input: getComputedStyle(input).borderTopColor, reference: getComputedStyle(reference).borderTopColor,
      color: style.color, transition: style.transitionDuration, theme: document.documentElement.dataset.theme,
      plate: [...document.querySelectorAll<HTMLElement>('.dialog-plate')].filter(plate => !plate.hidden).map(plate => getComputedStyle(plate).backdropFilter),
    };
    reference.remove(); return result;
  });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(theme => localStorage.setItem('pandacode.theme', theme), theme);
    await page.reload(); await expect(page.locator('#prompt')).toBeEnabled(); await expect(trigger(page)).toBeVisible();
    for (const mode of ['default', 'contrast', 'forced', 'reduced'] as const) {
      await page.emulateMedia({ colorScheme: theme, contrast: mode === 'contrast' ? 'more' : 'no-preference', forcedColors: mode === 'forced' ? 'active' : 'none', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      await openForm(page);
      const values = await probe();
      expect(values.theme).toBe(theme);
      // The textarea draws the same --ds-border hairline as any token consumer in every mode (forced colors included).
      expect(values.border, `${theme}/${mode}`).toBe(values.reference);
      if (mode !== 'forced') expect(values.border, `${theme}/${mode}`).toBe(values.input);
      expect(values.border).not.toBe('rgba(0, 0, 0, 0)'); expect(values.color).not.toBe('rgba(0, 0, 0, 0)');
      expect(parseFloat(values.transition) === 0, `${theme}/${mode} transition`).toBe(mode === 'reduced');
      if (mode === 'contrast') expect(values.plate.every(filter => filter === 'none')).toBe(true);
      // Keyboard focus is visible on the textarea in every mode.
      await page.keyboard.press('Tab'); await expect(notes(page)).toBeFocused();
      const ring = await notes(page).evaluate(node => { const s = getComputedStyle(node); return s.boxShadow !== 'none' || s.outlineStyle !== 'none'; });
      expect(ring, `${theme}/${mode} focus`).toBe(true);
      await page.keyboard.press('Escape'); await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
    }
  }
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
    await openForm(page);
    const plates = (await probe()).plate; expect(plates.length).toBeGreaterThan(0); expect(plates.every(filter => filter === 'none')).toBe(true);
    await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
    await cdp.detach();
  }
});
