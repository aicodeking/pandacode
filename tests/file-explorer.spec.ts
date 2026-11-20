import { expect, test, type Page, type Locator } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';
import { replaceEditor } from './file-editor-helper';

const explorer = (page: Page) => page.getByRole('region', { name: 'File explorer', exact: true });
const root = (page: Page) => explorer(page);
const item = (page: Page, name: string) => root(page).locator('.file-row').getByRole('button', { name, exact: true });
async function showExplorer(page: Page) {
  // A thread switch keeps the Files panel open but replaces the tree with "Loading files…".
  // The toggle would read that as already-open and close the panel, so wait the placeholder out.
  const loading = page.locator('#inspector-content').getByText('Loading files…', { exact: true });
  if (await loading.isVisible()) await expect(loading).toBeHidden();
  if (!await explorer(page).isVisible()) await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeVisible();
}
async function menu(page: Page, row: Locator, action: string) {
  await showExplorer(page);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function submitName(page: Page, name: string, action = 'Create') {
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
  await expect(page.locator('#dialog')).not.toBeVisible();
}
async function disk(page: Page, command: string, args: Record<string, unknown>) {
  const workspace = { projectId: 'project-1', sessionId: 'session-1' };
  return page.evaluate(async ({ command, args }) => {
    const preview = await import('/src/preview.ts');
    return preview.invoke(command, args);
  }, { command, args: { ...workspace, ...args } });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
});

test('file explorer: right panel keeps the current project available with mouse and keyboard disclosure', async ({ page }) => {
  await expect(page.locator('#workspace-sidebar').getByRole('region', { name: 'File explorer', exact: true })).toHaveCount(0);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('orbit');
  await expect(page.getByRole('button', { name: 'Toggle file explorer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const src = item(page, 'src');
  await src.click();
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'main.ts')).toBeVisible();
  await src.press('ArrowLeft');
  await expect(src).toHaveAttribute('aria-expanded', 'false');
  await expect(item(page, 'main.ts')).toHaveCount(0);
  await src.press('ArrowRight');
  await expect(item(page, 'main.ts')).toBeVisible();
  await explorer(page).getByRole('button', { name: 'Collapse folders', exact: true }).click();
  await expect(src).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Toggle file explorer', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
});

test('file explorer: creates, edits, renames and deletes nested files and folders', async ({ page }) => {
  await explorer(page).getByRole('button', { name: 'New folder', exact: true }).click();
  await submitName(page, 'scratch');
  await menu(page, item(page, 'scratch'), 'New File');
  await submitName(page, 'hello.ts');
  await replaceEditor(page, 'scratch/hello.ts', 'export const answer = 42;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('answer');
  await menu(page, item(page, 'scratch'), 'Rename');
  await submitName(page, 'renamed', 'Rename');
  await expect(page.locator('.file-view-path')).toHaveText('renamed/hello.ts');
  await menu(page, item(page, 'hello.ts'), 'Rename');
  await submitName(page, 'hello world.json', 'Rename');
  await expect(page.locator('.file-view-path')).toHaveText('renamed/hello world.json');
  await menu(page, item(page, 'renamed'), 'Delete');
  await expect(page.getByRole('dialog')).toContainText('and all its contents');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(item(page, 'renamed')).toHaveCount(0);
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
});

test('file explorer: rejects duplicate names and traversal without dismissing the dialog', async ({ page }) => {
  await menu(page, item(page, 'README.md'), 'New File');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('README.md');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('../outside');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('single file or folder name');
});

test('file explorer: preserves unsaved edits across file tabs and rejects stale saves', async ({ page }) => {
  await item(page, 'README.md').click();
  const original = await disk(page, 'read_file', { path: 'README.md' });
  await replaceEditor(page, 'README.md', '# My draft\n');
  await page.locator('#file-tabs [data-file-tab="close"]').click();
  await expect(page.locator('#toast')).toContainText('Save or discard');
  await showExplorer(page);
  await item(page, 'package.json').click();
  await page.locator('#file-tabs').getByRole('tab', { name: /README.md/ }).click();
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'README.md', exact: true })).toContainText('My draft');
  await disk(page, 'write_workspace_file', { path: 'README.md', expected: original, content: '# External edit\n' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('File changed on disk');
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'README.md', exact: true })).toContainText('My draft');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('External edit');
});

