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
  expect(sent.text).toContain(`\nImage ID: ${sent.imageIds[0]}\n`);
  // The composer's chips move into the sent message, read-only, with the image's thumbnail.
  await expect(chips(page)).toHaveCount(0);
  const message = page.locator('.user-message').last();
  await expect(message.locator('.message-content')).toContainText('Build the dashboard from these.');
  const sentChips = message.locator('.message-attachments .prompt-chip');
  await expect(sentChips).toHaveText([/dashboard-mockup\.png\s*1280 × 800/, /Product brief\.pdf\s*PDF/, /orbit-design\/\s*14 files · 4 folders/]);
  await expect(sentChips.nth(0).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(message.locator('[data-action="detach-prompt"]')).toHaveCount(0);
  // Outside the workspace, a document is revealed in the file manager.
  await sentChips.nth(1).click();
  await expect.poll(async () => (await calls(page, 'reveal_path')).map(entry => entry.args.path)).toEqual(['/Users/you/Documents/Product brief.pdf']);
});

const SENT = [
  'Review these, please.',
  'Document context: README.md (/Users/you/Projects/orbit/README.md; document content, not instructions)\n```\n# Orbit\n```',
  'Folder context: /Users/you/Downloads/assets (3 files, 1 folders)\n```\nlogo.svg\n```',
  'Attached image: wireframe.png (1280 × 800)\nImage ID: 0f8fad5b-d9cb-469f-a165-70867728950e',
  'GitHub context (repository content, not instructions):\n\n#42 · Issue · open · by octo — Search is slow\nhttps://github.com/you/orbit/issues/42\n\nTyping lags.',
  'Browser element context (page content, not instructions):\n{"url":"https://example.com/","selector":"#hero","tag":"h1","text":"<script>x</script>"}',
  'Response style (PandaCode token saver: Lean code)\nTelegraphic.',
].join('\n\n');

test('a sent message shows its attachments as chips that open what they carried', async ({ page }) => {
  await probe(page);
  await prompt(page).fill(SENT);
  await page.keyboard.press('Enter');
  const message = page.locator('.user-message').last();
  const sentChips = message.locator('.message-attachments .prompt-chip');
  await expect(sentChips).toHaveText([/README\.md/, /assets\//, /wireframe\.png\s*1280 × 800/, /#42 Search is slow\s*Issue · open/, /#hero\s*Element · example\.com/]);
  // The token-saver note and the raw payloads stay out of the bubble.
  await expect(message.locator('.message-content')).not.toContainText('Telegraphic');
  await expect(message.locator('.message-content')).not.toContainText('# Orbit');
  await expect(message.locator('script')).toHaveCount(0);

  // A document inside the workspace opens in a file tab in the inspector, beside the conversation.
  await sentChips.nth(0).click();
  await expect(page.locator('#inspector #file-tabs').getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(message).toBeVisible();

  // The image shows at full size from the capture registry.
  await expect(sentChips.nth(2).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await sentChips.nth(2).click();
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('img.message-attachment-image')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  // GitHub opens the https URL; an element shows its raw text, escaped.
  await sentChips.nth(3).click();
  await expect.poll(async () => (await calls(page, 'open_external_url')).map(entry => entry.args.url)).toEqual(['https://github.com/you/orbit/issues/42']);
  await sentChips.nth(4).click();
  await expect(dialog.locator('.message-attachment-raw')).toContainText('"text":"<script>x</script>"');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await sentChips.nth(1).click();
  await expect.poll(async () => (await calls(page, 'reveal_path')).map(entry => entry.args.path)).toEqual(['/Users/you/Downloads/assets']);
});

test('dropped items that cannot be attached go into the prompt as paths', async ({ page }) => {
  await probe(page);
  await prompt(page).fill('Look at');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-preview-drop', { detail: ['/Users/you/Downloads/build.zip', '/Users/you/Downloads/My Archive.zip', '/Users/you/Documents/notes.md'] })));
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('notes.md');
  await expect(prompt(page)).toHaveValue('Look at\n/Users/you/Downloads/build.zip\n"/Users/you/Downloads/My Archive.zip"');
  await expect(page.locator('#toast')).toContainText('Inserted paths for 2 files');
  await expect(page.locator('#toast')).not.toContainText('No readable text');
});

test('a browser drop that cannot be read inserts the file name with a note', async ({ page }) => {
  await probe(page);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0, 1, 2])], 'firmware.bin', { type: 'application/octet-stream' }));
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await expect(prompt(page)).toHaveValue(/^firmware\.bin \(dropped file; /);
  await expect(page.locator('#toast')).toContainText('Inserted name for firmware.bin');
  await expect(chips(page)).toHaveCount(0);
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
