import { expect, test, type Locator, type Page } from '@playwright/test';

const menu = (page: Page) => page.locator('.file-mention-menu:not([aria-hidden="true"])');
const draft = (page: Page) => page.locator('#mention-fixture');
const files = [
  { name: 'main.ts', path: 'src/main.ts', isDir: false },
  { name: 'main.test.ts', path: 'src/main.test.ts', isDir: false },
  { name: 'design notes.md', path: 'docs/design notes.md', isDir: false },
  { name: 'say "hi".md', path: 'docs/say "hi".md', isDir: false },
];

// Mount the real completion module. Only the asynchronous file-search boundary is synthetic.
async function setup(page: Page, held = false): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(async ({ files, held }) => {
    const host = document.createElement('div');
    host.id = 'mention-fixture-host'; host.className = 'composer';
    host.style.cssText = 'position:fixed;bottom:45px;left:310px;width:650px;z-index:70;margin:0';
    host.innerHTML = '<textarea id="mention-fixture" aria-label="File reference draft"></textarea>';
    document.body.append(host);
    const textarea = host.querySelector('textarea')!;
    const fixture = (window as any).__mentions = { files, held, context: 'first', calls: [], selected: [], submissions: 0, pending: [], error: '' };
    const moduleUrl = '/src/file-mentions.ts';
    const { mountFileMentions } = await import(moduleUrl);
    fixture.controller = mountFileMentions(textarea, {
      contextKey: () => fixture.context,
      search: async (query: string) => {
        fixture.calls.push({ context: fixture.context, query });
        if (fixture.held) return await new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
        if (fixture.error) throw new Error(fixture.error);
        return fixture.files.filter((file: { path: string }) => file.path.toLowerCase().includes(query.toLowerCase()));
      },
      select: (file: unknown) => fixture.selected.push(file),
    });
    document.addEventListener('keydown', event => {
      if (event.target === textarea && event.key === 'Enter' && !event.defaultPrevented) fixture.submissions++;
    });
    textarea.focus();
  }, { files, held });
}

const state = (page: Page): Promise<any> => page.evaluate(() => {
  const fixture = (window as any).__mentions;
  return { calls: fixture.calls, selected: fixture.selected, submissions: fixture.submissions, pending: fixture.pending.length };
});
const row = (page: Page, path: string): Locator => menu(page).locator('[data-file-path]').filter({ hasText: path.split('/').pop()! });

async function atCaret(input: Locator, text: string, caret: number): Promise<void> {
  await input.fill(text);
  await input.evaluate((node: HTMLTextAreaElement, caret) => {
    node.setSelectionRange(caret, caret);
    node.dispatchEvent(new Event('click', { bubbles: true }));
  }, caret);
}

test('file mentions insert inline with Enter and Tab, preserve the suffix, and never submit the draft', async ({ page }) => {
  await setup(page);
  const original = await draft(page).elementHandle();
  await atCaret(draft(page), 'Please review @src/ma before shipping.', 'Please review @src/ma'.length);
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('Please review @src/main.ts before shipping.');
  await expect(draft(page)).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
  expect((await state(page)).submissions).toBe(0);
  expect(await original!.evaluate(node => node === document.querySelector('#mention-fixture'))).toBe(true);

  await draft(page).fill('Also inspect @src/ma');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await draft(page).press('ArrowDown');
  await expect(menu(page).locator('[aria-selected="true"]')).toContainText('main.test.ts');
  await draft(page).press('Tab');
  await expect(draft(page)).toHaveValue('Also inspect @src/main.test.ts ');
  await expect(draft(page)).toBeFocused();
  expect((await state(page)).selected.map((entry: any) => entry.path)).toEqual(['src/main.ts', 'src/main.test.ts']);
  expect((await state(page)).submissions).toBe(0);
});

test('file mentions quote whitespace and escape quotes when selected by pointer', async ({ page }) => {
  await setup(page);
  await draft(page).fill('Follow @docs/des');
  await row(page, 'docs/design notes.md').click();
  await expect(draft(page)).toHaveValue('Follow @"docs/design notes.md" ');
  await expect(draft(page)).toBeFocused();
  await draft(page).fill('Read @docs/say');
  await row(page, 'docs/say "hi".md').click();
  await expect(draft(page)).toHaveValue(`Read @${JSON.stringify('docs/say "hi".md')} `);
  await expect(draft(page)).toBeFocused();
  expect((await state(page)).submissions).toBe(0);
});