test('file explorer: auto-refreshes new, changed and deleted files on disk', async ({ page }) => {
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'external.txt' });
  await expect(item(page, 'external.txt')).toBeVisible();
  await item(page, 'external.txt').click();
  await disk(page, 'write_workspace_file', { path: 'external.txt', expected: '', content: 'Updated on disk' });
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('Updated on disk');
  await disk(page, 'manage_workspace_entry', { action: 'delete', path: 'external.txt' });
  await showExplorer(page);
  await expect(item(page, 'external.txt')).toHaveCount(0);
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
});

test('file explorer: dirty files cannot be renamed or deleted from their folder', async ({ page }) => {
  await item(page, 'src').click();
  await item(page, 'main.ts').click();
  await replaceEditor(page, 'src/main.ts', 'unsaved');
  await menu(page, item(page, 'src'), 'Delete');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Save or discard');
  await expect(item(page, 'main.ts')).toBeVisible();
});

test('file explorer: inspector shares explorer actions and supports the keyboard menu', async ({ page }) => {
  const row = item(page, 'README.md');
  await row.focus(); await row.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Reveal in OS', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open in Default App', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await row.click();
  await openInspectorTab(page, 'Files');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'README.md', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New Folder', exact: true })).toBeVisible();
});

test('file explorer: switching projects shows only the active checkout', async ({ page }) => {
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'only-in-orbit.txt' });
  await expect(item(page, 'only-in-orbit.txt')).toBeVisible();
  await page.locator('.task-item[data-id="session-4"]').click();
  await showExplorer(page);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('pandacode');
  await expect(item(page, 'only-in-orbit.txt')).toHaveCount(0);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveCount(1);
  await page.locator('.task-item[data-id="session-1"]').click();
  await showExplorer(page);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('orbit');
  await expect(item(page, 'only-in-orbit.txt')).toBeVisible();
});

/** Counts the poll's IPC (`list_files` for the tree, `workspace_file_stamp` for the file on screen) by patching the preview's
 * command switch, as `observeWorktreeCommands` in ui.spec.ts does. */
async function countPolls(page: Page): Promise<() => Promise<number>> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const marker = /switch\s*\(command\)\s*\{/, source = await response.text();
    expect(source).toMatch(marker);
    const body = source.replace(marker, `if (command === 'list_files' || command === 'workspace_file_stamp') window.__filePolls = (window.__filePolls ?? 0) + 1;
      switch (command) {`) + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
    await route.fulfill({ response, body });
  });
  await page.reload();
  // The reload restores the open Files panel; let it draw (or settle closed) before toggling it.
  await expect(item(page, 'README.md').or(page.locator('#files-toggle[aria-pressed="false"]'))).toBeVisible();
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
  return () => page.evaluate(() => (window as any).__filePolls as number ?? 0);
}
/** ms between two consecutive poll reads, timed from one of the poll's own reads (never from a test step). */
async function readGap(polls: () => Promise<number>, within: number, why: string): Promise<number> {
  let from = await polls();
  await expect.poll(polls, { timeout: within, intervals: [50], message: `${why} (first read)` }).toBeGreaterThan(from);
  const readAt = Date.now();
  from = await polls();
  await expect.poll(polls, { timeout: within, intervals: [50], message: `${why} (next read)` }).toBeGreaterThan(from);
  return Date.now() - readAt;
}
/** No poll IPC across two and a bit quick poll intervals. */
async function expectQuiet(page: Page, polls: () => Promise<number>, why: string): Promise<void> {
  await page.waitForTimeout(150);
  const from = await polls();
  await page.waitForTimeout(4500);
  expect(await polls(), why).toBe(from);
}

test('file explorer: the poll slows while the window is unfocused, pauses while hidden, and refreshes at once on return', async ({ page }) => {
  test.setTimeout(60_000);
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  let from = await polls();
  await expect.poll(polls, { timeout: 5000, message: 'focused with the tree on screen, it polls' }).toBeGreaterThan(from);
  // Shown beside another app (unfocused): the tree and the open file still follow the disk (an editor's saves show
  // within 3 s), every 3 s instead of 2.
  await page.evaluate(() => { document.hasFocus = () => false; dispatchEvent(new Event('blur')); });
  await expect.poll(periods, { timeout: 1000, message: 'an unfocused window polls every 3 s' }).toEqual([3000]);
  const gap = await readGap(polls, 4500, 'an unfocused, visible window still polls');
  expect(gap, `two unfocused reads came ${gap} ms apart`).toBeGreaterThan(2500);
  expect(gap).toBeLessThan(4000);
  from = await polls();
  await page.evaluate(() => { document.hasFocus = () => true; dispatchEvent(new Event('focus')); });
  await expect.poll(polls, { timeout: 500, message: 'focus refreshes at once' }).toBeGreaterThan(from);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expectQuiet(page, polls, 'no poll while the window is hidden');
  from = await polls();
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(polls, { timeout: 500, message: 'showing the window refreshes at once' }).toBeGreaterThan(from);
  // Focus moving into one of the app's own frames blurs the window, but the document keeps focus: the poll goes on.
  from = await polls();
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await expect.poll(polls, { timeout: 5000, message: 'a blur that leaves the document focused keeps polling' }).toBeGreaterThan(from);
});

