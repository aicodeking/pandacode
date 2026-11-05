import { expect, test } from '@playwright/test';
import { editorModifier, replaceEditor } from './file-editor-helper';

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `(window.__editorCalls ??= []).push({ command, args: structuredClone(args) }); switch (command) {`) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'src', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'main.ts', exact: true }).click();
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'src/main.ts', exact: true })).toBeVisible();
});

test('file editor: opens editable code in a floating window beside the project tree', async ({ page }) => {
  const editor = page.getByRole('region', { name: 'File editor', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('region', { name: 'File explorer', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inspector #file-panel')).toHaveCount(0);
  await expect(editor.locator('textarea.file-editor')).toHaveCount(0);
  await expect(editor.locator('[data-gutter] [data-line-number-content]').first()).toHaveText('1');
  await expect.poll(() => editor.locator('[data-content] span').evaluateAll(nodes => new Set(nodes.map(node => getComputedStyle(node).color)).size)).toBeGreaterThan(1);
});

test('file editor: edits, indents, undoes, searches and saves without losing syntax colours', async ({ page }) => {
  const editor = await replaceEditor(page, 'src/main.ts', 'const answer = 42;\nconst next = answer + 1;\n');
  await editor.press(`${editorModifier}+z`);
  await expect(editor).toContainText('createSearchIndex');
  await editor.press(`${editorModifier}+Shift+z`);
  await expect(editor).toContainText('const answer = 42;');
  await editor.press(`${editorModifier}+Home`);
  await editor.press('Tab');
  await expect.poll(() => editor.innerText()).toMatch(/^\s+const answer/);
  await editor.press('Shift+Tab');
  await editor.press(`${editorModifier}+/`);
  await expect(editor).toContainText('// const answer');
  await editor.press(`${editorModifier}+/`);
  await editor.press(`${editorModifier}+f`);
  const search = page.locator('#file-panel').getByPlaceholder('Search', { exact: true });
  await expect(search).toBeVisible(); await search.fill('answer');
  await expect(page.locator('#thread-find')).toHaveCount(0);
  await search.press('Escape');
  await editor.press(`${editorModifier}+Alt+f`);
  await page.locator('#file-panel').getByPlaceholder('Search', { exact: true }).fill('answer');
  await page.locator('#file-panel').getByPlaceholder('Replace', { exact: true }).fill('result');
  await page.locator('#file-panel').getByRole('button', { name: 'Replace All', exact: true }).click();
  await expect(editor).toContainText('const result = 42;');
  await page.locator('#file-panel').getByPlaceholder('Search', { exact: true }).press('Escape');
  await expect.poll(() => page.locator('#file-panel [data-content] span').evaluateAll(nodes => new Set(nodes.map(node => getComputedStyle(node).color)).size)).toBeGreaterThan(1);
  await editor.press(`${editorModifier}+s`);
  await expect(page.locator('#file-panel').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const saved = await page.evaluate(async () => {
    const preview = await import('/src/preview.ts');
    return preview.invoke<string>('read_file', { projectId: 'project-1', sessionId: 'session-1', path: 'src/main.ts' });
  });
  expect(saved).toContain('const result = 42;'); expect(saved).not.toContain('// const result');
});

test('file editor: drags, resizes vertically, maximizes and restores without resizing the terminal', async ({ page }) => {
  await page.locator('#terminal-toggle').click();
  await expect(page.locator('#terminal-drawer')).toBeVisible();
  const terminalHeight = (await page.locator('#terminal-drawer').boundingBox())!.height;
  const pane = page.locator('#file-panel'), heading = pane.locator('.file-window-heading');
  const before = (await pane.boundingBox())!;
  const grip = (await pane.getByRole('separator', { name: 'Resize editor' }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 120); await page.mouse.up();
  expect((await pane.boundingBox())!.height).toBeLessThan(before.height - 100);
  const header = (await heading.boundingBox())!;
  await page.mouse.move(header.x + 100, header.y + 20); await page.mouse.down();
  await page.mouse.move(header.x + 132, header.y + 52); await page.mouse.up();
  const moved = (await pane.boundingBox())!;
  expect(moved.x).toBeCloseTo(before.x + 32, 0); expect(moved.y).toBeCloseTo(before.y + 32, 0);
  await pane.getByRole('button', { name: 'Maximize editor', exact: true }).click();
  expect((await pane.boundingBox())!.width).toBeGreaterThan(moved.width);
  await pane.getByRole('button', { name: 'Restore editor', exact: true }).click();
  expect((await pane.boundingBox())!.height).toBeCloseTo(moved.height, 0);
  await pane.getByRole('separator', { name: 'Resize editor' }).press('ArrowDown');
  expect((await pane.boundingBox())!.height).toBeCloseTo(moved.height + 32, 0);
  expect((await page.locator('#terminal-drawer').boundingBox())!.height).toBeCloseTo(terminalHeight, 0);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(async () => { const box = (await pane.boundingBox())!; return box.x + box.width; }).toBeLessThanOrEqual(784);
  await expect.poll(async () => { const box = (await pane.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(584);
});

test('file editor: hiding and switching tasks retain drafts and undo history', async ({ page }) => {
  await replaceEditor(page, 'src/main.ts', 'const draft = 7;');
  await page.getByRole('button', { name: 'Hide editor', exact: true }).click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Toggle editor', exact: true }).click();
  const editor = page.locator('#file-panel').getByRole('textbox', { name: 'src/main.ts', exact: true });
  await expect(editor).toContainText('const draft = 7;');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(editor).toContainText('const draft = 7;');
  await editor.press(`${editorModifier}+z`);
  await expect(editor).toContainText('createSearchIndex');
});

test('file editor: preview keeps unsaved Markdown and closing a dirty tab preserves edits', async ({ page }) => {
  await page.locator('.file-row').getByRole('button', { name: 'README.md', exact: true }).click();
  await replaceEditor(page, 'README.md', '# Unsaved preview\n\nStill editable.');
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#file-panel .doc-reader h1')).toHaveText('Unsaved preview');
  await page.locator('#file-panel').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'README.md', exact: true })).toContainText('Unsaved preview');
  await page.getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Save or discard');
  await expect(page.locator('#file-panel')).toBeVisible();
});

test('file editor: asks about an unchanged file after moving focus from the selection', async ({ page }) => {
  const pane = page.locator('#file-panel'), editor = pane.getByRole('textbox', { name: 'src/main.ts', exact: true });
  await editor.press(`${editorModifier}+Home`); await editor.press('Shift+End');
  await expect(pane.locator('[data-selection-lines]')).toHaveText('Lines 1–1');
  await editor.press('ArrowRight');
  await expect(pane.getByRole('button', { name: 'Ask model', exact: true })).toBeDisabled();
  await editor.press(`${editorModifier}+Home`); await editor.press('Shift+End');
  await pane.getByRole('button', { name: 'Ask model', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Question about selected code' }).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === 'queue_add').length)).toBe(1);
  const calls = await page.evaluate(() => (window as any).__editorCalls);
  expect(calls.some((call: any) => call.command === 'write_workspace_file')).toBe(false);
  expect(calls.find((call: any) => call.command === 'queue_add').args.text).toContain('Explain what this code does.');
  await expect(pane).toBeHidden();
});

test('file editor: asks about highlighted buffer text without saving or replacing the composer draft', async ({ page }) => {
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.fill('Keep my draft');
  const editor = await replaceEditor(page, 'src/main.ts', 'const selected = 42;\nconst unselected = 99;');
  await editor.press(`${editorModifier}+Home`); await editor.press('Shift+End');
  const actions = page.locator('#file-panel').getByRole('form', { name: 'Ask about selected code' });
  await page.locator('#file-panel').getByRole('button', { name: 'Ask model', exact: true }).click();
  await expect(actions).toBeVisible();
  await actions.getByRole('textbox', { name: 'Question about selected code' }).press('Escape');
  await expect(actions).toBeHidden();
  await expect(page.locator('#file-panel')).toBeVisible();
  await page.locator('#file-panel').getByRole('button', { name: 'Ask model', exact: true }).click();
  await actions.getByRole('textbox', { name: 'Question about selected code' }).fill('Why is this needed?');
  await actions.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === 'queue_add').length)).toBe(1);
  const call = await page.evaluate(() => (window as any).__editorCalls.find((call: any) => call.command === 'queue_add'));
  expect(call.args.sessionId).toBe('session-1');
  expect(call.args.text).toContain('File context: src/main.ts\nSelected lines: 1–1');
  expect(call.args.text).toContain('const selected = 42;');
  expect(call.args.text).not.toContain('const unselected');
  expect(call.args.text).toMatch(/^Why is this needed\?\n\nFile context:/);
  expect(call.args.text).toContain('unsaved editor buffer');
  expect(call.args.text).toContain('Do not change files.');
  expect(await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === 'write_workspace_file').length)).toBe(0);
  await expect(prompt).toHaveValue('Keep my draft');
  await expect(page.locator('#file-panel')).toBeHidden();
  const message = page.locator('.user-message').last().locator('.message-content');
  await expect(message).toContainText('Why is this needed?');
  await expect(message).not.toContainText('Do not change files.');
  await expect(message).not.toContainText('const selected');
  await message.getByRole('button', { name: 'Open main.ts', exact: true }).click();
  const snapshot = page.getByRole('dialog').locator('.message-attachment-raw');
  await expect(snapshot).toContainText('Selected lines: 1–1');
  await expect(snapshot).toContainText('const selected = 42;');
  await expect(snapshot).not.toContainText('const unselected');
});

test('file editor: saves a dirty selection before requesting a focused model fix', async ({ page }) => {
  const editor = await replaceEditor(page, 'src/main.ts', 'const broken = ;\nconst untouched = 99;');
  await editor.press(`${editorModifier}+Home`); await editor.press('Shift+End');
  const actions = page.locator('#file-panel').getByRole('form', { name: 'Ask about selected code' });
  await page.locator('#file-panel').getByRole('button', { name: 'Ask model', exact: true }).click();
  await actions.getByRole('textbox', { name: 'Question about selected code' }).fill('Use a valid initializer.');
  await page.locator('#file-panel').getByRole('button', { name: 'Save & fix', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === 'queue_add').length)).toBe(1);
  const calls = await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => ['write_workspace_file', 'queue_add'].includes(call.command)));
  expect(calls.map((call: any) => call.command)).toEqual(['write_workspace_file', 'queue_add']);
  expect(calls[0].args.path).toBe('src/main.ts');
  expect(calls[0].args.content).toBe('const broken = ;\nconst untouched = 99;');
  expect(calls[1].args.text).toContain('Fix the selected code');
  expect(calls[1].args.text).toContain('Use a valid initializer.');
  expect(calls[1].args.text).not.toContain('const untouched');
  await expect(page.locator('#file-panel')).toBeVisible();
});