test('file mentions ignore emails and composition and keep Escape dismissed until the query changes', async ({ page }) => {
  await setup(page);
  await draft(page).fill('Contact person@example.com');
  await expect(menu(page)).toHaveCount(0);
  expect((await state(page)).calls).toHaveLength(0);
  await draft(page).fill('Read @src/ma');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await draft(page).press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).press('ArrowLeft');
  await draft(page).press('ArrowRight');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).fill('Read @docs');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await draft(page).dispatchEvent('compositionstart');
  await expect(menu(page)).toHaveCount(0);
  const before = (await state(page)).calls.length;
  await draft(page).fill('Read @src/main');
  await draft(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect((await state(page)).selected).toHaveLength(0);
  expect((await state(page)).calls).toHaveLength(before);
  await draft(page).dispatchEvent('compositionend');
  await expect(menu(page).getByRole('option')).toHaveCount(2);
  await draft(page).dispatchEvent('keydown', { key: 'Enter', ctrlKey: true });
  expect((await state(page)).selected).toHaveLength(0);
});

test('file mentions discard stale query and workspace searches and dispose pending work', async ({ page }) => {
  await setup(page, true);
  await draft(page).fill('Read @src');
  await expect.poll(async () => (await state(page)).pending).toBe(1);
  await draft(page).press('Enter');
  expect((await state(page)).submissions).toBe(0);
  await draft(page).fill('Read @docs');
  await expect.poll(async () => (await state(page)).pending).toBe(2);
  await page.evaluate(() => { const f = (window as any).__mentions; f.pending[1].resolve([f.files[2]]); });
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(menu(page).getByRole('option')).toContainText('design notes.md');
  await page.evaluate(() => { const f = (window as any).__mentions; f.pending[0].resolve([f.files[0]]); });
  await expect(menu(page).getByRole('option')).toContainText('design notes.md');

  await page.evaluate(() => { const f = (window as any).__mentions; f.context = 'second'; f.controller.refresh(); });
  await expect.poll(async () => (await state(page)).pending).toBe(3);
  await page.evaluate(() => { const f = (window as any).__mentions; f.context = 'third'; f.controller.refresh(); });
  await expect.poll(async () => (await state(page)).pending).toBe(4);
  await page.evaluate(() => { const f = (window as any).__mentions; f.pending[3].resolve([f.files[3]]); });
  await expect(menu(page).getByRole('option')).toContainText('say "hi".md');
  await page.evaluate(() => { const f = (window as any).__mentions; f.pending[2].resolve([f.files[2]]); });
  await expect(menu(page).getByRole('option')).toContainText('say "hi".md');
  await page.evaluate(() => { const f = (window as any).__mentions; f.context = 'fourth'; f.controller.refresh(); });
  await expect.poll(async () => (await state(page)).pending).toBe(5);
  await page.evaluate(() => { const f = (window as any).__mentions; f.controller.dispose(); f.pending[4].resolve(f.files); });
  await expect(menu(page)).toHaveCount(0);
  await expect(draft(page)).not.toHaveAttribute('role', 'combobox');
  await draft(page).fill('Read @src/main');
  await expect(menu(page)).toHaveCount(0);
  expect((await state(page)).calls).toHaveLength(5);
});

test('file mention results stay bounded, retain matching rows, and fit a resized viewport', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).__mentions.files = Array.from({ length: 500 }, (_, index) => ({ name: `file-${String(index).padStart(3, '0')}.ts`, path: `src/file-${String(index).padStart(3, '0')}.ts`, isDir: false }));
    document.querySelector<HTMLElement>('#mention-fixture-host')!.style.cssText = 'position:fixed;bottom:35px;right:12px;width:310px;z-index:70;margin:0';
  });
  await page.setViewportSize({ width: 740, height: 540 });
  await draft(page).fill('@src/');
  await expect(menu(page).getByRole('option').first()).toBeVisible();
  const initialCount = await menu(page).getByRole('option').count();
  expect(initialCount).toBeGreaterThan(1);
  expect(initialCount).toBeLessThanOrEqual(80);
  const originalMenu = await menu(page).elementHandle();
  const originalRow = await row(page, 'src/file-000.ts').elementHandle();
  await draft(page).fill('@src/file-00');
  await expect(menu(page).getByRole('option')).toHaveCount(10);
  expect(await originalMenu!.evaluate(node => node === document.querySelector('.file-mention-menu:not([aria-hidden="true"])'))).toBe(true);
  expect(await originalRow!.evaluate(node => node.isConnected && node === document.querySelector('[data-file-path="src/file-000.ts"]'))).toBe(true);
  await page.setViewportSize({ width: 420, height: 500 });
  await expect.poll(async () => { const box = await menu(page).boundingBox(); return box!.x + box!.width; }).toBeLessThanOrEqual(409);
  const box = await menu(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(11);
  expect(box!.y).toBeGreaterThanOrEqual(11);
  expect(box!.y + box!.height).toBeLessThanOrEqual(489);
  await expect(draft(page)).toBeFocused();
  await draft(page).press('ArrowUp');
  await expect(menu(page).locator('[aria-selected="true"]')).toContainText('file-009.ts');
});