test('file explorer: the poll runs only while the Files tree or an open file is on screen', async ({ page }) => {
  test.setTimeout(45_000);
  const polls = await countPolls(page);
  await item(page, 'README.md').click();
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(1);
  // The open file alone (tree closed) keeps its stamp fresh.
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeHidden();
  await expect(page.locator('#file-panel')).toBeVisible();
  const from = await polls();
  await expect.poll(polls, { timeout: 5000, message: 'an open file on screen is polled' }).toBeGreaterThan(from);
  // The file hidden too: the tab still exists, but nothing on screen shows the files.
  await page.locator('#file-editor-toggle').click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await expectQuiet(page, polls, 'no poll while neither the tree nor a file is on screen');
});

test('file explorer: a window that starts unfocused polls at the 3 s rate', async ({ page }) => {
  test.setTimeout(60_000);
  // Launched in the background: the document never had focus, and no blur ever fires to say so.
  await page.addInitScript(() => { document.hasFocus = () => false; });
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  expect(await periods()).toEqual([3000]);
  // The interval starts with the explorer, early in boot, not when the tree first shows: a slow boot (WebKit) puts its
  // first tick at any point after the tree. Time the gap from one of the poll's own reads instead.
  const gap = await readGap(polls, 4500, 'an unfocused, visible window polls');
  expect(gap, 'the gap between two reads of a window that started unfocused').toBeGreaterThan(2500);
  expect(gap).toBeLessThan(4000);
  // Focus arriving brings the 2 s poll back, refreshing at once.
  const focusedFrom = await polls();
  await page.evaluate(() => { document.hasFocus = () => true; dispatchEvent(new Event('focus')); });
  await expect.poll(polls, { timeout: 500, message: 'focus refreshes at once' }).toBeGreaterThan(focusedFrom);
  const after = await polls();
  await expect.poll(polls, { timeout: 3500, intervals: [100], message: 'focused again, it polls every 2 s' }).toBeGreaterThan(after);
});

test('file explorer: focus in the in-app browser keeps the focused rate; the window losing focus slows it', async ({ page }) => {
  test.setTimeout(45_000);
  const periods = await trackPollTimer(page);
  await countPolls(page);
  expect(await periods()).toEqual([2000]);
  // The browser panel's native child webview takes the page's focus; the window (the preview's stand-in) keeps it.
  await page.evaluate(() => { (window as any).__windowFocus.set(true); document.hasFocus = () => false; dispatchEvent(new Event('blur')); });
  await page.waitForTimeout(300);
  expect(await periods(), 'page unfocused, window focused').toEqual([2000]);
  // Another app takes focus: the window reports it.
  await page.evaluate(() => (window as any).__windowFocus.set(false));
  expect(await periods(), 'window unfocused').toEqual([3000]);
  await page.evaluate(() => (window as any).__windowFocus.set(true));
  expect(await periods(), 'window focused again').toEqual([2000]);
});

/** Tracks the Files poll's live interval (named `filePollTick` in file-explorer.ts) by its period, so a test can read the
 * rate directly: [] while nothing is mounted, [2000] while in use, [3000] once settled or unfocused. */
async function trackPollTimer(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const live = new Map<number, number>(), set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      const id = set(handler, ms, ...rest);
      if (typeof handler === 'function' && handler.name === 'filePollTick') live.set(id, ms ?? 0);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => { if (id !== undefined) live.delete(id); clear(id); }) as typeof window.clearInterval;
    (window as any).__filePollPeriods = () => [...live.values()];
  });
  return () => page.evaluate(() => (window as any).__filePollPeriods() as number[]);
}
/** Waits, without input, until the focused poll settles to 3 s after its unchanged reads. */
async function settle(page: Page, periods: () => Promise<number[]>): Promise<void> {
  await expect.poll(periods, { timeout: 12_000, intervals: [250], message: 'three unchanged reads slow the focused poll to 3 s' }).toEqual([3000]);
}