test('file editor: a conflicting save never dispatches a selection fix', async ({ page }) => {
  const editor = await replaceEditor(page, 'src/main.ts', 'const myDraft = 1;');
  await page.evaluate(async () => {
    const preview = await import('/src/preview.ts'), context = { projectId: 'project-1', sessionId: 'session-1', path: 'src/main.ts' };
    const expected = await preview.invoke<string>('read_file', context);
    await preview.invoke('write_workspace_file', { ...context, expected, content: 'const external = 2;' });
    (window as any).__editorCalls = [];
  });
  const box = await editor.locator('[data-line="1"]').evaluate(line => {
    const range = document.createRange(); range.selectNodeContents(line); const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(box.left + 1, box.y); await page.mouse.down(); await page.mouse.move(box.right + 1, box.y); await page.mouse.up();
  const actions = page.locator('#file-panel').getByRole('form', { name: 'Ask about selected code' });
  await page.locator('#file-panel').getByRole('button', { name: 'Save & fix', exact: true }).click();
  await expect(actions.getByRole('alert')).toContainText('No fix request was sent');
  expect(await page.evaluate(() => (window as any).__editorCalls.filter((call: any) => call.command === 'queue_add').length)).toBe(0);
  await expect(editor).toContainText('const myDraft = 1;');
});
