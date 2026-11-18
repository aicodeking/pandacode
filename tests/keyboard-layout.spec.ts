import { expect, test, type Locator, type Page } from '@playwright/test';

const prompt = (page: Page) => page.locator('#prompt');
const canvas = (page: Page) => page.getByRole('img', { name: /Mockup canvas/ });
const modifiers = [{ name: 'Cmd', metaKey: true }, { name: 'Ctrl', ctrlKey: true }] as const;
const imeStates = [{ isComposing: true }, { keyCode: 229 }] as const;

// Playwright's keyboard uses a US layout; dispatch the key/code pairs real layouts produce.
async function key(target: Locator, init: KeyboardEventInit): Promise<boolean> {
  return target.evaluate((element, init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, init);
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toBeEnabled();
}

async function sketch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem', { name: /Sketch a mockup…/ }).click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).focus();
}

test.describe('keyboard layouts', () => {
  for (const mod of modifiers) {
    test(`${mod.name} Russian commands use physical letters and comma`, async ({ page }) => {
      await open(page);
      await prompt(page).focus();
      // Dvorak puts the character k on V; it must not open the command palette.
      expect(await key(prompt(page), { key: 'k', code: 'KeyV', ...mod })).toBe(false);
      // The capture listener must still work when the focused field stops bubbling.
      await prompt(page).evaluate(element => element.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).code === 'KeyB' && !(event as KeyboardEvent).shiftKey) event.stopPropagation();
      }));
      expect(await key(prompt(page), { key: 'и', code: 'KeyB', ...mod })).toBe(true);
      await expect(page.locator('.workspace')).toHaveClass(/sidebar-collapsed/);
      await key(prompt(page), { key: 'и', code: 'KeyB', ...mod });
      await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);
      const inspector = page.locator('#inspector');
      const wasHidden = await inspector.isHidden();
      await key(prompt(page), { key: 'И', code: 'KeyB', shiftKey: true, ...mod });
      await expect(inspector).toBeVisible({ visible: wasHidden });
      await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);

      await key(prompt(page), { key: 'л', code: 'KeyK', ...mod });
      const search = page.getByRole('textbox', { name: 'Search tasks and commands' });
      await expect(search).toBeFocused();
      await search.press('Escape');

      await key(prompt(page), { key: 'а', code: 'KeyF', ...mod });
      const find = page.getByRole('searchbox', { name: 'Find in thread', exact: true });
      await expect(find).toBeFocused();
      await find.fill('search');
      const count = page.locator('.thread-find-count');
      await expect(count).toHaveText(/^\d+ of \d+$/);
      const [start, total] = (await count.innerText()).split(' of ').map(Number);
      expect(total).toBeGreaterThan(1);
      await key(find, { key: 'п', code: 'KeyG', ...mod });
      await expect(count).toHaveText(`${start % total + 1} of ${total}`);
      await key(find, { key: 'П', code: 'KeyG', shiftKey: true, ...mod });
      await expect(count).toHaveText(`${start} of ${total}`);
      await find.press('Escape');

      await key(prompt(page), { key: 'о', code: 'KeyJ', ...mod });
      await expect(page.locator('#terminal-drawer')).toBeVisible();
      await key(prompt(page), { key: 'о', code: 'KeyJ', ...mod });
      await expect(page.locator('#terminal-drawer')).toBeHidden();
      await key(prompt(page), { key: 'б', code: 'Comma', ...mod });
      const settings = page.getByRole('region', { name: 'Settings', exact: true });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      await key(prompt(page), { key: 'т', code: 'KeyN', ...mod });
      await expect(prompt(page)).not.toHaveAttribute('data-session-id', 'session-1');
      await expect(prompt(page)).toBeFocused();
      const draft = await prompt(page).getAttribute('data-session-id');
      // Dvorak puts b on N; this creates a task rather than toggling the sidebar.
      await key(prompt(page), { key: 'b', code: 'KeyN', ...mod });
      await expect(prompt(page)).not.toHaveAttribute('data-session-id', draft!);
      await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);
    });

    test(`${mod.name} Russian toast undo keeps its modifier and typing guards`, async ({ page }) => {
      await open(page);
      const row = page.locator('#navigation .task-item[data-id="session-3"]');
      await row.focus();
      await row.press('ControlOrMeta+Enter');
      await expect(page.locator('#toast')).toContainText('Task settled');
      await expect(page.locator('#navigation [data-thread-group="completed"]')).toBeVisible();
      const body = page.locator('body');
      for (const extra of [{ shiftKey: true }, { altKey: true }, ...imeStates]) {
        expect(await key(body, { key: 'я', code: 'KeyZ', ...mod, ...extra })).toBe(false);
      }
      expect(await key(prompt(page), { key: 'я', code: 'KeyZ', ...mod })).toBe(false);
      expect(await key(body, { key: 'я', code: 'KeyZ', ...mod })).toBe(true);
      await expect(page.locator('#navigation [data-thread-group="completed"]')).toHaveCount(0);
      await expect(row).toBeVisible();
    });

    test(`${mod.name} Russian sketch tools, duplicate, undo and redo`, async ({ page }) => {
      await open(page);
      await sketch(page);
      for (const [letter, physical, tool] of [['м', 'V', 'select'], ['з', 'P', 'pen'], ['к', 'R', 'rect'], ['щ', 'O', 'ellipse'], ['д', 'L', 'line'], ['ф', 'A', 'arrow'], ['е', 'T', 'text']]) {
        expect(await key(canvas(page), { key: letter, code: `Key${physical}` })).toBe(true);
        await expect(page.locator('.sketch-editor')).toHaveAttribute('data-tool', tool);
      }
      await page.getByRole('button', { name: 'Add button', exact: true }).click();
      expect(await key(canvas(page), { key: 'в', code: 'KeyD', ...mod })).toBe(true);
      await expect(canvas(page)).toHaveAccessibleName('Mockup canvas, 2 shapes, button selected');
      await key(canvas(page), { key: 'я', code: 'KeyZ', ...mod });
      await expect(canvas(page)).toHaveAccessibleName('Mockup canvas, 1 shape');
      await key(canvas(page), { key: 'Я', code: 'KeyZ', shiftKey: true, ...mod });
      await expect(canvas(page)).toHaveAccessibleName('Mockup canvas, 2 shapes');
      for (const extra of [{ altKey: true }, ...imeStates]) {
        expect(await key(canvas(page), { key: 'в', code: 'KeyD', ...mod, ...extra })).toBe(false);
        expect(await key(canvas(page), { key: 'я', code: 'KeyZ', ...mod, ...extra })).toBe(false);
      }
      await expect(canvas(page)).toHaveAccessibleName('Mockup canvas, 2 shapes');
    });
  }

  test('logical slash works on AZERTY and Dvorak without taking question mark or modified slash', async ({ page }) => {
    await open(page);
    const body = page.locator('body'), filter = page.locator('#sidebar-filter');
    for (const init of [{ key: '/', code: 'Period', shiftKey: true }, { key: '/', code: 'BracketLeft' }]) {
      expect(await key(body, init)).toBe(true);
      await expect(filter).toBeFocused();
      await filter.press('Escape');
    }
    for (const init of [
      { key: '?', code: 'Slash', shiftKey: true }, { key: '.', code: 'Slash' },
      { key: '/', code: 'Slash', ctrlKey: true }, { key: '/', code: 'Slash', metaKey: true },
      { key: '/', code: 'Slash', altKey: true }, ...imeStates.map(ime => ({ key: '/', code: 'Slash', ...ime })),
    ]) {
      expect(await key(body, init)).toBe(false);
      await expect(filter).not.toBeFocused();
    }
    expect(await key(prompt(page), { key: '/', code: 'Period', shiftKey: true })).toBe(false);
  });

  test('command modifiers and both IME signals leave global shortcuts alone', async ({ page }) => {
    await open(page);
    for (const mod of modifiers) {
      for (const init of [
        { key: 'а', code: 'KeyF', shiftKey: true }, { key: 'а', code: 'KeyF', altKey: true },
        { key: 'и', code: 'KeyB', altKey: true }, { key: 'И', code: 'KeyB', shiftKey: true, altKey: true },
        { key: 'л', code: 'KeyK', altKey: true }, { key: 'т', code: 'KeyN', altKey: true },
        { key: 'о', code: 'KeyJ', altKey: true }, { key: 'б', code: 'Comma', altKey: true },
      ]) expect(await key(prompt(page), { ...mod, ...init })).toBe(false);
      for (const ime of imeStates) {
        // Latin b specifically catches the old capture listener's missing keyCode 229 guard.
        expect(await key(prompt(page), { key: 'b', code: 'KeyB', ...mod, ...ime })).toBe(false);
        for (const [letter, code] of [['и', 'KeyB'], ['л', 'KeyK'], ['а', 'KeyF'], ['п', 'KeyG'], ['т', 'KeyN'], ['о', 'KeyJ'], ['б', 'Comma'], ['Enter', 'Enter'], ['Escape', 'Escape']]) {
          expect(await key(prompt(page), { key: letter, code, ...mod, ...ime })).toBe(false);
        }
        expect(await key(prompt(page), { key: 'И', code: 'KeyB', shiftKey: true, ...mod, ...ime })).toBe(false);
      }
    }
    for (const [letter, code] of [['и', 'KeyB'], ['л', 'KeyK'], ['а', 'KeyF'], ['т', 'KeyN'], ['о', 'KeyJ']]) {
      expect(await key(prompt(page), { key: letter, code })).toBe(false);
    }
    await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);
    await expect(page.locator('#dialog')).not.toBeVisible();
    await expect(page.locator('#terminal-drawer')).toBeHidden();
    await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
  });

  test('sketch keeps modified tool keys and IME Enter/Escape with the editor', async ({ page }) => {
    await open(page);
    await sketch(page);
    for (const extra of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, ...imeStates]) {
      expect(await key(canvas(page), { key: 'з', code: 'KeyP', ...extra })).toBe(false);
    }
    expect(await key(canvas(page), { key: 'З', code: 'KeyP', shiftKey: true })).toBe(true);
    await expect(page.locator('.sketch-editor')).toHaveAttribute('data-tool', 'pen');
    await page.getByRole('button', { name: 'Add button', exact: true }).click();
    for (const ime of imeStates) {
      expect(await key(canvas(page), { key: 'Enter', code: 'Enter', ...ime })).toBe(false);
    }
    await canvas(page).press('Enter');
    const label = page.getByRole('textbox', { name: 'Label', exact: true });
    await expect(label).toBeFocused();
    for (const ime of imeStates) {
      expect(await key(label, { key: 'Enter', code: 'Enter', ...ime })).toBe(false);
      expect(await key(label, { key: 'Escape', code: 'Escape', ...ime })).toBe(false);
    }
    // The Escape handler finishes asynchronously; wait beyond that timer without a fixed sleep.
    await expect(label).toBeFocused();
    expect(await key(label, { key: 'к', code: 'KeyR' })).toBe(false);
    await expect(page.locator('.sketch-editor')).toHaveAttribute('data-tool', 'select');
    await label.press('Enter');
    await expect(label).toHaveCount(0);
    await expect(page.locator('#dialog.sketch-dialog')).toBeVisible();
  });

  test('Linux text undo and redo use physical letters while IME and terminal input stay native', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64' }));
    await open(page);
    const field = prompt(page);
    await field.focus();
    await field.evaluate(() => document.execCommand('insertText', false, 'Привет'));
    await expect(field).toHaveValue('Привет');
    for (const extra of [{ altKey: true }, { metaKey: true }, ...imeStates]) {
      expect(await key(field, { key: 'я', code: 'KeyZ', ctrlKey: true, ...extra })).toBe(false);
    }
    expect(await key(field, { key: 'я', code: 'KeyZ', ctrlKey: true })).toBe(true);
    await expect(field).toHaveValue('');
    await key(field, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    await expect(field).toHaveValue('Привет');
    await key(field, { key: 'я', code: 'KeyZ', ctrlKey: true });
    await key(field, { key: 'н', code: 'KeyY', ctrlKey: true });
    await expect(field).toHaveValue('Привет');
    await key(field, { key: 'о', code: 'KeyJ', ctrlKey: true });
    const terminal = page.locator('#terminal-drawer .xterm-helper-textarea');
    await expect(terminal).toBeAttached();
    await terminal.focus();
    expect(await key(terminal, { key: 'я', code: 'KeyZ', ctrlKey: true })).toBe(false);
  });
});