test('file explorer: a focused poll backs off to 3 s after unchanged reads', async ({ page }) => {
  test.setTimeout(60_000);
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  expect(await periods()).toEqual([2000]);
  await settle(page, periods);
  // Settled: the reads come on the 3 s beat, not the 2 s one.
  const gap = await readGap(polls, 4500, 'a settled poll still reads');
  expect(gap, `two settled reads came ${gap} ms apart`).toBeGreaterThan(2500);
  expect(gap).toBeLessThan(4000);
  expect(await periods()).toEqual([3000]);
});

test('file explorer: visible Files and open tabs stay fresh after a long idle without focus', async ({ page }) => {
  await page.clock.install();
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  await item(page, 'README.md').click();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toBeVisible();
  const original = await disk(page, 'read_file', { path: 'README.md' });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.clock.fastForward(6 * 60_000);
  expect(await periods(), 'a focused, long idle window settles to 3 s').toEqual([3000]);
  await page.evaluate(() => (window as any).__windowFocus.set(false));
  expect(await periods(), 'visible but unfocused stays at 3 s, even after five minutes').toEqual([3000]);
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'after-long-idle.txt' });
  await disk(page, 'write_workspace_file', { path: 'README.md', expected: original, content: '# Saved after long idle\n' });
  const from = await polls();
  await page.clock.runFor(3000);
  expect(await polls(), 'the next scheduled read takes at most 3 s').toBeGreaterThan(from);
  await expect(item(page, 'after-long-idle.txt')).toBeVisible();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('Saved after long idle');
  expect(await periods()).toEqual([3000]);
  await page.evaluate(() => (window as any).__windowFocus.set(true));
  expect(await periods(), 'focus brings the 2 s rate back').toEqual([2000]);
});

test('file explorer: focus and activity never read while hidden or unmounted', async ({ page }) => {
  await page.clock.install();
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const hidden = await polls();
  await page.evaluate(async () => {
    const { noteFilePollActivity } = await import('/src/file-explorer.ts');
    noteFilePollActivity();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    dispatchEvent(new Event('focus'));
  });
  expect(await periods(), 'a hidden document stops the interval').toEqual([]);
  await page.clock.runFor(10_000);
  expect(await polls(), 'neither focus nor pending activity reads a hidden document').toBe(hidden);
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(polls).toBeGreaterThan(hidden);
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await page.clock.runFor(300);
  expect(await periods(), 'no watched surface means no interval').toEqual([]);
  const unmounted = await polls();
  await page.evaluate(async () => {
    dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    const { noteFilePollActivity } = await import('/src/file-explorer.ts');
    noteFilePollActivity();
  });
  await page.clock.runFor(10_000);
  expect(await polls(), 'focus, showing and activity do not read an unmounted surface').toBe(unmounted);
});

test('file explorer: input brings a settled poll back to 2 s', async ({ page }) => {
  test.setTimeout(60_000);
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  await settle(page, periods);
  await page.keyboard.press('Shift');
  expect(await periods()).toEqual([2000]);
  const from = await polls();
  await expect.poll(polls, { timeout: 3000, intervals: [100], message: 'after input, the next read is on the 2 s beat' }).toBeGreaterThan(from);
  const next = await polls();
  await expect.poll(polls, { timeout: 3000, intervals: [100], message: 'and the one after it' }).toBeGreaterThan(next);
});

test('file explorer: no poll timer runs while neither the tree nor a file tab is mounted', async ({ page }) => {
  test.setTimeout(45_000);
  const periods = await trackPollTimer(page);
  await countPolls(page);
  expect(await periods()).toEqual([2000]);
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeHidden();
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
  expect(await periods(), 'closing the tree with no file open stops the timer').toEqual([]);
  // An open file alone is mounted: the timer comes back for it and goes again when its tab closes.
  await showExplorer(page);
  expect(await periods()).toEqual([2000]);
  await item(page, 'README.md').click();
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeHidden();
  expect(await periods(), 'an open file tab keeps the timer').toEqual([2000]);
  await page.locator('#file-tabs [data-file-tab="close"]').click();
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
  await expect.poll(periods, { message: 'the last tab closing stops the timer' }).toEqual([]);
});

test('file explorer: a change on disk shows within one settled tick and restores the 2 s rate', async ({ page }) => {
  test.setTimeout(60_000);
  const periods = await trackPollTimer(page);
  await countPolls(page);
  await settle(page, periods);
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'appeared.txt' });
  await expect(item(page, 'appeared.txt')).toBeVisible({ timeout: 4500 });
  expect(await periods(), 'a change brings the quick rate back').toEqual([2000]);
});

