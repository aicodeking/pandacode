import { showHarness } from './model-picker-helper';
import { expect, test, type Page } from '@playwright/test';

// Grok Build (xAI) is an ACP harness: it lists its models with context and
// reasoning efforts, maps PandaCode's approval modes to its permission modes, and
// takes documents and folders but no images.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const modelTrigger = (page: Page) => page.getByRole('button', { name: 'Choose harness and model', exact: true });
const modelPicker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__grokCalls ?? []).filter((entry: any) => entry.command === command), command);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function newGrokTask(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `(window.__grokCalls ??= []).push({ command, args: structuredClone(args) }); switch (command) {`)) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await page.locator('.new-task-button').click();
  await expect(prompt(page)).toBeEnabled();
  await modelTrigger(page).click();
  await showHarness(page, 'grok');
  await modelPicker(page).locator('.model-menu-option[data-provider="grok"]').first().click();
  await expect(modelTrigger(page)).toContainText('Default');
  await expect(modelTrigger(page).locator('[data-provider="grok"]')).toHaveCount(1);
}

test('Grok Build lists its models with context windows and reasoning efforts, and remembers the choice', async ({ page }) => {
  await newGrokTask(page);
  await modelTrigger(page).click();
  const picker = modelPicker(page);
  await expect(picker.locator('.model-menu-group-heading', { hasText: 'Grok Build' })).toBeVisible();
  const flagship = picker.locator('.model-menu-option', { hasText: 'Grok 4.7' }).first();
  await expect(flagship).toContainText('500K');
  await flagship.click();
  await expect(modelTrigger(page)).toContainText('Grok 4.7');
  // Efforts advertised by the agent drive the segmented control: harness default, then Low → Extra High.
  await modelTrigger(page).click();
  const efforts = picker.getByRole('radiogroup', { name: 'Effort', exact: true });
  await expect(efforts).toBeVisible();
  await expect(efforts.getByRole('radio', { name: 'Default', exact: true })).toHaveAttribute('aria-checked', 'true');
  await efforts.getByRole('radio', { name: 'Extra High', exact: true }).click();
  await expect(efforts.getByRole('radio', { name: 'Extra High', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  expect((await calls(page, 'configure_session')).pop()?.args).toMatchObject({ provider: 'grok', model: 'grok-4.7' });
  expect((await calls(page, 'set_reasoning_effort')).pop()?.args).toMatchObject({ reasoningEffort: 'xhigh' });
});

test('Grok approval modes describe its permission modes, including read-only planning', async ({ page }) => {
  await newGrokTask(page);
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveText([/^Standard/, /^Accept edits/, /^Plan mode/, /^Full access/]);
  const details = await items.evaluateAll(nodes => nodes.map(node => node.querySelector('[data-tip]')?.getAttribute('data-tip') ?? node.querySelector('.choice-menu-description')?.textContent));
  expect(details[0]).toContain('Grok asks before edits and commands');
  expect(details[2]).toContain('edits and commands are declined');
  expect(details[3]).toContain('--always-approve');
  await items.nth(2).click();
  await expect(page.locator('#mode-picker-trigger')).toContainText('Plan mode');
  const saved = await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const id = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId;
    return id ? (await invoke('get_task', { sessionId: id }))?.mode : undefined;
  });
  expect(saved).toBe('plan');
});

test('a Grok task takes documents and folders but explains that images are not accepted yet', async ({ page }) => {
  await newGrokTask(page);
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  const menu = page.getByRole('dialog', { name: 'Attach', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText([/Attach files…PDFs, documents/, /Attach a folder…/, /Project files/, /Workflow recipes…/, /Schedule a wake-up…/]);
  await menu.getByRole('menuitem', { name: /Attach a folder…/ }).click();
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(1);
  // A pasted image is refused with a reason instead of failing at send time.
  await prompt(page).focus();
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document.querySelector('#prompt')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(page.locator('#toast')).toContainText('Grok Build does not accept images yet');
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(1);
  expect(await calls(page, 'import_prompt_image')).toHaveLength(0);
});

test('the Provider connections settings explain how to install and sign in to Grok Build', async ({ page }) => {
  await newGrokTask(page);
  await page.keyboard.press('Meta+,');
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card', { hasText: 'Grok Build' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('grok login');
  await expect(card).toContainText('grok agent stdio');
  await expect(card.getByRole('link', { name: /Grok Build docs/ })).toHaveAttribute('href', 'https://docs.x.ai/build/overview');
  await expect(card.locator('[data-executable="grok"]')).toHaveCount(1);
});
