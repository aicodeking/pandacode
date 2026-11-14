import { expect, test, type Locator, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

// Line comments (docs/line-comments.md) in the browser preview: comments are kept per thread (local
// storage, like composer drafts) until "Send comments to agent" adds them to the composer. The Files
// view uses the preview's sample src/main.ts; the Changes view the src/components/search.ts diff of
// "Make search feel instant".

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const PLACEHOLDER = `Comment · ${process.platform === 'darwin' ? '⌘↵' : 'Ctrl+↵'} saves`;
const SUMMARY = '\n\nEnd your reply with a numbered list: one short item responding to each comment, in the same order.';

async function openSource(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await openFile(page);
}
async function openFile(page: Page): Promise<void> {
  await openInspectorTab(page, 'Files');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  // The tree keeps a thread's expanded folders (and may restore them after its first paint), so
  // expand src only while it is collapsed: a click on an expanded one would close it again.
  const main = page.locator('[data-action="open-file"][data-path="src/main.ts"]');
  const src = page.locator('[data-action="toggle-file-folder"][data-path="src"]');
  await expect(async () => {
    if (!await main.isVisible() && await src.getAttribute('aria-expanded') !== 'true') await src.click();
    await expect(main).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await main.click();
  await expect(page.locator('.code-preview .code-line[data-line="4"]')).toBeVisible();
}
const lineNumber = (page: Page, line: number) => page.locator(`.code-preview .code-line[data-line="${line}"] .line-number`);
const send = (page: Page) => page.locator('#file-view [data-rc-send]');
const field = (thread: Locator) => thread.locator('.rc-field textarea');
const heightOf = (box: Locator) => box.evaluate(el => el.getBoundingClientRect().height);
const saved = (page: Page) => page.locator('.rc-thread[data-rc-id]');
/** Inspector widths (pandacode.inspectorWidth) whose Changes view is 340px, 400px and 474px wide. */
const WIDE_FOR_340 = 356, WIDE_FOR_400 = 416, WIDE_FOR_479 = 490;

/** Comments on `line` (or `line`–`to`) of the open file and returns its thread. */
async function addComment(page: Page, line: number, text: string, to?: number): Promise<Locator> {
  await lineNumber(page, line).click();
  if (to) await lineNumber(page, to).click({ modifiers: ['Shift'] });
  const box = page.locator('.rc-new .rc-field textarea');
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press(`${mod}+Enter`);
  await expect(page.locator('.rc-new')).toHaveCount(0);
  const range = to ? `lines ${line}–${to}` : `line ${line}`;
  const thread = page.locator(`.rc-thread[data-rc-id][aria-label="Comment on ${range}"]`);
  await expect(field(thread)).toHaveValue(text);
  return thread;
}

async function openChanges(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await openInspectorTab(page, 'Changes');
  await page.getByRole('tab', { name: /^Changes/ }).click();
  const file = page.locator('.cv-file[data-path="src/components/search.ts"]');
  // Ready, with the line comments' hooks (they can arrive just after the diff).
  await expect(file.locator('.diff-viewer[data-diff-state="ready"][data-review-hooks]')).toBeVisible();
  return file;
}

test('a line number starts a comment; leaving the field with text saves it in place, without a button', async ({ page }) => {
  await openSource(page);
  // No comments, no Send button.
  await expect(send(page)).toBeHidden();

  await lineNumber(page, 2).click();
  const draft = page.locator('.rc-new');
  const box = page.getByRole('textbox', { name: 'Comment on line 2' });
  await expect(box).toBeFocused();
  await expect(page.locator('.code-line[data-line="2"]')).toHaveClass(/rc-selected/);
  // No repeated line numbers, no Save, Comment or Cancel buttons: the field and a discard button.
  await expect(draft).not.toContainText(/line/i);
  await expect(box).toHaveAttribute('placeholder', PLACEHOLDER);
  await expect(box).toHaveAttribute('aria-description', /, Escape or leaving the field saves it; left empty, it is discarded/);
  await expect(draft.getByRole('button')).toHaveCount(1);
  await expect(draft.getByRole('button', { name: 'Discard comment' })).toBeVisible();
  await box.fill('Name the parameter entries.');

  // Saving swaps the field for the saved comment in one paint: the code below never moves.
  const top = await page.locator('.code-line[data-line="3"]').evaluate(el => el.getBoundingClientRect().top);
  await page.evaluate(() => {
    const row = document.querySelector('.code-line[data-line="3"]')!;
    const tops: number[] = [];
    (window as any).__tops = tops;
    const watch = () => { tops.push(row.getBoundingClientRect().top); if (tops.length < 40) requestAnimationFrame(watch); };
    new MutationObserver(() => tops.push(row.getBoundingClientRect().top)).observe(document.querySelector('.code-preview')!, { childList: true, subtree: true });
    requestAnimationFrame(watch);
  });
  await box.press(`${mod}+Enter`);
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(field(saved(page))).toHaveValue('Name the parameter entries.');
  expect(await saved(page).evaluate(el => (el.previousElementSibling as HTMLElement).dataset.line)).toBe('2');
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(1);
  await expect(send(page)).toHaveText('Send 1 comment');
  await expect(send(page)).toHaveAttribute('aria-label', 'Send 1 comment to agent');
  // Every frame sampled (the watch stops after 40), then none of them moved.
  await expect.poll(() => page.evaluate(() => ((window as any).__tops as number[]).length)).toBeGreaterThanOrEqual(40);
  const tops = await page.evaluate(() => (window as any).__tops as number[]);
  expect(tops.every(t => Math.abs(t - top) < 0.5), `line 3 moved: ${tops.join(', ')}`).toBe(true);

  // Escape keeps what was typed: it saves the comment and goes back to the line number.
  await lineNumber(page, 9).click();
  await page.getByRole('textbox', { name: 'Comment on line 9' }).fill('Kept by Escape.');
  await page.getByRole('textbox', { name: 'Comment on line 9' }).press('Escape');
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(field(page.locator('.rc-thread[data-rc-id][aria-label="Comment on line 9"]'))).toHaveValue('Kept by Escape.');
  await expect(lineNumber(page, 9)).toBeFocused();
  // Escape on an empty field, or leaving it empty, drops it.
  await lineNumber(page, 11).click();
  await page.getByRole('textbox', { name: 'Comment on line 11' }).press('Escape');
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await lineNumber(page, 11).click();
  await expect(page.getByRole('textbox', { name: 'Comment on line 11' })).toBeFocused();
  await page.locator('.file-view-path').click();
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(page.locator('.rc-thread')).toHaveCount(2);
  // × discards a new comment, text and all.
  await lineNumber(page, 11).click();
  await page.getByRole('textbox', { name: 'Comment on line 11' }).fill('never mind');
  await page.getByRole('button', { name: 'Discard comment' }).click();
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(page.locator('.rc-thread')).toHaveCount(2);

  // Clicking elsewhere saves too.
  await lineNumber(page, 10).click();
  await page.getByRole('textbox', { name: 'Comment on line 10' }).fill('Blur saves this.');
  await page.locator('.file-view-path').click();
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(page.locator('.rc-thread')).toHaveCount(3);
});

test('a comment field is one row for one line and grows to three before it scrolls', async ({ page }) => {
  await openSource(page);
  await lineNumber(page, 2).click();
  const box = page.getByRole('textbox', { name: 'Comment on line 2' });
  // Empty, it is one row: its placeholder fits the inspector at its default width.
  const empty = await heightOf(box);
  await box.fill('one');
  const one = await heightOf(box);
  expect(one).toBeCloseTo(empty, 0);
  const lineHeight = await box.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
  expect(one).toBeLessThan(lineHeight * 2);
  await box.fill('one\ntwo');
  const two = await heightOf(box);
  expect(two - one).toBeCloseTo(lineHeight, 0);
  await box.fill('one\ntwo\nthree');
  const three = await heightOf(box);
  expect(three - one).toBeCloseTo(2 * lineHeight, 0);
  expect(await box.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  // Past three rows it stays three rows tall and scrolls.
  await box.fill('one\ntwo\nthree\nfour\nfive\nsix');
  expect(await heightOf(box)).toBeCloseTo(three, 0);
  expect(await box.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // A long line wraps and grows the same way.
  await box.fill('word '.repeat(400));
  expect(await heightOf(box)).toBeCloseTo(three, 0);
  // Back to one line, back to one row; a saved comment keeps the height of its text.
  await box.fill('short');
  expect(await heightOf(box)).toBeCloseTo(one, 0);
  await box.fill('one\ntwo');
  await box.press(`${mod}+Enter`);
  await expect(field(saved(page))).toHaveValue('one\ntwo');
  expect(await heightOf(field(saved(page)))).toBeCloseTo(two, 0);
});

test('Shift-click and a drag across line numbers comment on a range', async ({ page }) => {
  await openSource(page);
  await lineNumber(page, 1).click();
  await lineNumber(page, 3).click({ modifiers: ['Shift'] });
  const box = page.getByRole('textbox', { name: 'Comment on lines 1–3' });
  await expect(box).toBeFocused();
  await expect(page.locator('.code-line.rc-selected')).toHaveCount(3);
  await box.fill('Document this module.');
  await box.press(`${mod}+Enter`);
  await expect(field(saved(page))).toHaveValue('Document this module.');
  expect(await saved(page).evaluate(el => (el.previousElementSibling as HTMLElement).dataset.line)).toBe('3');
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(3);

  // Dragging down the numbers selects lines 8–10.
  const from = await lineNumber(page, 8).boundingBox(), to = await lineNumber(page, 10).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'Comment on lines 8–10' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Comment on lines 8–10' }).press('Escape');
  await expect(page.locator('.rc-new')).toHaveCount(0);
});

test('clicking a comment edits it; Escape restores it; emptying it and leaving deletes it', async ({ page }) => {
  await openSource(page);
  const thread = await addComment(page, 4, 'Lower-case the query once.', 6);
  const box = field(thread);
  await expect(thread.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await box.click();
  await expect(box).toBeFocused();
  await box.fill('changed my mind');
  await box.press('Escape');
  await expect(box).toHaveValue('Lower-case the query once.');
  await expect(box).not.toBeFocused();

  await box.click();
  await box.fill('Lower-case the query before filtering.');
  await page.locator('.file-view-path').click();
  await expect(box).toHaveValue('Lower-case the query before filtering.');

  await box.click();
  await box.fill('');
  await page.locator('.file-view-path').click();
  await expect(saved(page)).toHaveCount(0);
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(0);
  await expect(send(page)).toBeHidden();
  // A saved comment's field says Escape undoes the edit.
  const again = await addComment(page, 2, 'Short-lived.');
  await expect(field(again)).toHaveAttribute('aria-description', /Escape undoes the edit/);

  // × deletes too.
  await again.getByRole('button', { name: 'Delete comment' }).click();
  await expect(saved(page)).toHaveCount(0);
});

test('diff line numbers take comments on new and deleted lines', async ({ page }) => {
  const file = await openChanges(page);
  await expect(file.locator('[data-rc-send]')).toHaveCount(0);
  const header = page.locator('.cv-header [data-rc-send]');
  await expect(header).toBeHidden();

  // An added line: new side, line 12.
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await expect(box).toBeFocused();
  await expect(file.locator('.rc-new')).not.toContainText(/line/i);
  await box.fill('Build the index lazily.');
  await box.press(`${mod}+Enter`);
  await expect(file.locator('.rc-new')).toHaveCount(0);
  await expect(file.locator('.rc-thread[data-status="open"] .rc-field textarea')).toHaveValue('Build the index lazily.');
  await expect(header).toHaveText('Send 1 comment');

  // A deleted line: old side, line 13.
  await file.locator('[data-column-number="13"][data-line-type="change-deletion"]').click();
  const old = file.getByRole('textbox', { name: 'Comment on line 13' });
  await expect(old).toBeFocused();
  await old.fill('Was this needed?');
  await old.press(`${mod}+Enter`);
  await expect(header).toHaveText('Send 2 comments');
  await header.click();
  // The deleted line is quoted: its number is in the previous version.
  await expect(page.locator('#prompt')).toHaveValue('1. src/components/search.ts, line 12\n   Build the index lazily.\n\n2. src/components/search.ts, line 13 (deleted lines)\n   Was this needed?\n   Written on:\n      const index = createSearchIndex(items);' + SUMMARY);
  await expect(file.locator('.rc-thread')).toHaveCount(0);
});

test('"Send comments to agent" adds the comments to the composer, keeps the draft, sends nothing and clears them', async ({ page }) => {
  await openSource(page);
  await addComment(page, 4, 'Lower-case the query once.', 6);
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(3);
  const prompt = page.locator('#prompt');
  await prompt.fill('Please look at these:');
  const sent = page.locator('#transcript article.message.user-message');
  const before = await sent.count();
  expect(before).toBeGreaterThan(0);
  await send(page).click();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('Please look at these:\n\n1. src/main.ts, lines 4–6\n   Lower-case the query once.' + SUMMARY);
  // Sent comments are gone from the file; nothing was sent to the agent.
  await expect(page.locator('.rc-thread')).toHaveCount(0);
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(0);
  await expect(send(page)).toBeHidden();
  // A sent message would empty the composer and add a user message.
  await expect(prompt).not.toHaveValue('');
  await expect(sent).toHaveCount(before);
  await expect(page.locator('.rc-announcer')).toHaveText('1 comment added to the message');
});

test('pressing Send while a new comment is still in its field saves it and includes it', async ({ page }) => {
  await openSource(page);
  await addComment(page, 4, 'First.');
  await lineNumber(page, 2).click();
  await page.getByRole('textbox', { name: 'Comment on line 2' }).fill('Typed, never left.');
  await send(page).click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/main.ts, line 4\n   First.\n\n2. src/main.ts, line 2\n   Typed, never left.' + SUMMARY);
});

test('comments belong to their thread and come back with it', async ({ page }) => {
  await openSource(page);
  await addComment(page, 4, 'Mine.');
  await page.getByRole('button', { name: /Refine the navigation/ }).first().click();
  await openFile(page);
  await expect(page.locator('.rc-thread')).toHaveCount(0);
  await expect(send(page)).toBeHidden();
  await page.getByRole('button', { name: /Make search feel instant/ }).first().click();
  await openFile(page);
  await expect(field(saved(page))).toHaveValue('Mine.');
});

test('unsent comments survive a reload; sent ones do not come back', async ({ page }) => {
  await openSource(page);
  await addComment(page, 4, 'Keep me.');
  await page.reload();
  await expect(page.locator('#inspector')).toBeVisible();
  await openFile(page);
  await expect(field(saved(page))).toHaveValue('Keep me.');
  await send(page).click();
  await page.reload();
  await expect(page.locator('#inspector')).toBeVisible();
  await openFile(page);
  await expect(page.locator('.rc-thread')).toHaveCount(0);
});

test('in a diff, Shift-click extends an open comment to a range, carrying its text', async ({ page }) => {
  const file = await openChanges(page);
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await expect(box).toBeFocused();
  await box.fill('Started on one line.');
  // Pressing a line number keeps focus in the field, so its blur cannot drop pierre's selection mid-click.
  // New-side line 14 is a context line in this diff (12, 13 and 15 are the added ones).
  await file.locator('[data-column-number="14"][data-line-type="context"]').click({ modifiers: ['Shift'] });
  const range = file.getByRole('textbox', { name: 'Comment on lines 12–14' });
  await expect(range).toBeFocused();
  await expect(range).toHaveValue('Started on one line.');
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(0);
});

test('an empty comment field has no scrollbars and shows all of its placeholder on one row', async ({ page }) => {
  await openSource(page);
  const oneRow = async (box: Locator) => {
    expect(await box.evaluate(el => [getComputedStyle(el).overflowX, getComputedStyle(el).overflowY])).toEqual(['hidden', 'hidden']);
    expect(await box.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(await box.evaluate(el => el.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(el).lineHeight))).toBe(true);
  };
  await lineNumber(page, 2).click();
  await oneRow(page.getByRole('textbox', { name: 'Comment on line 2' }));
  // A saved comment emptied says Escape undoes it, on one row too; the rest is in its description.
  const thread = await addComment(page, 4, 'Emptied.');
  const box = field(thread);
  await box.click();
  await box.fill('');
  await expect(box).toHaveAttribute('placeholder', 'Comment · Esc undoes');
  await expect(box).toHaveAttribute('aria-description', /Escape undoes the edit\. Emptied, or with Delete comment, it is deleted\./);
  await oneRow(box);
  // And in a diff.
  const file = await openChanges(page);
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  await oneRow(file.getByRole('textbox', { name: 'Comment on line 12' }));
});

test('a comment being written survives the file view drawing itself again', async ({ page }) => {
  await openSource(page);
  await lineNumber(page, 2).click();
  const box = page.getByRole('textbox', { name: 'Comment on line 2' });
  await box.fill('Survives a redraw.');
  await box.press('ArrowLeft');
  // Wrap redraws the preview (as a file tab re-rendered after a run does). Clicked from script, so
  // the field is not left first.
  await page.evaluate(() => document.querySelector<HTMLElement>('#file-view [data-doc-wrap]')!.click());
  await expect(page.locator('#file-view [data-doc-wrap]')).toHaveAttribute('aria-pressed', 'true');
  const again = page.getByRole('textbox', { name: 'Comment on line 2' });
  await expect(again).toHaveValue('Survives a redraw.');
  await expect(again).toBeFocused();
  expect(await again.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe('Survives a redraw.'.length - 1);
  // An edit in progress on a saved comment survives too.
  await again.press(`${mod}+Enter`);
  const thread = saved(page);
  await field(thread).click();
  await field(thread).fill('Edited, not left yet.');
  await page.evaluate(() => document.querySelector<HTMLElement>('#file-view [data-doc-wrap]')!.click());
  await expect(field(saved(page))).toHaveValue('Edited, not left yet.');
  await expect(field(saved(page))).toBeFocused();
});

test('a comment being written in a diff survives the diff being refetched and drawn again', async ({ page }) => {
  const file = await openChanges(page);
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await expect(box).toBeFocused();
  await box.fill('Survives a refetch.');
  // The agent edits the file: the patch changes, and the refetched diff replaces the viewer.
  await page.evaluate(() => {
    (window as any).__previewAgentEdit((patch: string) => patch.replace('renderAll(', 'renderEverything('));
    document.querySelector<HTMLElement>('#inspector-refresh')!.click();
  });
  await expect(file.getByText('renderEverything')).toBeVisible();
  await expect(file.locator('.cv-diff')).toHaveCount(1);
  const again = file.getByRole('textbox', { name: 'Comment on line 12' });
  await expect(again).toHaveValue('Survives a refetch.');
  await expect(again).toBeFocused();
  await again.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id] .rc-field textarea')).toHaveValue('Survives a refetch.');
});

test('in a diff, selecting the same lines again keeps the comment field working', async ({ page }) => {
  const file = await openChanges(page);
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  await file.locator('[data-column-number="14"][data-line-type="context"]').click({ modifiers: ['Shift'] });
  const range = file.getByRole('textbox', { name: 'Comment on lines 12–14' });
  await expect(range).toBeFocused();
  await range.fill('Same lines twice.');
  await file.locator('[data-column-number="14"][data-line-type="context"]').click({ modifiers: ['Shift'] });
  await expect(range).toBeFocused();
  await expect(range).toHaveValue('Same lines twice.');
  await range.press(`${mod}+Enter`);
  await expect(file.locator('.rc-new')).toHaveCount(0);
  await expect(file.locator('.rc-thread[data-rc-id] .rc-field textarea')).toHaveValue('Same lines twice.');
  await expect(page.locator('.cv-header [data-rc-send]')).toHaveText('Send 1 comment');

  // And discarding works after reselecting too.
  await file.locator('[data-column-number="16"][data-line-type="context"]').click();
  await file.locator('[data-column-number="16"][data-line-type="context"]').click({ modifiers: ['Shift'] });
  await file.getByRole('button', { name: 'Discard comment' }).click();
  await expect(file.locator('.rc-new')).toHaveCount(0);
});

test('the file view takes a comment from the keyboard alone', async ({ page }) => {
  await openSource(page);
  // The line numbers are one Tab stop, after the header's buttons.
  await page.locator('#file-view [data-file-tab="copy"]').focus();
  const focusedLine = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.code-line')?.getAttribute('data-line') ?? null);
  for (let i = 0; i < 6 && await focusedLine() === null; i++) await page.keyboard.press('Tab');
  expect(await focusedLine()).toBe('1');
  await expect(page.locator('.code-preview .line-number[tabindex]')).toHaveCount(1);
  await expect(lineNumber(page, 1)).toHaveAccessibleName('Line 1, add comment');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(lineNumber(page, 4)).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.code-line.rc-selected')).toHaveCount(3);
  await expect(page.locator('.code-line[data-line="5"]')).toHaveAttribute('aria-description', 'Selected for a comment');
  await page.keyboard.press('Enter');
  const box = page.getByRole('textbox', { name: 'Comment on lines 4–6' });
  await expect(box).toBeFocused();
  await page.keyboard.type('Typed without a pointer.');
  await page.keyboard.press(`${mod}+Enter`);
  await expect(field(saved(page))).toHaveValue('Typed without a pointer.');
  await expect(page.locator('.rc-announcer')).toHaveText('Comment added on lines 4–6');
  // Focus goes back to the line number, which now says it is commented.
  await expect(lineNumber(page, 6)).toBeFocused();
  await expect(lineNumber(page, 6)).toHaveAccessibleName('Line 6, commented, add comment');
  await expect(page.locator('.code-line[data-line="5"]')).toHaveAttribute('aria-description', 'Commented');

  // Space opens one too; Escape drops it and returns to the number.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await expect(page.getByRole('textbox', { name: 'Comment on line 7' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(lineNumber(page, 7)).toBeFocused();
});

test('a diff takes a comment from the keyboard alone', async ({ page }) => {
  const file = await openChanges(page);
  const stop = file.locator('[data-column-number][tabindex="0"]');
  // Nothing is set up until the diff is used: an untouched diff has no line-number Tab stop.
  await expect(stop).toHaveCount(0);
  // Focus entering the diff (its content strip) puts one there, and Tab reaches it.
  await file.locator('.diff-viewer-content').focus();
  await expect(stop).toHaveCount(1);
  await expect(stop).toHaveAccessibleName('Line 12, add comment');
  await page.keyboard.press('Tab');
  await expect(stop).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const added13 = file.locator('[data-column-number="13"][data-line-type="change-addition"]');
  await expect(added13).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  const box = file.getByRole('textbox', { name: 'Comment on lines 13–14' });
  await expect(box).toBeFocused();
  await page.keyboard.type('From the keyboard.');
  await page.keyboard.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id] .rc-field textarea')).toHaveValue('From the keyboard.');
  const context14 = file.locator('[data-column-number="14"][data-line-type="context"]');
  await expect(context14).toBeFocused();
  await expect(context14).toHaveAccessibleName('Line 14, commented, add comment');

  // A deleted line names its side; Escape closes a new comment and returns to the number.
  await page.keyboard.press('ArrowDown');
  const deleted13 = file.locator('[data-column-number="13"][data-line-type="change-deletion"]');
  await expect(deleted13).toBeFocused();
  await expect(deleted13).toHaveAccessibleName('Deleted line 13, add comment');
  await page.keyboard.press('Enter');
  await expect(file.getByRole('textbox', { name: 'Comment on line 13' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(file.locator('.rc-new')).toHaveCount(0);
  await expect(deleted13).toBeFocused();
});

/** Opens the Changes view on a two-hunk diff: new lines 12–17, then 31–34 (lines 18–30 are collapsed). */
async function openTwoHunks(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await page.evaluate(() => (window as any).__previewAgentEdit((patch: string) => `${patch}\n@@ -30,3 +31,4 @@ function later() {\n   one();\n+  two();\n   three();\n   four();`));
  await openInspectorTab(page, 'Changes');
  await page.getByRole('tab', { name: /^Changes/ }).click();
  const file = page.locator('.cv-file[data-path="src/components/search.ts"]');
  await expect(file.locator('.diff-viewer[data-diff-state="ready"][data-review-hooks]')).toBeVisible();
  await expect(file.locator('[data-column-number="33"][data-line-type="context"]')).toBeVisible();
  return file;
}

test('a diff range stops at the edge of the hunk it starts in (keyboard and pointer)', async ({ page }) => {
  const file = await openTwoHunks(page);
  await file.locator('.diff-viewer-content').focus();
  await page.keyboard.press('Tab');
  // 12, 13 (added), 14 (context), 13, 14 (deleted), 15 (added), 16 (context).
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  const context16 = file.locator('[data-column-number="16"][data-line-type="context"]');
  await expect(context16).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  const last = file.locator('[data-column-number="17"][data-line-type="context"]');
  await expect(last).toBeFocused();
  // The next number is in the second hunk: Shift+Down stays at this hunk's last line.
  await page.keyboard.press('Shift+ArrowDown');
  await expect(last).toBeFocused();
  await page.keyboard.press('Shift+End');
  await expect(last).toBeFocused();
  await page.keyboard.press('Enter');
  const box = file.getByRole('textbox', { name: 'Comment on lines 16–17' });
  await expect(box).toBeFocused();
  await box.fill('Within one hunk.');
  await box.press(`${mod}+Enter`);
  // Saved on the lines it covers, not outdated.
  const thread = file.locator('.rc-thread[data-rc-id][aria-label="Comment on lines 16–17"]');
  await expect(thread).toHaveAttribute('data-status', 'open');
  await expect(thread.locator('.rc-badge')).toHaveCount(0);

  // A pointer range across the gap stops at the hunk's edge too.
  await file.locator('[data-column-number="14"][data-line-type="context"]').click();
  await file.locator('[data-column-number="33"][data-line-type="context"]').click({ modifiers: ['Shift'] });
  const range = file.getByRole('textbox', { name: 'Comment on lines 14–17' });
  await expect(range).toBeFocused();
  await range.fill('Also within one hunk.');
  await range.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id][aria-label="Comment on lines 14–17"]')).toHaveAttribute('data-status', 'open');
  await expect(file.locator('.rc-badge')).toHaveCount(0);
});

test('a comment being written follows its lines when the agent edits the file, and keeps its text when they change', async ({ page }) => {
  await openSource(page);
  const refresh = () => page.evaluate(() => document.querySelector<HTMLElement>('#inspector-refresh')!.click());
  await lineNumber(page, 5).click();
  const box = page.getByRole('textbox', { name: 'Comment on line 5' });
  await box.fill('Follows its line.');
  // The agent adds two lines at the top while the comment is being written. Refreshed from script,
  // so the field is not left first.
  await page.evaluate(() => (window as any).__previewFileEdit((source: string) => `// one\n// two\n${source}`));
  await refresh();
  const moved = page.getByRole('textbox', { name: 'Comment on line 7' });
  await expect(moved).toHaveValue('Follows its line.');
  await expect(moved).toBeFocused();
  await expect(page.locator('.code-line[data-line="7"]')).toHaveClass(/rc-selected/);
  await expect(page.locator('.code-line.rc-selected')).toHaveCount(1);
  await moved.press(`${mod}+Enter`);
  const saved7 = page.locator('.rc-thread[data-rc-id][aria-label="Comment on line 7"]');
  await expect(field(saved7)).toHaveValue('Follows its line.');
  expect(await saved7.evaluate(el => (el.previousElementSibling as HTMLElement).dataset.line)).toBe('7');

  // Its line changes while a second comment is written: the text stays, the comment says so, and
  // once saved it is outdated rather than put on other code.
  await lineNumber(page, 8).click();
  const second = page.getByRole('textbox', { name: 'Comment on line 8' });
  await second.fill('Written on the old code.');
  await page.evaluate(() => (window as any).__previewFileEdit((source: string) => `// one\n// two\n${source.replace('query.toLowerCase()', 'query.trim()')}`));
  await refresh();
  const kept = page.getByRole('textbox', { name: 'Comment on line 8' });
  await expect(kept).toHaveValue('Written on the old code.');
  await expect(page.locator('.rc-new .rc-note')).toHaveText('Line 8 changed while you were writing');
  await expect(page.locator('.code-line.rc-selected')).toHaveCount(0);
  await kept.press(`${mod}+Enter`);
  const outdated = page.locator('.rc-thread[data-rc-id][data-status="outdated"]');
  await expect(field(outdated)).toHaveValue('Written on the old code.');
  await expect(outdated.locator('.rc-badge[data-rc-status="outdated"]')).toHaveText('Outdated');
});

test('a comment being written in a diff follows its lines, and stays on screen when the diff no longer shows them', async ({ page }) => {
  const file = await openChanges(page);
  const refresh = () => page.evaluate(() => document.querySelector<HTMLElement>('#inspector-refresh')!.click());
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await box.fill('Follows the hunk.');
  // Two lines added above the hunk: its lines move down by two.
  await page.evaluate(() => (window as any).__previewAgentEdit((patch: string) => patch.replace('@@ -12,5 +12,6 @@', '@@ -14,5 +14,6 @@')));
  await refresh();
  await expect(file.locator('[data-column-number="19"][data-line-type="context"]')).toBeVisible();
  const moved = file.getByRole('textbox', { name: 'Comment on line 14' });
  await expect(moved).toHaveValue('Follows the hunk.');
  await expect(moved).toBeFocused();

  // The hunk is replaced by another part of the file: the comment stays, above the diff, saying why.
  await page.evaluate(() => (window as any).__previewAgentEdit((patch: string) => patch.replace(/@@ -12,5 \+12,6 @@[^]*$/, '@@ -40,2 +40,3 @@\n alpha();\n+beta();\n gamma();')));
  await refresh();
  await expect(file.locator('[data-column-number="41"][data-line-type="change-addition"]')).toBeVisible();
  const away = file.getByRole('textbox', { name: 'Comment on line 14' });
  await expect(away).toHaveValue('Follows the hunk.');
  await expect(file.locator('.rc-new .rc-note')).toHaveText('Line 14 is no longer in this diff');
  await away.focus();
  await away.press(`${mod}+Enter`);
  const saved = file.locator('.rc-thread[data-rc-id]');
  await expect(field(saved)).toHaveValue('Follows the hunk.');
  await expect(saved.locator('.rc-note')).toHaveText('Line 14 is no longer in this diff');
  await expect(page.locator('.cv-header [data-rc-send]')).toHaveText('Send 1 comment');
});

test('a commented diff line keeps its added or deleted colour under the comment tint', async ({ page }) => {
  const file = await openChanges(page);
  const added = (line: number) => file.locator(`[data-line="${line}"][data-line-type="change-addition"]`);
  const background = (el: Locator) => el.evaluate(node => getComputedStyle(node).backgroundColor);
  await page.mouse.move(0, 0);
  const plain = await background(added(15));
  await file.locator('[data-column-number="15"][data-line-type="change-addition"]').click();
  await file.getByRole('textbox', { name: 'Comment on line 15' }).fill('Tinted, still green.');
  await file.getByRole('textbox', { name: 'Comment on line 15' }).press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect.poll(() => added(15).evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
  expect(await background(added(15))).toBe(plain);
  // Cmd/Ctrl+Enter put focus back on the line number. Moved there with the keyboard, its focus
  // ring shows, and the accent edge stays, inside it.
  const number = file.locator('[data-column-number="15"][data-line-type="change-addition"]');
  await expect(number).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(number).toBeFocused();
  expect(await number.evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/4px 0px 0px 0px inset/);
  expect(await number.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('a diff never waits for the line comments\' code, and takes comments once it arrives', async ({ page }) => {
  // Hold the diff part of the line comments until the diff is on screen.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/review-comments-diff\.ts/, async route => { await held; await route.continue(); });
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await openInspectorTab(page, 'Changes');
  await page.getByRole('tab', { name: /^Changes/ }).click();
  const file = page.locator('.cv-file[data-path="src/components/search.ts"]');
  const viewer = file.locator('.diff-viewer');
  await expect(viewer).toHaveAttribute('data-diff-state', 'ready');
  const number = file.locator('[data-column-number="12"][data-line-type="change-addition"]');
  await expect(number).toBeVisible();
  expect(await viewer.evaluate(el => el.hasAttribute('data-review-hooks'))).toBe(false);
  await expect(page.locator('.cv-body > .rc-hint')).toHaveCount(0);
  // Focus is in the diff when the hooks arrive: the line numbers' Tab stop is set up then, with no
  // focus event to set it up later.
  const strip = file.locator('.diff-viewer-content');
  await strip.focus();
  release();
  // Drawn again with the hooks: the hint shows, and line numbers take comments.
  await expect(viewer).toHaveAttribute('data-review-hooks', '');
  await expect(page.locator('.cv-body > .rc-hint')).toBeVisible();
  await expect(file.locator('[data-column-number="12"]').first()).toHaveAttribute('tabindex', '0');
  await expect(strip).toBeFocused();
  await number.click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await expect(box).toBeFocused();
  await box.fill('Attached late.');
  await box.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(1);
  await expect.poll(() => file.locator('[data-line="12"][data-line-type="change-addition"]').evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
});

test('with forced colours, a commented range is outlined as one block in both views', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  /** The block's edges drawn on a row: [top, right, bottom, left] widths of its ::after overlay. */
  const edges = (row: Locator) => row.evaluate(node => { const s = getComputedStyle(node, '::after'); return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '); });
  const height = (row: Locator) => row.evaluate(node => node.getBoundingClientRect().height);
  await openSource(page);
  const row = (line: number) => page.locator(`.code-preview .code-line[data-line="${line}"]`);
  const plain = await height(row(5));
  await addComment(page, 4, 'One block.', 6);
  expect(await edges(row(4))).toBe('2px 2px 0px 2px');
  expect(await edges(row(5))).toBe('0px 2px 0px 2px');
  expect(await edges(row(6))).toBe('0px 2px 2px 2px');
  expect(await row(3).evaluate(node => getComputedStyle(node, '::after').content)).toBe('none');
  expect(await height(row(5)), 'the rows keep their height').toBe(plain);
  // A range being picked is dashed.
  await lineNumber(page, 8).click();
  await lineNumber(page, 9).click({ modifiers: ['Shift'] });
  expect(await row(8).evaluate(node => getComputedStyle(node, '::after').borderTopStyle)).toBe('dashed');

  const file = await openChanges(page);
  const line = (n: number) => file.locator(`[data-line="${n}"]:not([data-line-type="change-deletion"])`);
  await file.locator('[data-column-number="15"][data-line-type="change-addition"]').click();
  await file.locator('[data-column-number="16"]:not([data-line-type="change-deletion"])').click({ modifiers: ['Shift'] });
  const box = file.getByRole('textbox', { name: 'Comment on lines 15–16' });
  await box.fill('One block here too.');
  await box.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(1);
  await expect.poll(() => edges(line(15))).toBe('2px 2px 0px 2px');
  expect(await edges(line(16))).toBe('0px 2px 2px 2px');
  // The line numbers are filled instead of outlined, one solid column.
  const number = file.locator('[data-column-number="15"][data-line-type="change-addition"]');
  expect(await number.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
});

test('deleting an earlier comment in a diff keeps focus and typing in the comment being edited', async ({ page }) => {
  const file = await openChanges(page);
  const comment = async (selector: string, name: string, text: string) => {
    await file.locator(selector).click();
    const box = file.getByRole('textbox', { name });
    await expect(box).toBeFocused();
    await box.fill(text);
    await box.press(`${mod}+Enter`);
    await expect(file.locator('.rc-new')).toHaveCount(0);
  };
  await comment('[data-column-number="12"][data-line-type="change-addition"]', 'Comment on line 12', 'First.');
  await comment('[data-column-number="15"][data-line-type="change-addition"]', 'Comment on line 15', 'Second');
  // Editing the later comment, the earlier one is deleted with its ×: pierre moves the later one's
  // element into the freed annotation slot, and the field keeps focus, caret and text.
  const second = file.getByRole('textbox', { name: 'Comment on line 15' });
  await second.click();
  await second.press('End');
  await page.keyboard.type(', edited');
  await file.locator('.rc-thread[data-rc-id]', { has: page.getByRole('textbox', { name: 'Comment on line 12' }) }).getByRole('button', { name: 'Delete comment' }).click();
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(1);
  await expect(second).toBeFocused();
  await page.keyboard.type(' and kept.');
  await expect(second).toHaveValue('Second, edited and kept.');
  // Leaving saves it.
  await second.press(`${mod}+Enter`);
  const header = page.locator('.cv-header [data-rc-send]');
  await expect(header).toHaveText('Send 1 comment');
  await header.click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/components/search.ts, line 15\n   Second, edited and kept.' + SUMMARY);
});

test('a diff range from an added line to a deleted one covers the new-side lines it spans', async ({ page }) => {
  const file = await openChanges(page);
  // Added 12 down to deleted 14: the rows are added 12 and 13, context 14 and deleted 13 and 14.
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  await expect(file.getByRole('textbox', { name: 'Comment on line 12' })).toBeFocused();
  await file.locator('[data-column-number="14"][data-line-type="change-deletion"]').click({ modifiers: ['Shift'] });
  const box = file.getByRole('textbox', { name: 'Comment on lines 12–14' });
  await expect(box).toBeFocused();
  await box.fill('The whole block.');
  await box.press(`${mod}+Enter`);
  await expect(file.locator('.rc-thread[data-rc-id]')).toHaveCount(1);
  // The new-side lines are highlighted (13 is an added line, 14 a context one).
  for (const selector of ['[data-line="13"][data-line-type="change-addition"]', '[data-line="14"][data-line-type="context"]']) {
    await expect.poll(() => file.locator(selector).evaluate(node => getComputedStyle(node).boxShadow)).toContain('inset');
  }
  // The deleted lines it left out are named on the saved comment and in the message.
  await expect(file.locator('.rc-thread[data-rc-id] .rc-note')).toHaveText('Deleted lines 13–14 not included');
  await page.locator('.cv-header [data-rc-send]').click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/components/search.ts, lines 12–14 (deleted lines 13–14 not included)\n   The whole block.' + SUMMARY);
});

test('diff comments on a file the Changes list no longer shows sit in a group of their own, still sent', async ({ page }) => {
  const file = await openChanges(page);
  const away = page.locator('.cv-away');
  const header = page.locator('.cv-header [data-rc-send]');
  await expect(away).toBeHidden();
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await box.fill('Build the index lazily.');
  await box.press(`${mod}+Enter`);
  await file.locator('[data-column-number="13"][data-line-type="change-deletion"]').click();
  const old = file.getByRole('textbox', { name: 'Comment on line 13' });
  await old.fill('Was this needed?');
  await old.press(`${mod}+Enter`);
  await expect(header).toHaveText('Send 2 comments');
  await expect(away).toBeHidden();

  // The agent commits the file: it leaves the list, and its comments move to the group.
  await page.evaluate(() => {
    (window as any).__previewCommitFile('src/components/search.ts');
    document.querySelector<HTMLElement>('#inspector-refresh')!.click();
  });
  await expect(file).toHaveCount(0);
  await expect(away).toBeVisible();
  await expect(away).toHaveAttribute('aria-label', 'Comments on files not shown');
  const items = away.locator('.rc-away-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('.rc-away-file')).toHaveText('src/components/search.ts');
  await expect(items.nth(0).locator('.rc-away-lines')).toHaveText('Line 12');
  await expect(items.nth(1).locator('.rc-away-lines')).toHaveText('Line 13 (deleted lines)');
  await expect(header).toHaveText('Send 2 comments');

  // Edited in place, and deleted.
  const first = field(items.nth(0));
  await first.click();
  await first.fill('Build it lazily.');
  await first.press(`${mod}+Enter`);
  await expect(field(items.nth(0))).toHaveValue('Build it lazily.');
  await items.nth(1).getByRole('button', { name: 'Delete comment' }).click();
  await expect(items).toHaveCount(1);
  await expect(header).toHaveText('Send 1 comment');

  // Send still takes it, quoting the code it was written on (no view shows it on its lines), and
  // the group goes.
  await header.click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/components/search.ts, line 12\n   Build it lazily.\n   Written on:\n      const index = createSearchIndex(items);' + SUMMARY);
  await expect(away).toBeHidden();
  await expect(header).toBeHidden();
});

test('a comment being written when the agent commits its file is saved into the group, not lost from view', async ({ page }) => {
  const file = await openChanges(page);
  const away = page.locator('.cv-away');
  const header = page.locator('.cv-header [data-rc-send]');
  // The file already has a saved comment, so the group takes its comments as soon as it leaves.
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const first = file.getByRole('textbox', { name: 'Comment on line 12' });
  await first.fill('Saved first.');
  await first.press(`${mod}+Enter`);
  // A second one is being typed when the agent commits the file.
  await file.locator('[data-column-number="15"][data-line-type="change-addition"]').click();
  const typing = file.getByRole('textbox', { name: 'Comment on line 15' });
  await expect(typing).toBeFocused();
  await typing.fill('Still typing');
  await page.evaluate(() => {
    (window as any).__previewCommitFile('src/components/search.ts');
    document.querySelector<HTMLElement>('#inspector-refresh')!.click();
  });
  await expect(file).toHaveCount(0);
  const items = away.locator('.rc-away-item');
  await expect(items).toHaveCount(2);
  await expect(items.locator('.rc-away-lines')).toHaveText(['Line 12', 'Line 15']);
  await expect(field(items.nth(1))).toHaveValue('Still typing');
  await expect(header).toHaveText('Send 2 comments');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.lineComments:')).map(key => localStorage.getItem(key)).join())).toContain('Still typing');
  // It is a saved comment now: Send quotes the code it was written on, as for the other.
  await header.click();
  await expect(page.locator('#prompt')).toHaveValue(/^1\. src\/components\/search\.ts, line 12\n {3}Saved first\.\n {3}Written on:\n.*\n\n2\. src\/components\/search\.ts, line 15\n {3}Still typing\n {3}Written on:\n/s);
});

test('a comment field still focused when its view goes away is saved then, and takes no focus later', async ({ page }) => {
  await openSource(page);
  await lineNumber(page, 4).click();
  const box = page.locator('.rc-new .rc-field textarea');
  await expect(box).toBeFocused();
  await box.fill('Kept when the tab closes.');
  // The tab closes without the field being left first (a click from script moves no focus).
  await page.evaluate(() => document.querySelector<HTMLElement>('.file-tab.selected [data-file-tab="close"]')!.click());
  await expect(page.locator('.code-preview')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.lineComments:')).map(key => localStorage.getItem(key)).join())).toContain('Kept when the tab closes.');
  await openFile(page);
  await expect(field(saved(page))).toHaveValue('Kept when the tab closes.');
  await expect(page.locator('.rc-new')).toHaveCount(0);
  await expect(field(saved(page))).not.toBeFocused();
});

test('at the inspector\'s default width, Send still says "Send", and the headers keep their labels', async ({ page }) => {
  const file = await openChanges(page);
  const view = page.locator('.changes-view');
  expect(Math.round(await view.evaluate(el => el.clientWidth))).toBeLessThanOrEqual(290);
  const header = page.locator('.cv-header [data-rc-send]');
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await box.fill('One.');
  await box.press(`${mod}+Enter`);
  await expect(header).toBeVisible();
  const scope = page.locator('.cv-scope-label');
  await expect(scope).toHaveText('All changes');
  const fits = (el: Locator) => el.evaluate(node => node.scrollWidth <= node.clientWidth);
  // Not cut off: the scope picker reads in full with a comment present.
  expect(await fits(scope)).toBe(true);
  // Send reads as an action, "Send" and the count; its name and tooltip say all of it, and it never shrinks.
  await expect(header).toHaveAttribute('aria-label', 'Send 1 comment to agent');
  await expect(header).toHaveAttribute('title', /^Send 1 comment to agent/);
  await expect(header.locator('.rc-send-verb')).toBeVisible();
  await expect(header.locator('.rc-send-verb')).toHaveText('Send');
  await expect(header.locator('.rc-send-rest')).toBeHidden();
  await expect(header.locator('.icon')).toBeHidden();
  expect(await header.evaluate(el => getComputedStyle(el, '::after').content)).toBe('"1"');
  expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).flexShrink === '0')).toBe(true);
  // The line and file counts made room for it (each file's row keeps its own counts).
  await expect(page.locator('.cv-header .cv-adds')).toBeHidden();
  await expect(page.locator('.cv-header .cv-files')).toBeHidden();
  // Every header control stays inside the header.
  expect(await fits(page.locator('.cv-header'))).toBe(true);

  // The Files header the same way: the path keeps its room, Attach shows its icon only (and keeps
  // its name), and the header stays one row.
  await openFile(page);
  const fileHeader = page.locator('.file-view-header');
  const rowHeight = await fileHeader.evaluate(el => el.getBoundingClientRect().height);
  await addComment(page, 4, 'Two.');
  await expect(send(page)).toHaveAttribute('aria-label', 'Send 2 comments to agent');
  await expect(send(page).locator('.rc-send-verb')).toBeVisible();
  expect(await send(page).evaluate(el => getComputedStyle(el, '::after').content)).toBe('"2"');
  const attach = page.getByRole('button', { name: 'Attach', exact: true });
  await expect(attach).toBeVisible();
  await expect(attach.locator('.file-attach-label')).toHaveCSS('position', 'absolute');
  expect(await fits(page.locator('.file-view-path'))).toBe(true);
  expect(await fits(fileHeader)).toBe(true);
  expect(await fileHeader.evaluate(el => el.getBoundingClientRect().height)).toBe(rowHeight);

  /** Reloads with an inspector `width` wide and returns the Changes view's width. */
  const widen = async (width: number) => {
    await page.evaluate(value => localStorage.setItem('pandacode.inspectorWidth', String(value)), width);
    await page.reload();
    await expect(page.locator('#inspector')).toBeVisible();
    await page.getByRole('tab', { name: /^Changes/ }).click();
    await expect(header).toBeVisible();
    return Math.round(await view.evaluate(el => el.clientWidth));
  };
  // From 340px the file count is back; the line counts still make room.
  expect(await widen(WIDE_FOR_340)).toBeGreaterThanOrEqual(340);
  await expect(page.locator('.cv-header .cv-files')).toBeVisible();
  await expect(page.locator('.cv-header .cv-adds')).toBeHidden();
  await expect(header.locator('.rc-send-verb')).toBeVisible();
  expect(await fits(page.locator('.cv-header'))).toBe(true);
  expect(await fits(scope)).toBe(true);

  // Between 400px and 480px, "Send" is followed by a speech bubble and the count, and it all fits.
  for (const width of [WIDE_FOR_400, WIDE_FOR_479]) {
    const inner = await widen(width);
    expect(inner, `inspector ${width}`).toBeGreaterThanOrEqual(400);
    expect(inner, `inspector ${width}`).toBeLessThan(480);
    await expect(header.locator('.rc-send-verb')).toBeVisible();
    await expect(header.locator('.rc-send-rest')).toBeHidden();
    await expect(header.locator('.icon')).toBeVisible();
    expect(await header.locator('.icon').innerHTML()).toContain('M21 15a2 2 0 0 1-2 2H8l-5 4V5');
    expect(await header.evaluate(el => getComputedStyle(el, '::after').content)).toBe('"2"');
    expect(await fits(header)).toBe(true);
    expect(await fits(page.locator('.cv-header'))).toBe(true);
    expect(await fits(scope)).toBe(true);
    await expect(page.locator('.cv-header .cv-files')).toBeVisible();
    await expect(page.locator('.cv-header .cv-adds')).toBeVisible();
    // Verb first, then the bubble and the count.
    expect(await header.evaluate(el => el.querySelector('.rc-send-verb')!.getBoundingClientRect().right <= el.querySelector('.icon')!.getBoundingClientRect().left)).toBe(true);
  }

  // A wider inspector has room for the words.
  await widen(560);
  await expect(header.locator('.rc-send-label')).toBeVisible();
  await expect(header.locator('.rc-send-label')).toHaveText('Send 2 comments');
  await expect(header.locator('.icon')).toBeHidden();
  expect(await header.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
  await expect(page.locator('.cv-files')).toBeVisible();
});

test('until the first comment, a faint hint says how to start one; then it is gone for good', async ({ page }) => {
  await openSource(page);
  const hint = page.locator('.doc-toolbar .rc-hint');
  await expect(hint).toHaveText('Click a line number to comment');
  await expect(hint).toBeVisible();
  await addComment(page, 4, 'First.');
  await expect(hint).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pandacode.lineCommentHintSeen'))).toBe('1');
  // Cmd/Ctrl+Enter put focus back on the commented number; moved there with the keyboard, its
  // accent edge shows inside the focus ring.
  await expect(lineNumber(page, 4)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(lineNumber(page, 4)).toBeFocused();
  expect(await lineNumber(page, 4).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  expect(await lineNumber(page, 4).evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/4px 0px 0px 0px inset/);
  // Sent, the comments are gone, and so is the hint, after a reload and in the Changes view too.
  await send(page).click();
  await page.reload();
  await expect(page.locator('#inspector')).toBeVisible();
  await openFile(page);
  await expect(page.locator('.rc-hint')).toHaveCount(0);
  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(page.locator('.cv-file[data-path="src/components/search.ts"] .diff-viewer[data-diff-state="ready"][data-review-hooks]')).toBeVisible();
  await expect(page.locator('.rc-hint')).toHaveCount(0);
});

test('the Changes view shows the hint above its list until a comment is made', async ({ page }) => {
  const file = await openChanges(page);
  const hint = page.locator('.cv-body > .rc-hint');
  await expect(hint).toHaveText('Click a line number to comment');
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await box.fill('Hinted.');
  await expect(hint).toBeVisible();
  await box.press(`${mod}+Enter`);
  await expect(hint).toHaveCount(0);
});

test('Files view comments on a file with no tab open are listed in the Changes view, editable and sent', async ({ page }) => {
  await openSource(page);
  await addComment(page, 4, 'On the file.');
  // The tab closes: the comment has no view to sit in.
  await page.locator('.file-tab.selected [data-file-tab="close"]').click();
  await expect(page.locator('.code-preview')).toHaveCount(0);
  await openInspectorTab(page, 'Changes');
  await page.getByRole('tab', { name: /^Changes/ }).click();
  const away = page.locator('.cv-away');
  await expect(away).toBeVisible();
  const item = away.locator('.rc-away-item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.rc-away-file')).toHaveText('src/main.ts');
  await expect(item.locator('.rc-away-lines')).toHaveText('Line 4 (Files view)');
  const box = field(item);
  await expect(box).toHaveValue('On the file.');
  await box.click();
  await box.fill('Edited where it is listed.');
  await box.press(`${mod}+Enter`);
  await expect(field(item)).toHaveValue('Edited where it is listed.');
  // Opened again, the file shows it, and the group goes.
  await openFile(page);
  await expect(field(saved(page))).toHaveValue('Edited where it is listed.');
  await openInspectorTab(page, 'Changes');
  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(away).toBeHidden();
  await page.locator('.cv-header [data-rc-send]').click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/main.ts, line 4\n   Edited where it is listed.' + SUMMARY);
});

test('diff comments on a file whose diff falls back to plain text are listed in the group', async ({ page }) => {
  const file = await openChanges(page);
  await file.locator('[data-column-number="12"][data-line-type="change-addition"]').click();
  const box = file.getByRole('textbox', { name: 'Comment on line 12' });
  await box.fill('Still reachable.');
  await box.press(`${mod}+Enter`);
  const away = page.locator('.cv-away');
  await expect(away).toBeHidden();
  // The agent turns the file into a binary one: its diff is plain text, with no lines to comment on.
  await page.evaluate(() => {
    (window as any).__previewAgentEdit(() => 'diff --git a/src/components/search.ts b/src/components/search.ts\nBinary files a/src/components/search.ts and b/src/components/search.ts differ\n');
    document.querySelector<HTMLElement>('#inspector-refresh')!.click();
  });
  await expect(file.locator('.diff-viewer[data-diff-state="fallback"]')).toBeVisible();
  await expect(away).toBeVisible();
  await expect(away.locator('.rc-away-lines')).toHaveText('Line 12');
  await expect(field(away.locator('.rc-away-item'))).toHaveValue('Still reachable.');
});

test('comments in a New task keep it, and come back when New task reopens it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  const draftId = await page.locator('#prompt').getAttribute('data-session-id');
  expect(draftId).toBeTruthy();
  await openFile(page);
  await addComment(page, 4, 'Before the first prompt.');
  // Leaving it with only a comment keeps it, hidden, like typed text would.
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('.new-task-button').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', draftId!);
  await openFile(page);
  await expect(field(saved(page))).toHaveValue('Before the first prompt.');
});

test('a diff range from a deleted line to an added one highlights only the lines it comments on, and names the deleted lines it leaves out', async ({ page }) => {
  const file = await openChanges(page);
  const number = (line: number, type: string) => file.locator(`[data-column-number="${line}"][data-line-type="${type}"]`);
  const selected = (el: Locator) => el.evaluate(node => node.hasAttribute('data-selected-line'));
  // Drawn with the pointer: pressed on deleted 13 and held over added 15, only added 15 is
  // highlighted, as only it will be commented on.
  // Boxes once both are on screen (a refetched diff can still be taking the old one's place).
  const boxOf = async (el: Locator) => { let box = await el.boundingBox(); await expect.poll(async () => (box = await el.boundingBox()) !== null).toBe(true); return box!; };
  const from = await boxOf(number(13, 'change-deletion')), to = await boxOf(number(15, 'change-addition'));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await expect.poll(() => selected(number(15, 'change-addition'))).toBe(true);
  expect(await selected(number(13, 'change-deletion'))).toBe(false);
  expect(await selected(number(14, 'change-deletion'))).toBe(false);
  await page.mouse.up();
  const box = file.getByRole('textbox', { name: 'Comment on line 15' });
  await expect(box).toBeFocused();
  await expect(file.locator('.rc-new .rc-note')).toHaveText('Deleted lines 13–14 not included');
  expect(await selected(number(13, 'change-deletion'))).toBe(false);
  expect(await selected(number(15, 'change-addition'))).toBe(true);
  await box.press('Escape');
  await expect(file.locator('.rc-new')).toHaveCount(0);

  // Shift-click the same way, from the other end.
  await number(15, 'change-addition').click();
  await number(14, 'change-deletion').click({ modifiers: ['Shift'] });
  const again = file.getByRole('textbox', { name: 'Comment on line 15' });
  await expect(again).toBeFocused();
  await expect(file.locator('.rc-new .rc-note')).toHaveText('Deleted line 14 not included');
  expect(await selected(number(14, 'change-deletion'))).toBe(false);
  await again.fill('Only the new line.');
  await again.press(`${mod}+Enter`);
  // The saved comment is on line 15 alone, and still names the deleted line it left out, here, in
  // the group of comments no view shows, and in the message.
  const saved = file.locator('.rc-thread[data-rc-id]');
  await expect(saved).toHaveAttribute('aria-label', 'Comment on line 15');
  await expect(saved.locator('.rc-note')).toHaveText('Deleted line 14 not included');
  await page.evaluate(() => {
    (window as any).__previewCommitFile('src/components/search.ts');
    document.querySelector<HTMLElement>('#inspector-refresh')!.click();
  });
  const listed = page.locator('.cv-away .rc-away-item');
  await expect(listed.locator('.rc-away-lines')).toHaveText('Line 15');
  await expect(listed.locator('.rc-note')).toHaveText('Deleted line 14 not included');
  await page.locator('.cv-header [data-rc-send]').click();
  await expect(page.locator('#prompt')).toHaveValue(/^1\. src\/components\/search\.ts, line 15 \(deleted line 14 not included\)\n {3}Only the new line\.\n/);
});

test('a deleted comment comes back with Undo, from the toast or Cmd/Ctrl+Z', async ({ page }) => {
  await openSource(page);
  await addComment(page, 2, 'Keep me first.');
  const thread = await addComment(page, 4, 'Bring me back.', 6);
  await thread.getByRole('button', { name: 'Delete comment' }).click();
  await expect(saved(page)).toHaveCount(1);
  const toast = page.locator('#toast');
  await expect(toast).toContainText('Comment deleted');
  await toast.getByRole('button', { name: 'Undo' }).click();
  // Back in its place, with its lines.
  const back = page.locator('.rc-thread[data-rc-id][aria-label="Comment on lines 4–6"]');
  await expect(field(back)).toHaveValue('Bring me back.');
  await expect(page.locator('.code-line.rc-covered')).toHaveCount(4);
  await expect(page.locator('.rc-announcer')).toHaveText('Comment restored');
  await expect(send(page)).toHaveText('Send 2 comments');

  // From the keyboard: × with Enter, then Cmd/Ctrl+Z.
  await back.getByRole('button', { name: 'Delete comment' }).focus();
  await page.keyboard.press('Enter');
  await expect(saved(page)).toHaveCount(1);
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(field(back)).toHaveValue('Bring me back.');
  await page.locator('.cv-header [data-rc-send], #file-view [data-rc-send]').first().click();
  await expect(page.locator('#prompt')).toHaveValue('1. src/main.ts, line 2\n   Keep me first.\n\n2. src/main.ts, lines 4–6\n   Bring me back.' + SUMMARY);
});
