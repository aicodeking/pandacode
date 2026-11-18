import { expect, test, type Page } from '@playwright/test';
import { prompt, pill, calls, open, start, release } from './voice-test-helpers';

test.describe('voice input', () => {
  test('wave pointer restores prompt focus and the locked selection from another control', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('Keep this draft.');
    await prompt(page).evaluate(el => el.setSelectionRange(5, 9)); await start(page);
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).focus();
    await page.locator('.voice-wave-canvas').click({ position: { x: 10, y: 10 } });
    await expect(prompt(page)).toBeFocused();
    expect(await prompt(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([5, 9]);
    await page.keyboard.press('Enter'); await release(page);
    await expect(prompt(page)).toHaveValue('Keep A dictated draft. draft.');
  });

  test('legacy WebKit popover selectors cannot break shortcuts, Escape or insertion', async ({ page }) => {
    await page.addInitScript(() => {
      for (const [prototype, name] of [[Document.prototype, 'querySelector'], [Element.prototype, 'matches']] as const) {
        const original = (prototype as any)[name];
        (prototype as any)[name] = function (selector: string, ...args: unknown[]) {
          if (selector.includes(':popover-open')) throw new DOMException('Unsupported selector', 'SyntaxError');
          return original.call(this, selector, ...args);
        };
      }
    });
    await open(page, 'delayed'); await prompt(page).focus(); await page.keyboard.press('Meta+Shift+d');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.keyboard.press('Escape'); await expect(pill(page)).toBeHidden();
    await page.keyboard.press('Meta+Shift+d'); await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.keyboard.press('Enter'); await release(page);
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('status shortcut then Escape cannot discard a pending transcription', async ({ page }) => {
    await open(page, 'delayed'); await start(page); await page.keyboard.press('Enter');
    await page.keyboard.press('Meta+Shift+d'); await expect(pill(page)).toBeFocused();
    await page.keyboard.press('Escape'); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    expect((await calls(page)).filter((c: any) => c.command === 'voice_cancel')).toHaveLength(0);
    await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('long review details are reachable and scroll with the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 580 }); await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceText = 'A lengthy transcript. '.repeat(150); });
    await start(page); await page.keyboard.press('Enter'); await prompt(page).fill('changed'); await release(page);
    await expect(pill(page)).toHaveAttribute('data-phase', 'review');
    const details = pill(page).getByRole('region', { name: 'Dictation details', exact: true });
    await prompt(page).focus(); await page.keyboard.press('Tab');
    await expect(pill(page).getByRole('button', { name: 'Insert transcript at cursor', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(pill(page).getByRole('button', { name: 'Discard dictation', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(details).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => details.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Shift+Tab');
    await expect(pill(page).getByRole('button', { name: 'Discard dictation', exact: true })).toBeFocused();
  });

  for (const key of ['Enter', 'Meta+Shift+d', 'Space']) test(`mouse start focuses the prompt and ${key} stops recording`, async ({ page }) => {
    await open(page, 'delayed'); await start(page); await expect(prompt(page)).toBeFocused();
    if (key === 'Space') await pill(page).focus();
    await page.keyboard.press(key); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
  });

  test('locked form and card accept Enter and the voice shortcut', async ({ page }) => {
    await open(page, 'delayed');
    for (const selector of ['#composer', '.voice-pill']) for (const key of ['Enter', 'Meta+Shift+d']) {
      await start(page); await page.locator(selector).focus(); await page.keyboard.press(key);
      await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
      await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await release(page);
    }
  });

  for (const width of [860, 1440]) test(`Stop and Cancel follow the prompt in keyboard order at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 940 }); await open(page, 'delayed'); await start(page);
    await prompt(page).focus(); await page.keyboard.press('Tab');
    await expect(pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(pill(page).getByRole('button', { name: 'Cancel dictation', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Attach files for context', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(pill(page).getByRole('button', { name: 'Cancel dictation', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true })).toBeFocused();
    expect(await pill(page).locator('.voice-context').evaluate(el => el.tabIndex)).toBeLessThan(0);
    expect(await pill(page).evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('.composer-tray')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });

  test('Stop activated twice from the keyboard never activates Cancel', async ({ page }) => {
    await open(page, 'delayed');
    await start(page);
    const stop = pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true });
    await stop.focus();
    await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await page.keyboard.press('Enter');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    expect((await calls(page)).some((c: any) => c.command === 'voice_cancel')).toBe(false);
    await release(page);
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('voice shortcut ignores other editable controls and completion preserves their focus', async ({ page }) => {
    await open(page, 'delayed');
    // Isolated editable targets outside the composer exercise the document shortcut guard.
    await page.evaluate(() => {
      for (const tag of ['input', 'textarea', 'div']) {
        const el = document.createElement(tag); el.id = `other-${tag}`;
        if (tag === 'div') el.contentEditable = 'true';
        el.style.cssText = 'position:fixed;top:80px;left:40px;z-index:9999';
        document.body.append(el);
      }
    });
    for (const tag of ['input', 'textarea', 'div']) {
      await page.locator(`#other-${tag}`).focus();
      await page.keyboard.press('Control+Shift+d');
      expect((await calls(page)).some((c: any) => c.command === 'voice_start')).toBe(false);
      await expect(page.locator(`#other-${tag}`)).toBeFocused();
    }
    await start(page);
    await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    await page.locator('#other-input').focus();
    await release(page);
    await expect(page.locator('#other-input')).toBeFocused();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
  });

  test('keyboard shortcut starts, IME Escape does not cancel, Escape cancels', async ({ page }) => {
    await open(page);
    await prompt(page).press('Control+Shift+d');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await prompt(page).evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const key of ['Escape', 'Enter']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true });
        // WebKit ignores constructor init values for these read-only properties.
        Object.defineProperties(event, { isComposing: { value: true }, keyCode: { value: 229 } });
        el.dispatchEvent(event);
      }
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await prompt(page).press('Escape');
    await expect(pill(page)).toBeHidden();
  });

  test('the composer form is focusable only while dictation owns it', async ({ page }) => {
    await open(page, 'delayed');
    const composer = page.locator('#composer');
    const focusable = () => composer.evaluate(el => { const had = el.getAttribute('tabindex'); (el as HTMLElement).focus(); const focused = document.activeElement === el; (document.querySelector('#prompt') as HTMLElement).focus(); return { tabindex: had, focused }; });
    expect(await focusable()).toEqual({ tabindex: null, focused: false });
    await start(page); expect(await composer.getAttribute('tabindex')).toBe('-1');
    await page.keyboard.press('Enter'); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    expect(await composer.getAttribute('tabindex')).toBe('-1');
    await release(page); await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
    await expect.poll(async () => (await focusable()).tabindex).toBeNull();
    expect(await focusable()).toEqual({ tabindex: null, focused: false });
  });

  for (const key of ['Enter', 'Escape', 'Meta+Shift+d']) test(`after Settings closes during recording, ${key} still reaches dictation`, async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('Keep this draft'); await start(page);
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(settings).toBeHidden();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press(key);
    if (key === 'Escape') await expect(pill(page)).toBeHidden();
    else await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await expect(prompt(page)).toHaveValue('Keep this draft');
  });

  async function shortcutMode(page: Page, mode: 'toggle' | 'hold' | 'auto') {
    await page.keyboard.press('Meta+,');
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
    const select = page.locator('#voice-settings').getByRole('combobox', { name: 'Dictation shortcut', exact: true });
    await select.selectOption(mode);
    await expect.poll(() => page.evaluate(() => (window as any).__voiceLocalState().preferences.shortcutMode)).toBe(mode);
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await prompt(page).focus();
  }

  async function pressShortcut(page: Page, heldMs: number) {
    await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.down('d');
    if (heldMs) await page.waitForTimeout(heldMs);
    await page.keyboard.up('d'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  }

  test('voice input Toggle shortcut: a press starts, a long hold keeps recording, the next press stops', async ({ page }) => {
    await open(page, 'delayed'); await shortcutMode(page, 'toggle');
    await pressShortcut(page, 600); await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.waitForTimeout(200); await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await pressShortcut(page, 0); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
  });

  test('voice input Hold shortcut: holding records and releasing stops', async ({ page }) => {
    await open(page, 'delayed'); await shortcutMode(page, 'hold');
    await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.down('d');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.keyboard.up('d'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
  });

  test('voice input Auto shortcut: a short press toggles, a long hold stops on release', async ({ page }) => {
    await open(page, 'delayed'); await shortcutMode(page, 'auto');
    await pressShortcut(page, 0); await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await page.waitForTimeout(200); await expect(pill(page)).toHaveAttribute('data-phase', 'recording');
    await pressShortcut(page, 0); await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
    await pill(page).getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await expect(pill(page)).toBeHidden();
    await prompt(page).focus(); await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.down('d');
    await expect(pill(page)).toHaveAttribute('data-phase', 'recording'); await page.waitForTimeout(450);
    await page.keyboard.up('d'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
    await expect(pill(page)).toHaveAttribute('data-phase', 'transcribing');
  });
});