async function installAppProbe(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      window.__fileMentionCalls ??= [];
      window.__fileMentionCalls.push({command,args:structuredClone(args)});
      if (command === 'send_message') return;
      if (command === 'search_files' && args.sessionId && session(args.sessionId).worktreePath) return [{name:'worktree-only.ts',path:'src/worktree-only.ts',isDir:false}];
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(page.locator('#prompt')).toBeEnabled();
}
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__fileMentionCalls ?? []).filter((entry: any) => entry.command === command), command);

test('conversation mentions search the selected task and send the inserted path without submitting on selection', async ({ page }) => {
  await installAppProbe(page);
  const prompt = page.locator('#prompt');
  const original = await prompt.elementHandle();
  await prompt.fill('Review @src/main');
  await expect(row(page, 'src/main.ts')).toBeVisible();
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('Review @src/main.ts ');
  expect(await calls(page, 'send_message')).toHaveLength(0);
  const searches = await calls(page, 'search_files');
  expect(searches.at(-1).args).toMatchObject({ projectId: 'project-1', sessionId: 'session-1', query: 'src/main' });
  expect(await original!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  await prompt.press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  expect((await calls(page, 'send_message'))[0].args).toMatchObject({ sessionId: 'session-1', text: 'Review @src/main.ts' });
  expect(await calls(page, 'read_file')).toHaveLength(0);
});

test('a quoted mention stays closed after macOS smart quotes curl its quotes', async ({ page }) => {
  await setup(page);
  const input = draft(page);
  await input.pressSequentially('@design');
  await expect(row(page, 'docs/design notes.md')).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('@"docs/design notes.md" ');
  for (const [open, close] of [['"', '\u201D'], ['\u201C', '\u201D']]) {
    // Text checking replaces the quotes in place when a space is typed.
    await input.evaluate((node: HTMLTextAreaElement, [open, close]) => {
      node.value = `@${open}docs/design notes.md${close} `;
      node.setSelectionRange(node.value.length, node.value.length);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, [open, close]);
    for (const word of ['word', ' ', 'more', ' ']) {
      await input.pressSequentially(word);
      await expect(menu(page)).toHaveCount(0);
    }
  }
  // Typing a new curly-quoted mention still searches.
  await input.pressSequentially('@\u201Cdesign');
  await expect(row(page, 'docs/design notes.md')).toBeVisible();
});

test('slash commands and file mentions transfer keyboard ownership as the caret moves', async ({ page }) => {
  await installAppProbe(page);
  const prompt = page.locator('#prompt');
  const slash = page.locator('.slash-menu:not([aria-hidden="true"])');
  await atCaret(prompt, '/rev @src/main', 4);
  await expect(slash.getByRole('option')).toHaveCount(1);
  await expect(menu(page)).toHaveCount(0);
  await expect(prompt).toHaveAttribute('aria-controls', await slash.getByRole('listbox').getAttribute('id'));
  await prompt.evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(node.value.length, node.value.length); node.dispatchEvent(new Event('click')); });
  await expect(row(page, 'src/main.ts')).toBeVisible();
  await expect(slash).toHaveCount(0);
  await expect(prompt).toHaveAttribute('aria-controls', await menu(page).getByRole('listbox').getAttribute('id'));
  await prompt.evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(4, 4); node.dispatchEvent(new Event('click')); });
  await expect(slash.getByRole('option')).toHaveCount(1);
  await expect(menu(page)).toHaveCount(0);
  await expect(prompt).toHaveAttribute('aria-controls', await slash.getByRole('listbox').getAttribute('id'));
  await prompt.press('Enter');
  await expect(prompt).toHaveValue('/review @src/main');
  expect(await calls(page, 'send_message')).toHaveLength(0);
  await prompt.evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(node.value.length, node.value.length); node.dispatchEvent(new Event('click')); });
  await expect(row(page, 'src/main.ts')).toBeVisible();
  await prompt.press('Tab');
  await expect(prompt).toHaveValue('/review @src/main.ts ');
  await expect(menu(page)).toHaveCount(0);
  await expect(slash).toHaveCount(0);
  await expect(prompt).not.toHaveAttribute('role', 'combobox');
  await expect(prompt).not.toHaveAttribute('aria-controls');
  await expect(prompt).toBeFocused();
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('board descriptions save quoted file mentions and pass them to the agent when the task starts', async ({ page }) => {
  await installAppProbe(page);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('region', { name: 'Project board', exact: true }).getByRole('button', { name: 'Add task', exact: true }).click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('textbox', { name: 'Task title', exact: true }).fill('Follow the design notes');
  const description = dialog.locator('#board-task-description');
  await description.fill('Use @docs/design');
  await row(page, 'docs/design notes.md').click();
  await expect(description).toHaveValue('Use @"docs/design notes.md" ');
  await expect(description).toBeFocused();
  expect(await calls(page, 'create_board_task')).toHaveLength(0);
  expect((await calls(page, 'search_files')).at(-1).args.projectId).toBe('project-1');
  await dialog.getByRole('button', { name: 'Add to pending', exact: true }).click();
  await expect(dialog).toBeHidden();
  const details = page.getByRole('region', { name: 'Task details', exact: true });
  await expect(details).toContainText('Use @"docs/design notes.md"');
  expect((await calls(page, 'create_board_task'))[0].args).toMatchObject({ description: 'Use @"docs/design notes.md"', projectId: 'project-1' });
  await details.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  expect((await calls(page, 'send_message'))[0].args.text).toBe('Use @"docs/design notes.md"');
});