test('file explorer: while the open thread\'s agent works the poll keeps the 2 s rate, and a tool event reads at once', async ({ page }) => {
  test.setTimeout(60_000);
  const periods = await trackPollTimer(page);
  const polls = await countPolls(page);
  // Shown beside another app (unfocused): the slower rate.
  await page.evaluate(() => { document.hasFocus = () => false; dispatchEvent(new Event('blur')); });
  await expect.poll(periods, { timeout: 5000, message: 'an unfocused window polls every 3 s' }).toEqual([3000]);
  const sessionId = await page.locator('#prompt').getAttribute('data-session-id');
  const agent = (kind: string, extra: Record<string, unknown> = {}) => page.evaluate(event => (window as any).__previewEmit('agent-event', event), { sessionId, kind, text: '', ...extra });
  // The agent starts: its edits land with no input, so the quick rate holds, unfocused or settled.
  await agent('status', { text: 'Working' });
  await expect.poll(periods, { timeout: 2000, message: 'a working agent brings the 2 s rate back' }).toEqual([2000]);
  const from = await polls();
  await expect.poll(polls, { timeout: 3000, intervals: [100], message: 'and it reads on that beat' }).toBeGreaterThan(from);
  await page.waitForTimeout(6500);
  expect(await periods(), 'unchanged reads do not slow it while the agent works').toEqual([2000]);
  // A tool event (an edit, say) reads well before the next 2 s tick: sent just after a tick, it is read within a second.
  const ticked = await polls();
  await expect.poll(polls, { timeout: 3000, intervals: [50] }).toBeGreaterThan(ticked);
  await page.waitForTimeout(100);
  const before = await polls();
  await agent('tool', { text: 'Edit', tool: { id: 'poll-tool', name: 'Edit', status: 'completed', input: 'README.md', output: '' } });
  await expect.poll(polls, { timeout: 1000, intervals: [50], message: 'a tool event reads within the activity delay' }).toBeGreaterThan(before);
  // The run ends: back to the slow rate once it settles.
  await agent('done');
  await expect.poll(periods, { timeout: 12_000, intervals: [250], message: 'with the agent done, the unfocused poll slows again' }).toEqual([3000]);
});


test('file explorer: read-only tools and stdout-only Command snapshots keep the regular poll; writes refresh and coalesce with it', async ({ page }) => {
  test.setTimeout(45_000);
  await countPolls(page);
  await item(page, 'src').click();
  await expect(item(page, 'main.ts')).toBeVisible();
  const sessionId = await page.locator('#prompt').getAttribute('data-session-id');
  // Time and count in the page: slow driver round trips must not add whole poll ticks to the measurement.
  const reads = await page.evaluate(async sessionId => {
    const w = window as any, preview = await import(w.__pandacodePreviewUrl);
    const count = () => w.__filePolls as number;
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const tool = (name: string) => w.__previewEmit('agent-event', { sessionId, kind: 'tool', text: name, tool: { id: name, name, status: 'completed', input: '', output: '' } });
    const command = (output: string) => w.__previewEmit('agent-event', { sessionId, kind: 'tool', text: 'Command', tool: { id: 'stdout-command', name: 'Command', status: 'running', input: 'npm run dev', output } });
    w.__previewEmit('agent-event', { sessionId, kind: 'status', text: 'Working' });
    command('starting');
    await delay(450);
    const before = count();
    let snapshots = 0;
    const timer = setInterval(() => {
      snapshots++;
      command(`server output ${snapshots}`);
      for (const name of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'read_file', 'list_dir', 'WebSearch']) tool(name);
      if (snapshots === 12) clearInterval(timer);
    }, 500);
    while (snapshots < 12) await delay(25);
    await delay(450);
    const readOnly = count() - before, tick = count();
    while (count() === tick) await delay(25);
    const from = count();
    await preview.invoke('manage_workspace_entry', { projectId: 'project-1', sessionId, action: 'new-file', path: 'written-by-tool.txt' });
    tool('Write');
    await delay(650);
    const write = count() - from;
    const shown = [...document.querySelectorAll('#inspector-content .file-row button')].some(button => button.textContent?.trim() === 'written-by-tool.txt');
    // Just before the regular tick, a second write shares its read instead of adding one 400 ms later.
    await delay(1050);
    const nearTick = count();
    tool('Write');
    await delay(700);
    return { snapshots, readOnly, write, shown, coalesced: count() - nearTick };
  }, sessionId);
  // Two expanded folders, at most four regular ticks in 6.45 s; stdout snapshots must not add a read apiece.
  expect(reads.snapshots).toBe(12);
  expect(reads.readOnly).toBeLessThanOrEqual(8);
  expect(reads.write).toBe(2);
  expect(reads.shown).toBe(true);
  expect(reads.coalesced).toBe(2);
});
