import { expect, test, type Locator, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';

/** Steps a key until the value stops changing, so the whole edit history is unwound whatever the chunking. */
async function settle(field: Locator, key: string): Promise<string> {
  let value = await field.inputValue();
  for (let step = 0; step < 30; step++) {
    await field.press(key);
    const next = await field.inputValue();
    if (next === value) break;
    value = next;
  }
  return value;
}

test('composer undo works after typing', async ({ page }) => {
  await page.goto('/');
  const field = prompt(page);
  await expect(field).toBeEnabled();
  await field.pressSequentially('hello world');
  await expect(field).toHaveValue('hello world');
  expect(await settle(field, undoKey)).toBe('');
  await settle(field, redoKey);
  await expect(field).toHaveValue('hello world');
});

test('composer undo survives a re-render', async ({ page, browser }) => {
  await page.goto('/');
  const field = prompt(page);
  await expect(field).toBeEnabled();
  await field.pressSequentially('still here');
  await field.evaluate(el => { (el as HTMLElement & { kept?: boolean }).kept = true; });
  // Background refreshes (github status, queue updates) redraw the composer; the field and its undo history must live through them.
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-github-change')));
  await expect(field).toHaveValue('still here');
  expect(await field.evaluate(el => (el as HTMLElement & { kept?: boolean }).kept)).toBe(true);
  // WebKit (the engine Linux ships, and macOS natively) keeps a textarea's undo history when the field
  // is detached and reattached; Chromium drops it, so only the node identity is checked there.
  test.skip(browser.browserType().name() === 'chromium', 'Chromium clears undo history on reattach');
  expect(await settle(field, undoKey)).toBe('');
  await settle(field, redoKey);
  await expect(field).toHaveValue('still here');
});
