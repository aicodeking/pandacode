import { expect, test } from '@playwright/test';
import { prompt, pill, calls, open, start, release } from './voice-test-helpers';

test.describe('voice input', () => {
  for (const interaction of ['focus', 'hover']) test(`origin navigation hint stays while ${interaction} and expires after leaving`, async ({ page }) => {
    await open(page, 'delayed'); const original = await prompt(page).getAttribute('data-session-id');
    await start(page); await page.keyboard.press('Enter');
    await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
    await page.getByRole('button', { name: 'Dictation pending in another thread', exact: true }).click();
    const go = pill(page).getByRole('button', { name: 'Go to thread', exact: true });
    if (interaction === 'focus') await go.focus(); else await go.hover();
    await page.waitForTimeout(3300); await expect(go).toBeVisible();
    if (interaction === 'focus') { await expect(go).toBeFocused(); await prompt(page).focus(); }
    else await page.mouse.move(0, 0);
    await page.waitForTimeout(1000); await expect(go).toBeVisible();
    await expect(pill(page)).toBeHidden({ timeout: 4000 });
    if (interaction === 'focus') await expect(prompt(page)).toBeFocused();
  });

  test('empty permission error from another thread permits a fresh recording', async ({ page }) => {
    await open(page, 'delayed');
    await page.evaluate(() => { (window as any).__voiceFailCommands = { voice_start: 1 }; });
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await expect(pill(page)).toHaveAttribute('data-phase', 'error');
    const original = await prompt(page).getAttribute('data-session-id');
    await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
    await page.getByRole('button', { name: /Start dictation|Dictation pending in another thread/ }).click();
    await expect.poll(async () => (await calls(page)).filter((c: any) => c.command === 'voice_start').length).toBe(2);
  });

  test('pending origin is named and Go to thread returns to its speech', async ({ page }) => {
    await open(page, 'delayed'); const original = await prompt(page).getAttribute('data-session-id');
    await start(page); await page.keyboard.press('Enter');
    await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
    await page.getByRole('button', { name: 'Dictation pending in another thread', exact: true }).click();
    await expect(pill(page)).toContainText('Make search feel instant');
    await pill(page).getByRole('button', { name: 'Go to thread', exact: true }).click();
    // The origin draft is unchanged, so the speech inserts at its saved place on return.
    await expect(prompt(page)).toHaveAttribute('data-session-id', original!); await release(page);
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
  });

  for (const activation of ['click', 'shortcut']) test(`another thread's pending dictation has visible feedback on ${activation}`, async ({ page }) => {
    await open(page, 'delayed'); const original = await prompt(page).getAttribute('data-session-id');
    await start(page); await page.keyboard.press('Enter');
    await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
    const mic = page.getByRole('button', { name: 'Dictation pending in another thread', exact: true });
    await expect(mic).toBeVisible(); await expect(mic).toHaveAttribute('data-tip', /Dictation pending in another thread/);
    await expect(mic).not.toHaveAttribute('title');
    if (activation === 'click') await mic.click();
    else { await prompt(page).focus(); await page.keyboard.press('Meta+Shift+d'); }
    await expect(pill(page).locator('.voice-label')).toHaveText('Dictation is waiting in “Make search feel instant”.');
    await expect(pill(page)).toBeVisible(); await expect(pill(page)).toHaveCSS('opacity', '1');
    await expect(prompt(page)).toHaveValue('');
    expect((await calls(page)).filter((c: any) => c.command === 'voice_start')).toHaveLength(1);
    await expect(pill(page)).toBeHidden({ timeout: 5000 }); await release(page);
    await page.locator(`.task-item[data-id="${original}"]`).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.');
    const restored = page.getByRole('button', { name: 'Start dictation', exact: true });
    await expect(restored).toHaveAttribute('data-tip', /^Start dictation · (⌘⇧D|Ctrl⇧D)$/); await expect(restored).not.toHaveAttribute('title');
  });

  test('thread switch holds the transcript away and inserts it only into its unchanged origin draft', async ({ page }) => {
    await open(page, 'delayed'); const original = await prompt(page).getAttribute('data-session-id');
    await start(page); await pill(page).getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
    const other = page.locator(`.task-item:not([data-id="${original}"])`).first(), otherId = await other.getAttribute('data-id');
    await other.click();
    await release(page); await expect(pill(page)).toBeHidden(); await expect(prompt(page)).toHaveValue('');
    await page.locator(`.task-item[data-id="${original}"]`).click();
    await expect(prompt(page)).toHaveAttribute('data-session-id', original!);
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
    await page.locator(`.task-item[data-id="${otherId}"]`).click();
    await expect(prompt(page)).toHaveAttribute('data-session-id', otherId!); await expect(prompt(page)).toHaveValue('');
  });

  test('switching during recording stops and retains origin speech', async ({ page }) => {
    await open(page, 'delayed'); const original = await prompt(page).getAttribute('data-session-id'); await start(page);
    await page.locator(`.task-item:not([data-id="${original}"])`).first().click();
    await expect.poll(async () => (await calls(page)).some((c: any) => c.command === 'voice_stop')).toBe(true);
    await release(page); await page.locator(`.task-item[data-id="${original}"]`).click();
    await expect(prompt(page)).toHaveValue('A dictated draft.'); await expect(pill(page)).toBeHidden();
  });

  test('returning to an unchanged origin draft inserts speech at its saved caret', async ({ page }) => {
    await open(page, 'delayed'); await prompt(page).fill('hello world');
    await prompt(page).evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
    const origin = await prompt(page).getAttribute('data-session-id'); await start(page);
    await page.locator(`.task-item:not([data-id="${origin}"])`).first().click();
    await expect(prompt(page)).not.toHaveAttribute('data-session-id', origin!);
    await page.locator(`.task-item[data-id="${origin}"]`).click();
    await expect(prompt(page)).toHaveAttribute('data-session-id', origin!);
    await release(page);
    await expect(prompt(page)).toHaveValue('hello A dictated draft. world'); await expect(pill(page)).toBeHidden();
  });
});