test('worktree conversation and board editing search by task instead of reusing the parent checkout', async ({ page }) => {
  await installAppProbe(page);
  await page.locator('#prompt').fill('Read @src/');
  await expect(row(page, 'src/main.ts')).toBeVisible();
  await page.locator('#prompt').press('Escape');
  await page.locator('#branch-chip').click();
  await page.getByRole('dialog', { name: 'Branch and worktree', exact: true }).getByRole('menuitem', { name: /New task in a worktree/ }).click();
  const dialog = page.locator('#dialog');
  await dialog.locator('input[name="branch"]').fill('codex/mention-scope');
  await dialog.getByRole('button', { name: 'Create worktree task', exact: true }).click();
  await expect(dialog).toBeHidden();
  const selected = page.locator('.task-item.selected');
  await expect(selected.getByRole('img', { name: 'Worktree', exact: true })).toBeVisible();
  const sessionId = await selected.getAttribute('data-id');
  expect(sessionId).not.toBe('session-1');
  await page.locator('#prompt').fill('Read @src/');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(row(page, 'src/worktree-only.ts')).toBeVisible();
  expect((await calls(page, 'search_files')).at(-1).args).toMatchObject({ projectId: 'project-1', sessionId, query: 'src/' });
  await page.locator('#prompt').press('Escape');
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('region', { name: 'Project board', exact: true }).getByRole('button', { name: 'Open task: New conversation', exact: true }).click();
  const details = page.getByRole('region', { name: 'Task details', exact: true });
  await details.getByRole('button', { name: 'Edit task details', exact: true }).click();
  const description = dialog.locator('#board-task-description');
  await description.fill('Inspect @src/');
  await expect(row(page, 'src/worktree-only.ts')).toBeVisible();
  expect((await calls(page, 'search_files')).at(-1).args).toMatchObject({ projectId: 'project-1', sessionId, query: 'src/' });
  await description.press('Enter');
  await expect(description).toHaveValue('Inspect @src/worktree-only.ts ');
  await dialog.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await calls(page, 'update_task_details')).at(-1).args).toMatchObject({ sessionId, description: 'Inspect @src/worktree-only.ts' });
});
