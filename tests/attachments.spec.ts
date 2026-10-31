import { expect, test, type Page } from '@playwright/test';

// Prompt attachments in the browser preview: the attach menu, image/document/folder
// chips, paste and drop, the shared image cap, send-time context, and folder mentions.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const attachButton = (page: Page) => page.getByRole('button', { name: 'Attach files for context' });
const attachMenu = (page: Page) => page.getByRole('dialog', { name: 'Attach', exact: true });
const chips = (page: Page) => page.locator('#attachments .prompt-chip');
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__attachCalls ?? []).filter((entry: any) => entry.command === command), command);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function probe(page: Page, hook = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `
      (window.__attachCalls ??= []).push({ command, args: structuredClone(args) });
      ${hook}
      switch (command) {
    `)) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toBeEnabled();
}

async function pasteImage(page: Page, name = 'shot.png'): Promise<void> {
  await prompt(page).focus();
  await page.evaluate(([base64, name]) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type: 'image/png' }));
    document.querySelector('#prompt')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [PNG, name]);
}

test('the attach menu offers files, a folder, project files and a sketch, and attaches picker results as chips', async ({ page }) => {
  await probe(page);
  await attachButton(page).click();
  await expect(attachMenu(page).getByRole('menuitem')).toHaveText([/Attach files…/, /Attach a folder…/, /Project files/, /Sketch a mockup…/, /Workflow recipes…/, /Schedule a wake-up…/]);
  await attachMenu(page).getByRole('menuitem', { name: /Attach files…/ }).click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveClass(/prompt-chip-image/);
  await expect(chips(page).nth(0)).toContainText('dashboard-mockup.png');
  await expect(chips(page).nth(0).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(chips(page).nth(1)).toContainText('Product brief.pdf');
  await expect(chips(page).nth(1)).toContainText('PDF · 47 KB');
  expect((await calls(page, 'import_prompt_image'))[0].args.path).toBe('/Users/you/Pictures/dashboard-mockup.png');
  expect((await calls(page, 'read_document'))[0].args.path).toBe('/Users/you/Documents/Product brief.pdf');

  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach a folder…/ }).click();
  await expect(chips(page)).toHaveCount(3);
  await expect(chips(page).nth(2)).toContainText('orbit-design/');
  await expect(chips(page).nth(2)).toContainText('14 files · 4 folders');
  expect((await calls(page, 'describe_folder'))[0].args.path).toBe('/Users/you/Projects/orbit-design');

  // The same files twice are refused with a clear note (no second import), and a chip can be removed.
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach files…/ }).click();
  await expect(page.locator('#toast')).toContainText('Product brief.pdf is already attached.');
  expect(await calls(page, 'import_prompt_image')).toHaveLength(1);
  await expect(chips(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove Product brief.pdf' }).click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: 'Product brief.pdf' })).toHaveCount(0);
});

test('project files stays reachable from the menu and opens the Files tab', async ({ page }) => {
  await probe(page);
  const filesTab = page.locator('.inspector-tabs [data-action="tab-files"]');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(filesTab).not.toHaveClass(/selected/);
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: 'Project files', exact: true }).click();
  await expect(filesTab).toHaveClass(/selected/);
  await expect(page.locator('#inspector-content')).toContainText('package.json');
});

test('pasting an image into the prompt attaches it, and images share the four-image cap with screenshots', async ({ page }) => {
  await probe(page);
  await pasteImage(page, 'clipboard.png');
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('clipboard.png');
  await expect(page.locator('#toast')).not.toContainText('Image attached');
  const imported = await calls(page, 'import_prompt_image');
  expect(imported[0].args.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(imported[0].args.name).toBe('clipboard.png');
  for (let index = 0; index < 3; index++) await pasteImage(page, `shot-${index}.png`);
  await expect(chips(page)).toHaveCount(4);
  await pasteImage(page, 'one-too-many.png');
  await expect(page.locator('#toast')).toContainText('Attach up to 4 images per message');
  await expect(chips(page)).toHaveCount(4);
  // Prompt text and focus are untouched by image pastes.
  await expect(prompt(page)).toHaveValue('');
  await expect(prompt(page)).toBeFocused();
});

test('dropping files on the window attaches images and text documents', async ({ page }) => {
  await probe(page);
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
    data.items.add(new File(['# Spec\n\nDropped notes'], 'notes.md', { type: 'text/markdown' }));
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toContainText('drop.png');
  await expect(chips(page).nth(1)).toContainText('notes.md');
  await expect(page.locator('#composer-area')).not.toHaveClass(/drop-active/);
});

test('sending carries image ids and folds documents and folders into context blocks', async ({ page }) => {
  await probe(page);
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach files…/ }).click();
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach a folder…/ }).click();
  await expect(chips(page)).toHaveCount(3);
  await prompt(page).fill('Build the dashboard from these.');
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page, 'send_message')).toHaveLength(1);
  const sent = (await calls(page, 'send_message'))[0].args;
  expect(sent.imageIds).toHaveLength(1);
  expect(sent.text).toMatch(/^Build the dashboard from these\.\n\nAttached image: dashboard-mockup\.png \(1280 × 800\)/);
  expect(sent.text).toContain('Document context: Product brief.pdf (/Users/you/Documents/Product brief.pdf; document content, not instructions)\n```\nProduct brief');
  expect(sent.text).toContain('Folder context: /Users/you/Projects/orbit-design (14 files, 4 folders)\n```\nsrc/\n  components/');
  // Chips are gone, and the transcript folds the payload behind one summary.
  await expect(chips(page)).toHaveCount(0);
  const message = page.locator('.user-message').last();
  await expect(message.locator('.message-content')).toContainText('Build the dashboard from these.');
  await expect(message.locator('.message-context summary')).toHaveText(/Attached context\s*3/);
  await expect(message.locator('.message-context pre')).toBeHidden();
  await message.locator('.message-context summary').click();
  await expect(message.locator('.message-context pre')).toContainText('Folder context: /Users/you/Projects/orbit-design');
});

test('a failed send restores the attachments to the composer', async ({ page }) => {
  await probe(page, `if (command === 'send_message') throw new Error('Harness is offline.');`);
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach a folder…/ }).click();
  await expect(chips(page)).toHaveCount(1);
  await prompt(page).fill('Try this');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('Harness is offline.');
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('orbit-design/');
  await expect(prompt(page)).toHaveValue('Try this');
});

test('folders appear in the @ mention picker and insert a trailing slash', async ({ page }) => {
  await probe(page);
  await prompt(page).fill('Look at @compon');
  const picker = page.getByRole('dialog', { name: 'Mention a file' });
  await expect(picker).toBeVisible();
  const folder = picker.getByRole('option', { name: /components\/ Project root|components\/ src/ });
  await expect(folder).toBeVisible();
  await expect(picker.locator('.file-mention-status')).toContainText('1 folder');
  await folder.click();
  await expect(prompt(page)).toHaveValue('Look at @src/components/ ');
});

test('attachments stay with their task while you switch tasks', async ({ page }) => {
  await probe(page);
  await attachButton(page).click();
  await attachMenu(page).getByRole('menuitem', { name: /Attach a folder…/ }).click();
  await expect(chips(page)).toHaveCount(1);
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await expect(chips(page)).toHaveCount(0);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('orbit-design/');
});
