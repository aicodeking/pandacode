import { expect, test, type Page } from '@playwright/test';
import { pauseClock } from './page-clock-helper';
import { openInspectorTab } from './inspector-tab-helper';

// Thread errors (main.ts errorRowHtml, thread-errors.ts): identical errors are one row with a count,
// the full text folds open, and rows can be dismissed (saved ones through `dismiss_error_messages`).
const SESSION = 'session-4';
const ENOTFOUND = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const LONG = 'Build failed in 3 packages\n  at packages/core: exit 1\n  at packages/ui: exit 1';
type Seed = { role: string; content: string };
const CHANGES = { id: 'tc-1', files: [], additions: 0, deletions: 0, truncated: false, concurrent: false };

const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const rows = (page: Page) => transcript(page).locator('.message-error');

/** The page clock starts here before the first script runs, and boot runs on it in real time. */
const BOOT = Date.UTC(2026, 10, 11, 10);
/** Once the app is up, the clock pauses at this fixed instant: far enough ahead that a slow boot cannot pass it (pauseAt
 * cannot go back), so a toast's life, the Undo window and Escape's grace move only with fastForward/runFor. */
const PAUSED_AT = BOOT + 10 * 60_000;
/** Seeds the thread, records `dismiss_error_messages` calls (window.__dismissCalls) and can make them fail (window.__dismissFail)
 * or never answer (window.__dismissHang, like a quit in the middle of the call); counts `get_messages` calls
 * (window.__pageLoads) and can make them fail (window.__messagesFail). */
async function open(page: Page, seed: Seed[], others: Record<string, Seed[]> = {}, url = '/'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const rowsOf = (sessionId: string, entries: Seed[], first: number) => entries.map((entry, index) => ({ id: first + index, sessionId, role: entry.role, content: entry.content, createdAt: 1_784_000_000_000 + index * 1000 }));
  const fixture = rowsOf(SESSION, seed, 300);
  const extra = Object.entries(others).map(([sessionId, entries], index) => `messages[${JSON.stringify(sessionId)}] = ${JSON.stringify(rowsOf(sessionId, entries, 600 + index * 100))};`).join('\n');
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']dismiss_error_messages["']: \{/, pages = /case ["']get_messages["']: \{/;
    expect(source).toMatch(marker);
    expect(source).toMatch(pages);
    const body = source.replace(marker, match => `${match} window.__dismissCalls = (window.__dismissCalls || []).concat([args]); if (window.__dismissHang) await new Promise(() => {}); if (window.__dismissFail) throw new Error('disk full');`)
      .replace(pages, match => `${match} window.__pageLoads = (window.__pageLoads || 0) + 1; if (window.__messagesFail) throw new Error('offline');`)
      + `\nmessages[${JSON.stringify(SESSION)}] = ${JSON.stringify(fixture)};\n${extra}\nif (window.__remoteSession) sessions = sessions.map(task => task.id === ${JSON.stringify(SESSION)} ? { ...task, remoteDevice: { id: 'dev-studio', name: 'Studio iMac' } } : task);\nwindow.__previewMessages = messages;\nwindow.__pandacodePreviewUrl = import.meta.url;\n`;
    await route.fulfill({ response, body });
  });
  await page.clock.install({ time: BOOT });
  await page.goto(url);
  await expect(page.locator('.task-item').first()).toBeVisible({ timeout: 30_000 });
  await pauseClock(page, PAUSED_AT);
  await selectThread(page);
  return errors;
}
async function selectThread(page: Page, title = 'Explore the project'): Promise<void> {
  await page.locator('.task-item', { hasText: title }).first().click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText(title);
}
const dismissCalls = (page: Page) => page.evaluate(() => (window as any).__dismissCalls ?? []);
const pageLoads = (page: Page): Promise<number> => page.evaluate(() => (window as any).__pageLoads ?? 0);
const savedIds = (page: Page): Promise<number[]> => page.evaluate(sessionId => (window as any).__previewMessages[sessionId].map((message: { id: number }) => message.id), SESSION);
const liveRows = (page: Page) => page.locator('#stream-region .live-errors .message-error[data-error-key]');
/** A live error saved first, as the backend does: its row joins the thread and the event carries its id (preview
 * `__previewError`); `saved: false` is an event the backend could not save. Returns the saved id. */
const liveError = (page: Page, text: string, saved = true, sessionId = SESSION): Promise<number | undefined> => page.evaluate(([sessionId, text, saved]) => (window as any).__previewError(sessionId, text, { saved }), [sessionId, text, saved] as const);
const closeToast = (page: Page) => page.locator('#toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
const emit = (page: Page, kind: string, text = '') => page.evaluate(([kind, text, sessionId]) => (window as any).__previewEmit('agent-event', { sessionId, kind, text }), [kind, text, SESSION]);

const repeated = (count: number): Seed[] => [
  { role: 'user', content: 'Check the build' },
  ...Array.from({ length: count }, () => ({ role: 'error', content: ENOTFOUND })),
];

test.describe('thread errors', () => {
  // Cold page loads take several seconds on a busy machine, and these flows have many steps.
  test.describe.configure({ timeout: 60_000 });
  test('identical saved errors are one row with a count', async ({ page }) => {
    const errors = await open(page, repeated(7));
    await expect(rows(page)).toHaveCount(1);
    const row = rows(page).first();
    await expect(row.locator('.error-row-summary')).toHaveText(ENOTFOUND);
    await expect(row.locator('.error-row-count')).toContainText('×7');
    await expect(row.locator('.error-row-count .sr-only')).toHaveText('Repeated 7 times');
    // A one-line error has nothing more to show, so no disclosure.
    await expect(row.locator('.error-row-toggle')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Dismiss error', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('error-only turns with no prompt between them collapse into one row', async ({ page }) => {
    await open(page, [
      { role: 'user', content: 'Check the build' },
      { role: 'error', content: ENOTFOUND },
      { role: 'changes', content: '' },
      { role: 'error', content: ENOTFOUND },
      { role: 'changes', content: '' },
      { role: 'error', content: ENOTFOUND },
    ]);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-count')).toContainText('×3');
  });

  test('a long error expands and collapses its full text', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Build it' }, { role: 'error', content: LONG }]);
    const row = rows(page).first();
    const summary = row.locator('.error-row-summary');
    await expect(summary).toHaveText('Build failed in 3 packages');
    const toggle = row.getByRole('button', { name: 'Error details', exact: true }), detail = row.locator('.error-row-detail');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await toggle.getAttribute('aria-controls')).toBe(await detail.getAttribute('id'));
    // Both row buttons are described by the error they act on.
    const summaryId = await summary.getAttribute('id');
    expect(summaryId).toBeTruthy();
    await expect(toggle).toHaveAttribute('aria-describedby', summaryId!);
    await expect(row.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveAttribute('aria-describedby', summaryId!);
    await expect(row.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveAccessibleDescription('Build failed in 3 packages');
    // The detail is a region named by the row's summary (no label of its own), and its ids name the session and scope.
    await expect(detail).toHaveAttribute('role', 'region');
    expect(await detail.getAttribute('aria-labelledby')).toBe(await summary.getAttribute('id'));
    await expect(detail).not.toHaveAttribute('aria-label', /.*/);
    expect(await detail.getAttribute('id')).toContain(SESSION.replace(/[^\w-]/g, '_'));
    await expect(detail).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('at packages/ui: exit 1');
    // The summary line is not shown a second time.
    await expect(detail).not.toContainText('Build failed in 3 packages');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(detail).toBeHidden();
  });

  test('dismissing hides at once, deletes once the thread is left, and stays gone after reopening', async ({ page }) => {
    await open(page, repeated(7));
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(transcript(page).locator('.thread-errors')).toHaveCount(0);
    await expect(transcript(page).locator('.turn-card-errors')).toHaveCount(0);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(page.locator('#toast .toast-text')).toHaveText('Error dismissed');
    await expect(page.locator('#toast').getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    // Nothing is deleted while Undo is offered; switching threads commits the dismissal.
    expect(await dismissCalls(page)).toEqual([]);
    await selectThread(page, 'Add keyboard shortcuts');
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302, 303, 304, 305, 306, 307] }]);
    await expect(page.locator('#toast')).toBeHidden();
    await selectThread(page);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test('the Undo window passing commits the dismissal', async ({ page }) => {
    await open(page, repeated(2));
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.locator('#toast .toast-text')).toHaveText('Error dismissed');
    await page.clock.fastForward(4_000);
    expect(await dismissCalls(page)).toEqual([]);
    await page.clock.fastForward(1_500);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    await expect(page.locator('#toast')).toBeHidden();
  });

  test('Undo brings the rows back where they were, focused, and nothing is deleted', async ({ page }) => {
    await open(page, [...repeated(3), { role: 'error', content: LONG }]);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first().locator('.error-row-count')).toContainText('×3');
    await expect(rows(page).nth(1).locator('.error-row-summary')).toHaveText('Build failed in 3 packages');
    await expect(rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true })).toBeFocused();
    await expect(page.locator('#toast')).toBeHidden();
    // Past the Undo window: still nothing to delete.
    await page.clock.fastForward(6_000);
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('⌘Z undoes a dismissal; closing the toast commits it; a second dismissal commits the first', async ({ page }) => {
    await open(page, [...repeated(2), { role: 'error', content: LONG }, { role: 'error', content: 'Third thing broke' }]);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    // Focus moved to the next row's dismiss (not a text field), so ⌘Z reaches the toast.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows(page)).toHaveCount(3);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await rows(page).filter({ hasText: 'Build failed' }).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    await page.locator('#toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }, { sessionId: SESSION, ids: [303] }]);
    await expect(rows(page)).toHaveCount(1);
  });

  test('notices arriving during a dismissal\'s Undo wait for it to settle; a second dismissal still replaces it', async ({ page }) => {
    await open(page, [...repeated(2), { role: 'error', content: LONG }]);
    const text = page.locator('#toast .toast-text');
    const bot = (message: string) => page.evaluate(message => (window as any).__previewEmit('bot-notification', { botId: 'b', text: message }), message);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(text).toHaveText('Error dismissed');
    await bot('Bot reply sent');
    await bot('Bot reply sent');
    await page.evaluate(() => { void Promise.reject('Disk is full'); });
    // The Undo stays offered and nothing is deleted while it is.
    await expect(text).toHaveText('Error dismissed');
    await expect(page.locator('#toast').getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    expect(await dismissCalls(page)).toEqual([]);
    // A second dismissal replaces it, committing the first; the waiting notices stay queued behind the new one.
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    await expect(text).toHaveText('Error dismissed');
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }, { sessionId: SESSION, ids: [303] }]);
    // Then the waiting notices, once each, in order.
    await expect(text).toHaveText('Bot reply sent');
    await expect(page.locator('#toast .toast-count')).toHaveCount(0);
    await closeToast(page);
    await expect(text).toHaveText('Disk is full');
    await expect(page.locator('#toast .toast-icon[data-state-tone="danger"]')).toHaveCount(1);
    await closeToast(page);
    await expect(page.locator('#toast')).toBeHidden();
  });

  test('a burst of notices behind an Undo toast never drops an approval request', async ({ page }) => {
    await open(page, [...repeated(2)]);
    const text = page.locator('#toast .toast-text');
    await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-3', kind: 'status', text: 'Working' }));
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(text).toHaveText('Error dismissed');
    await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-3', kind: 'approval', requestId: 'r-1', text: 'Run the migration?' }));
    for (let index = 0; index < 5; index++) await page.evaluate(message => (window as any).__previewEmit('bot-notification', { botId: 'b', text: message }), `Bot reply ${index}`);
    await closeToast(page);
    const shown: string[] = [];
    for (let index = 0; index < 4; index++) {
      await expect(page.locator('#toast')).toBeVisible();
      shown.push((await text.textContent())!.replace(/×\d+.*$/, ''));
      await closeToast(page);
    }
    expect(shown[0]).toMatch(/needs approval$/);
    // The two oldest bot replies overflowed the queue and were dropped; the approval request never is.
    expect(shown.slice(1)).toEqual(['Bot reply 2', 'Bot reply 3', 'Bot reply 4']);
    await expect(page.locator('#toast')).toBeHidden();
  });

  test('a live error toast shows the bounded summary and a bounded title', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    await emit(page, 'status', 'Working');
    await selectThread(page, 'Add keyboard shortcuts');
    const huge = `Build exploded\n${'x'.repeat(8000)}`;
    await emit(page, 'error', huge);
    await expect(page.locator('#toast .toast-text')).toHaveText('Build exploded');
    expect((await page.locator('#toast .toast-text').getAttribute('title'))!.length).toBeLessThanOrEqual(500);
  });

  test('a failed dismissal brings the row back and says so', async ({ page }) => {
    await open(page, repeated(2));
    await page.evaluate(() => { (window as any).__dismissFail = true; });
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await page.locator('#toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(page.locator('#toast')).toContainText("Couldn't dismiss the error");
    await expect(page.locator('#toast .toast-icon[data-state-tone="danger"]')).toHaveCount(1);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-count')).toContainText('×2');
  });

  test('dismissing a turn\'s only error keeps its card and header, also when error-only turns were folded into it', async ({ page }) => {
    await open(page, [
      { role: 'user', content: 'Check the build' },
      { role: 'error', content: ENOTFOUND },
      { role: 'changes', content: '' },
      { role: 'error', content: ENOTFOUND },
      { role: 'user', content: 'Try again' },
      { role: 'error', content: 'Second failure' },
    ]);
    const cards = transcript(page).locator('.turn-card');
    await expect(cards).toHaveCount(2);
    const first = cards.first();
    await expect(first.locator('.turn-activity-label')).toHaveText('Stopped');
    await first.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    // The card and its header stay; only the error box goes, leaving no empty box behind.
    await expect(cards).toHaveCount(2);
    await expect(first.locator('.turn-card-head .turn-activity-label')).toHaveText('Stopped');
    await expect(first.locator('.thread-errors')).toHaveCount(0);
    await expect(transcript(page).locator('.thread-errors:empty, .turn-card:not(:has(.turn-card-head, .turn-activity))')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
  });

  test('an emptied card says how many errors were dismissed, quietly, and only where errors were', async ({ page }) => {
    await open(page, [
      { role: 'user', content: 'Check the build' },
      { role: 'error', content: ENOTFOUND },
      { role: 'changes', content: '' },
      { role: 'error', content: ENOTFOUND },
      { role: 'user', content: 'Try again' },
      { role: 'error', content: 'Second failure' },
      { role: 'user', content: 'Explain' },
      { role: 'assistant', content: 'All fine.' },
    ]);
    const cards = transcript(page).locator('.turn-card'), note = transcript(page).locator('.errors-dismissed-note');
    await expect(note).toHaveCount(0);
    await cards.first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(cards.first().locator('.errors-dismissed-note')).toHaveText('2 errors dismissed');
    await expect(note).toHaveCount(1);
    // Not a live region and not interactive; muted text.
    await expect(note).not.toHaveAttribute('role', /.+/);
    await expect(note).not.toHaveAttribute('aria-live', /.+/);
    await expect(note.locator('button, a, [tabindex]')).toHaveCount(0);
    const [color, faint] = await note.evaluate(node => [getComputedStyle(node).color, (() => { const probe = document.createElement('span'); probe.style.color = 'var(--faint)'; node.parentElement!.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; })()]);
    expect(color).toBe(faint);
    // It outlives the toast (for this app session), and Undo takes it away with the rows' return.
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(note).toHaveCount(0);
    await cards.nth(1).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await closeToast(page);
    await expect(cards.nth(1).locator('.errors-dismissed-note')).toHaveText('1 error dismissed');
    await expect(note).toHaveCount(1);
  });

  const labels = (page: Page) => transcript(page).locator('.turn-card .turn-activity-label').allTextContents();
  const labelSeed: Seed[] = [
    { role: 'user', content: 'Run it' },
    { role: 'error', content: 'boom' },
    { role: 'user', content: 'Second' },
    { role: 'status', content: 'Working' },
    { role: 'user', content: 'Third' },
  ];

  test('dismissing an error leaves the turns that had none as they were', async ({ page }) => {
    await open(page, labelSeed);
    const cards = transcript(page).locator('.turn-card');
    await expect(rows(page)).toHaveCount(1);
    const before = await labels(page), count = await cards.count();
    expect(before[0]).toBe('Stopped');
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(cards).toHaveCount(count);
    expect(await labels(page)).toEqual(before);
  });

  test('a dismissal in one thread never changes how another thread draws', async ({ page }) => {
    const other = 'session-3';
    await open(page, repeated(2), { [other]: labelSeed.filter(entry => entry.role !== 'error') });
    await selectThread(page, 'Add keyboard shortcuts');
    const cards = transcript(page).locator('.turn-card');
    await expect(transcript(page).getByText('Third', { exact: true })).toBeVisible();
    const before = await labels(page), count = await cards.count();
    await selectThread(page);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await selectThread(page, 'Add keyboard shortcuts');
    await expect(transcript(page).getByText('Third', { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(count);
    expect(await labels(page)).toEqual(before);
    expect(before).not.toContain('Stopped');
  });

  test('in a thread that runs on another computer, dismissing hides the copy and never deletes it', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__remoteSession = true; });
    await open(page, repeated(2));
    await expect(page.locator('.task-item.selected .task-remote')).toHaveCount(1);
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await closeToast(page);
    await selectThread(page, 'Add keyboard shortcuts');
    await selectThread(page);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('in a remote thread, a dismissed live error stays hidden when the run\'s copies arrive; Undo shows it again', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__remoteSession = true; });
    await open(page, [{ role: 'user', content: 'Check the build' }, { role: 'error', content: 'Old failure' }]);
    await emit(page, 'status', 'Working');
    // Relayed events carry no saved id (mirror.rs strips the host's).
    await liveError(page, ENOTFOUND, false);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(0);
    // The run ends and its rows are copied with new local ids; the thread reloads.
    await page.evaluate(([sessionId, text]) => {
      (window as any).__previewMessages[sessionId].push({ id: 900, sessionId, role: 'error', content: text, createdAt: Date.now() }, { id: 901, sessionId, role: 'error', content: 'Another failure', createdAt: Date.now() });
    }, [SESSION, ENOTFOUND] as const);
    const loads = await pageLoads(page);
    await emit(page, 'done');
    await expect.poll(() => pageLoads(page)).toBeGreaterThan(loads);
    await expect(rows(page).filter({ hasText: 'Another failure' })).toHaveCount(1);
    await expect(rows(page).filter({ hasText: 'Old failure' })).toHaveCount(1);
    await expect(rows(page).filter({ hasText: ENOTFOUND })).toHaveCount(0);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(rows(page).filter({ hasText: ENOTFOUND })).toHaveCount(1);
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('a bot thread\'s error dismissed while it runs is hidden and never deleted (its failover reads it)', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }], {}, '/?bots=sample');
    const bar = page.locator('.sidebar-bots-bar');
    if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
    await page.getByRole('region', { name: 'Bots', exact: true }).getByRole('button', { name: /^Chat with Ledger/ }).click();
    await expect(page.locator('#breadcrumb .bot-crumb')).toContainText('Ledger');
    const sessionId = (await page.locator('#prompt').getAttribute('data-session-id'))!;
    await page.evaluate(sessionId => (window as any).__previewEmit('agent-event', { sessionId, kind: 'status', text: 'Working' }), sessionId);
    const id = await liveError(page, ENOTFOUND, true, sessionId);
    const live = page.locator('#stream-region .live-errors .message-error[data-error-key]');
    await live.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(live).toHaveCount(0);
    await closeToast(page);
    await page.clock.runFor(6_000);
    expect(await dismissCalls(page)).toEqual([]);
    expect(await page.evaluate(([sessionId]) => (window as any).__previewMessages[sessionId].map((m: { id: number }) => m.id), [sessionId])).toContain(id);
  });

  test('a toast with keyboard focus stays; it leaves once focus does, and focus never drops to <body>', async ({ page }) => {
    await open(page, [...repeated(2), { role: 'error', content: LONG }]);
    const toast = page.locator('#toast'), undo = toast.getByRole('button', { name: 'Undo', exact: true }), close = toast.getByRole('button', { name: 'Dismiss', exact: true });
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    const next = rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true });
    await expect(next).toBeFocused();
    await undo.focus();
    await page.clock.runFor(10_000);
    await expect(toast).toBeVisible();
    await expect(undo).toBeFocused();
    expect(await dismissCalls(page)).toEqual([]);
    // Closed from the keyboard: focus goes back to the control the dismissal left it on.
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(toast).toBeHidden();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    await expect(next).toBeFocused();
    // The last row: the dismissal leaves focus on the composer. Focus in the toast keeps it; once focus leaves, it goes.
    await next.click();
    await close.focus();
    await page.clock.runFor(10_000);
    await expect(toast).toBeVisible();
    expect(await dismissCalls(page)).toHaveLength(1);
    await page.locator('#prompt').focus();
    await page.clock.runFor(1_500);
    await expect(toast).toBeHidden();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }, { sessionId: SESSION, ids: [303] }]);
    // Expiring while focused is impossible now, but a replacement is not: focus in the old toast is moved, not dropped.
    await page.evaluate(() => (window as any).__previewEmit('bot-notification', { botId: 'b', text: 'First' }));
    await close.focus();
    await page.evaluate(() => (window as any).__previewEmit('bot-notification', { botId: 'b', text: 'Second' }));
    await expect(toast.locator('.toast-text')).toHaveText('Second');
    expect(await page.evaluate(() => document.activeElement === document.body || !document.activeElement)).toBe(false);
    await expect(close).not.toBeFocused();
  });

  test('Dismiss all removes every group of a turn', async ({ page }) => {
    await open(page, [...repeated(3), { role: 'error', content: LONG }]);
    await expect(rows(page)).toHaveCount(2);
    await transcript(page).getByRole('button', { name: 'Dismiss all', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(transcript(page).locator('.thread-errors')).toHaveCount(0);
    await expect(page.locator('#toast .toast-text')).toHaveText('2 errors dismissed');
    await page.locator('#toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect.poll(async () => (await dismissCalls(page)).flatMap((call: { ids: number[] }) => call.ids).sort()).toEqual([301, 302, 303, 304]);
  });

  test('keyboard: Tab reaches the buttons, Enter and Space operate them', async ({ page, browserName }) => {
    // WebKit on macOS skips buttons on a plain Tab (Safari's default); Alt+Tab walks every control.
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await open(page, [...repeated(2), { role: 'error', content: LONG }]);
    const long = rows(page).filter({ hasText: 'Build failed' }), toggle = long.getByRole('button', { name: 'Error details', exact: true });
    const first = rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true });
    await first.focus();
    await page.keyboard.press(tab);
    await expect(toggle).toBeFocused();
    const ring = await toggle.evaluate(node => getComputedStyle(node).outlineStyle);
    expect(ring).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press(' ');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press(tab);
    const dismiss = long.getByRole('button', { name: 'Dismiss error', exact: true });
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(1);
    // Focus moves to the row that is left, so the keyboard keeps its place.
    await expect(first).toBeFocused();
    await page.keyboard.press(' ');
    await expect(rows(page)).toHaveCount(0);  // The last error is gone: focus continues from the composer, never from <body>.
    await expect(page.locator('#prompt')).toBeFocused();
  });

  /** Counts toasts shown from now on (window.__toasts). */
  const countToasts = (page: Page) => page.evaluate(() => {
    (window as any).__toasts = 0;
    new MutationObserver(() => { (window as any).__toasts++; }).observe(document.querySelector('#toast')!, { childList: true });
  });
  const toasts = (page: Page): Promise<number> => page.evaluate(() => (window as any).__toasts);

  test('identical live errors in the thread on screen are one row and no toast; a dismissed one stays gone once saved', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    expect(await page.evaluate(() => document.hasFocus() && !document.hidden)).toBe(true);
    await countToasts(page);
    // What the polite live region says (no toast, and the transcript itself is aria-live=off).
    await page.evaluate(() => {
      const region = document.querySelector('#composer-live')!; (window as any).__said = [];
      new MutationObserver(() => { if (region.textContent) (window as any).__said.push(region.textContent); }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    const ids: number[] = [];
    for (let index = 0; index < 4; index++) ids.push((await liveError(page, ENOTFOUND))!);
    await expect(page.locator('#composer-live')).toHaveText(ENOTFOUND);
    await expect(page.locator('#composer-live')).toHaveAttribute('aria-live', 'polite');
    // Throttled by shouldAnnounce: four identical events are said once.
    expect(await page.evaluate(() => (window as any).__said)).toEqual([ENOTFOUND]);
    const live = page.locator('#stream-region .live-errors .message-error');
    await expect(live).toHaveCount(1);
    await expect(live.locator('.error-row-count')).toContainText('×4');
    await expect(live.locator('.error-row-summary')).toHaveText(ENOTFOUND);
    // The inline row already shows it to the reader: no toast repeats it.
    expect(await toasts(page)).toBe(0);
    await live.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(live).toHaveCount(0);
    // The events' saved rows (their ids came with them) are deleted as soon as the Undo toast settles, mid-run.
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    expect(await dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
  });

  test('identical live errors in a background thread raise one toast', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    await emit(page, 'status', 'Working');
    await selectThread(page, 'Add keyboard shortcuts');
    await countToasts(page);
    for (let index = 0; index < 3; index++) await emit(page, 'error', ENOTFOUND);
    await expect(page.locator('#toast .toast-text')).toHaveText(ENOTFOUND);
    await expect(page.locator('#toast .toast-icon[data-state-tone="danger"]')).toHaveCount(1);
    expect(await toasts(page)).toBe(1);
  });

  test('the same live error in two background threads is told for each', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    const event = (sessionId: string, kind: string, text = '') => page.evaluate(([sessionId, kind, text]) => (window as any).__previewEmit('agent-event', { sessionId, kind, text }), [sessionId, kind, text]);
    for (const other of ['session-3', 'session-1']) await event(other, 'status', 'Working');
    await event('session-3', 'error', ENOTFOUND);
    await expect(page.locator('#toast .toast-text')).toContainText(ENOTFOUND);
    await event('session-1', 'error', ENOTFOUND);
    await expect(page.locator('#toast .toast-count')).toHaveText('×2');
  });

  test('a new live error in the thread on screen never takes away the Undo of a dismissal', async ({ page }) => {
    await open(page, [...repeated(2)]);
    // The window is not focused, so live errors would toast; the Undo toast still stays.
    await page.evaluate(() => { document.hasFocus = () => false; });
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.locator('#toast .toast-text')).toHaveText('Error dismissed');
    await emit(page, 'error', 'Connection reset');
    await emit(page, 'error', 'Connection reset');
    await expect(page.locator('#stream-region .live-errors .message-error')).toHaveCount(1);
    await expect(page.locator('#toast .toast-text')).toHaveText('Error dismissed');
    await expect(page.locator('#toast').getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('dismiss live, the same error repeats: only the dismissed rows are deleted, across a turn boundary', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    const ids: number[] = [];
    for (let index = 0; index < 3; index++) ids.push((await liveError(page, ENOTFOUND))!);
    const live = page.locator('#stream-region .live-errors .message-error');
    await live.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
    // The run moves to a next turn; its saved page loads without the deleted rows.
    await page.evaluate(([sessionId, CHANGES]) => {
      (window as any).__previewMessages[sessionId].push({ id: 5000, sessionId, role: 'changes', content: '', createdAt: Date.now(), turnChanges: CHANGES });
    }, [SESSION, CHANGES] as const);
    await page.evaluate(([sessionId, turnChanges]) => (window as any).__previewEmit('agent-event', { sessionId, kind: 'turn_changes', text: '', data: { turnChanges } }), [SESSION, CHANGES] as const);
    const loads = await pageLoads(page);
    await emit(page, 'status', 'Working');
    await expect.poll(() => pageLoads(page)).toBeGreaterThan(loads);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    // The same error comes back after the dismissal: it shows, alone, and is never deleted.
    const repeat = await liveError(page, ENOTFOUND);
    await expect(live).toHaveCount(1);
    await expect(live.locator('.error-row-count')).toHaveCount(0);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-count')).toHaveCount(0);
    expect(await dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
    expect(await savedIds(page)).toContain(repeat);
  });

  test('a live error dismissed and then left is deleted by id while its run goes on', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    const ids: number[] = [];
    for (let index = 0; index < 3; index++) ids.push((await liveError(page, ENOTFOUND))!);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(0);
    // Leaving commits the dismissal; the rows exist already, so they go now.
    await selectThread(page, 'Add keyboard shortcuts');
    await expect(page.locator('#toast')).toBeHidden();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
    await emit(page, 'done');
    await selectThread(page);
    await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test('a run that ends during the Undo window keeps the rows hidden and deletes them when the reader switches thread', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    const ids = [(await liveError(page, ENOTFOUND))!, (await liveError(page, ENOTFOUND))!];
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    // The saved copies are hidden while Undo is offered, and not deleted yet.
    await expect(rows(page)).toHaveCount(0);
    expect(await dismissCalls(page)).toEqual([]);
    await selectThread(page, 'Add keyboard shortcuts');
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
    await selectThread(page);
    await expect(rows(page)).toHaveCount(0);
  });

  test('Undo of a live dismissal brings back the live row and its saved rows, and deletes nothing', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    await liveError(page, ENOTFOUND);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(0);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(1);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('Undo of a live dismissal after the same error repeated merges into one row that carries every saved id', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    const ids = [(await liveError(page, ENOTFOUND))!, (await liveError(page, ENOTFOUND))!];
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(0);
    // The same error arrives during the Undo window: a new row, since the dismissed one stays dismissed.
    ids.push((await liveError(page, ENOTFOUND))!);
    await expect(liveRows(page)).toHaveCount(1);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(1);
    await expect(liveRows(page).locator('.error-row-count')).toContainText('×3');
    // Dismissing the merged row deletes all three saved rows.
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(0);
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids }]);
  });

  test('Undo after the run saved its rows shows one row with the summed count', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    await liveError(page, ENOTFOUND); await liveError(page, ENOTFOUND);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await liveError(page, ENOTFOUND);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-count')).toHaveCount(0);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-count')).toContainText('×3');
    expect(await dismissCalls(page)).toEqual([]);
  });

  test('dismissing an error the backend never saved deletes no saved row', async ({ page }) => {
    const text = 'Could not save this conversation: disk full';
    // An older turn has a saved error with the same text: it is not the one dismissed.
    await open(page, [{ role: 'user', content: 'Check the build' }, { role: 'error', content: text }, { role: 'user', content: 'Try again' }]);
    await liveError(page, text, false);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await closeToast(page);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    expect(await dismissCalls(page)).toEqual([]);
    expect(await savedIds(page)).toContain(301);
  });

  test('the Retry row for a failed saved page is announced once, not again when the live rows change', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    await emit(page, 'error', ENOTFOUND);
    await emit(page, 'error', 'Second live failure');
    await page.evaluate(() => { (window as any).__messagesFail = true; });
    await emit(page, 'done');
    const retry = page.locator('#stream-region .live-retry');
    await expect(retry).toContainText("Couldn't load the saved response");
    await expect(retry).toHaveAttribute('role', 'alert');
    await liveRows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(liveRows(page)).toHaveCount(1);
    await expect(retry).toHaveCount(1);
    await expect(retry).toContainText("Couldn't load the saved response");
    await expect(retry).not.toHaveAttribute('role', 'alert');
    await expect(retry.getByRole('button', { name: 'Retry loading response', exact: true })).toBeVisible();
  });

  test('a long detail is keyboard-scrollable and the row icon carries the danger tone', async ({ page, browserName }) => {
    const tall = ['Build failed', ...Array.from({ length: 60 }, (_, index) => `  at step ${index}`)].join('\n');
    await open(page, [{ role: 'user', content: 'Build it' }, { role: 'error', content: tall }]);
    const row = rows(page).first();
    await row.getByRole('button', { name: 'Error details', exact: true }).click();
    const detail = row.locator('.error-row-detail');
    await expect(detail).toHaveAttribute('tabindex', '0');
    await expect(detail).toHaveAttribute('role', 'region');
    // Reached by the keyboard (the focus ring is :focus-visible); WebKit walks every control with Alt+Tab.
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (let step = 0; step < 3 && !(await detail.evaluate(node => node === document.activeElement)); step++) await page.keyboard.press(tab);
    await expect(detail).toBeFocused();
    expect(await detail.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await page.keyboard.press('PageDown');
    await expect.poll(() => detail.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    const tone = row.locator('.error-row-icon[data-state-tone="danger"]');
    await expect(tone).toHaveCount(1);
    const [icon, danger] = await tone.evaluate(node => {
      const probe = document.createElement('span'); probe.style.color = 'var(--ds-danger)'; node.parentElement!.append(probe);
      const colors = [getComputedStyle(node).color, getComputedStyle(probe).color]; probe.remove(); return colors;
    });
    expect(icon).toBe(danger);
  });

  test('a live error left open stays open when its card is saved', async ({ page }) => {
    await open(page, [{ role: 'user', content: 'Build it' }]);
    await liveError(page, LONG);
    const toggle = page.locator('#stream-region .live-errors').getByRole('button', { name: 'Error details', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    const saved = rows(page).filter({ hasText: 'Build failed' });
    await expect(saved.getByRole('button', { name: 'Error details', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(saved.locator('.error-row-detail')).toBeVisible();
  });

  test('in a run of more than 100 saved rows, dismissing a live error never touches an older identical error', async ({ page }) => {
    // An earlier turn failed the same way (row 301); this run's prompt is row 302.
    await open(page, [{ role: 'user', content: 'Check the build' }, { role: 'error', content: ENOTFOUND }, { role: 'user', content: 'Try again' }]);
    const liveId = (await liveError(page, ENOTFOUND))!;
    await page.evaluate(([sessionId]) => {
      const list = (window as any).__previewMessages[sessionId];
      for (let index = 0; index < 150; index++) list.push({ id: 6000 + index, sessionId, role: 'tool', content: `Ran step ${index}`, createdAt: Date.now() });
    }, [SESSION]);
    // Back in the thread, its latest page (100 rows) holds neither the prompt nor any error.
    await selectThread(page, 'Add keyboard shortcuts');
    await selectThread(page);
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(1);
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [liveId] }]);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    const saved = await savedIds(page);
    expect(saved).toContain(301);
    expect(saved).not.toContain(liveId);
    expect(await dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [liveId] }]);
    // Scrolling up reaches the older turn: its error is still there.
    await expect(async () => {
      await transcript(page).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
      await expect(transcript(page).getByText('Check the build', { exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(1);
  });

  test('a live dismissal and a saved-row dismissal each delete exactly their own rows', async ({ page }) => {
    // The saved errors are in an earlier turn, so they stay on screen while the next prompt's run goes on.
    await open(page, [...repeated(2), { role: 'user', content: 'Try again' }]);
    const liveId = (await liveError(page, 'Live failure'))!;
    await liveRows(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
    // A saved row is dismissed next: replacing the first Undo toast commits the live dismissal.
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [liveId] }]);
    await emit(page, 'done');
    await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
    await closeToast(page);
    await expect.poll(async () => (await dismissCalls(page)).flatMap((call: { ids: number[] }) => call.ids).sort()).toEqual([301, 302, liveId].sort());
  });

  test('a live error dismissed in the By the way panel deletes exactly that row of the side thread', async ({ page }) => {
    const sideId = 'session-3';
    await page.addInitScript(([mainId, sideId]) => localStorage.setItem('pandacode.btw', JSON.stringify({ [mainId]: { sideId, seenId: 0 } })), [SESSION, sideId]);
    await open(page, [{ role: 'user', content: 'Check the build' }]);
    // The side thread failed the same way in an earlier turn.
    await page.evaluate(([sideId, content]) => {
      const list = ((window as any).__previewMessages[sideId] ??= []);
      list.push({ id: 7000, sessionId: sideId, role: 'user', content: 'Side question', createdAt: Date.now() }, { id: 7001, sessionId: sideId, role: 'error', content, createdAt: Date.now() }, { id: 7002, sessionId: sideId, role: 'user', content: 'Side again', createdAt: Date.now() });
    }, [sideId, ENOTFOUND] as const);
    await openInspectorTab(page, 'By the way');
    const side = page.getByRole('log', { name: 'Side thread conversation', exact: true });
    await expect(side.getByText('Side again', { exact: true })).toBeVisible();
    const dismissed = (await liveError(page, ENOTFOUND, true, sideId))!;
    const live = side.locator('.live-errors .message-error[data-error-key]');
    await expect(live).toHaveCount(1);
    await live.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(live).toHaveCount(0);
    await closeToast(page);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: sideId, ids: [dismissed] }]);
    const repeat = await liveError(page, ENOTFOUND, true, sideId);
    await expect(live).toHaveCount(1);
    await page.evaluate(sideId => (window as any).__previewEmit('agent-event', { sessionId: sideId, kind: 'done', text: '' }), sideId);
    await expect(side.locator('.message-error[data-error-key]')).toHaveCount(2);
    const left = await page.evaluate(sideId => (window as any).__previewMessages[sideId].map((message: { id: number }) => message.id), sideId);
    expect(left).toEqual(expect.arrayContaining([7001, repeat]));
    expect(left).not.toContain(dismissed);
    expect(await dismissCalls(page)).toEqual([{ sessionId: sideId, ids: [dismissed] }]);
    // Chat rows: dismissing a saved turn's only error drops just that row; its prompt stays.
    await side.locator('.message-error[data-error-key]').first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(side.locator('.message-error[data-error-key]')).toHaveCount(1);
    await expect(side.getByText('Side question', { exact: true })).toBeVisible();
    await expect(side.locator('.thread-errors:empty')).toHaveCount(0);
    // The same quiet note as in a card stands where the error was.
    await expect(side.locator('.errors-dismissed-note')).toHaveText(['1 error dismissed']);
  });

  test('a dismissal still deleting when the app quits is finished at the next launch', async ({ page }) => {
    await open(page, [...repeated(2), { role: 'error', content: LONG }]);
    await page.evaluate(() => { (window as any).__dismissHang = true; });
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await page.locator('#toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    // The delete never answers; the page goes away (a quit) and comes back with the rows still saved.
    await page.clock.resume();
    await page.reload();
    await expect(page.locator('.task-item').first()).toBeVisible({ timeout: 30_000 });
    await pauseClock(page, PAUSED_AT + 10 * 60_000);
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302] }]);
    await selectThread(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).locator('.error-row-summary')).toHaveText('Build failed in 3 packages');
  });

  test('a thread tile redraws its errors when a dismissal commits or a failed delete restores them', async ({ page }) => {
    // Two tiles, two dismissals and their commits: longer than the default timeout on a loaded machine.
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, [...repeated(4), { role: 'error', content: LONG }]);
    const other = page.locator('#navigation .task-item', { hasText: 'Add keyboard shortcuts' }).first();
    await other.click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    const mirror = page.locator(`.thread-tile[data-tile="${SESSION}"] .thread-mirror`);
    await expect(mirror.locator('.message-error')).toHaveCount(2);
    expect(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(node => node.id); return ids.filter((id, index) => ids.indexOf(id) !== index); })).toEqual([]);
    // Tile rows are read-only: the dismissal happens in the focused pane; moving to the other tile commits it.
    await mirror.click();
    await expect(mirror).toBeHidden();
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    const otherId = await other.getAttribute('data-id');
    const otherMirror = page.locator(`.thread-tile[data-tile="${otherId}"] .thread-mirror`);
    await otherMirror.click();
    await expect(mirror).toBeVisible();
    await expect.poll(() => dismissCalls(page)).toEqual([{ sessionId: SESSION, ids: [301, 302, 303, 304] }]);
    // A tile redraws 250 ms after a change (thread-tiles.ts DRAW_MS), on the paused clock.
    await page.clock.runFor(300);
    await expect(mirror.locator('.message-error')).toHaveCount(1);
    await expect(mirror.locator('.error-row-summary')).toHaveText('Build failed in 3 packages');
    // A failed delete brings the row back in the tile too.
    await mirror.click();
    await expect(mirror).toBeHidden();
    await page.evaluate(() => { (window as any).__dismissFail = true; });
    await rows(page).first().getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(rows(page)).toHaveCount(0);
    await otherMirror.click();
    await expect(page.locator('#toast')).toContainText("Couldn't dismiss the error");
    await page.clock.runFor(300);
    await expect(mirror.locator('.message-error')).toHaveCount(1);
    await expect(mirror.locator('.error-row-summary')).toHaveText('Build failed in 3 packages');
  });

  for (const width of [1280, 860]) {
    test(`error controls stay clear of the action dock at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      // Earlier turns, so the thread scrolls and its error boxes can sit above, beside or below the dock.
      const earlier = Array.from({ length: 6 }, (_, index) => [{ role: 'user', content: `Step ${index}` }, { role: 'assistant', content: `Done with step ${index}.\n\nAll good.` }]).flat();
      await open(page, [...earlier, ...repeated(3), { role: 'error', content: LONG }]);
      await emit(page, 'error', ENOTFOUND);
      await emit(page, 'error', 'Second live failure');
      const controls = page.locator('.message-error .error-row-button, .error-dismiss-all');
      await expect(controls.first()).toBeVisible();
      const misses = () => controls.evaluateAll(nodes => nodes.flatMap(node => {
        const box = node.getBoundingClientRect();
        if (!box.width) return [];
        // 6px inside each corner: the controls are rounded, and hit testing follows the radius.
        const inset = 6, points = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + inset, box.top + inset], [box.right - inset, box.top + inset], [box.left + inset, box.bottom - inset], [box.right - inset, box.bottom - inset]];
        return points.flatMap(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && (hit === node || node.contains(hit)) ? [] : [`${node.className} at ${Math.round(x)},${Math.round(y)} hit ${hit?.className}`]; });
      }));
      await page.screenshot({ path: test.info().outputPath(`errors-${width}.png`) });
      expect(await misses()).toEqual([]);

      // Inside a turn card the error box runs the card's full width, like its reply; only the controls keep clear.
      const edges = await page.locator('.turn-card:has(.turn-card-errors .message-error)').evaluateAll(cards => cards.map(card => {
        const box = card.querySelector('.turn-card-errors')!.getBoundingClientRect(), reply = card.querySelector('.turn-card-reply')?.getBoundingClientRect();
        return reply ? Math.round(reply.right - box.right) : 0;
      }));
      expect(edges.length).toBeGreaterThan(0);
      expect(edges).toEqual(edges.map(() => 0));

      // Scrolling never reflows a row: the box keeps the same clearance, width and height wherever it sits relative to
      // the dock (a clearance that switched off outside the dock's band re-wrapped rows as they scrolled past it).
      const box = page.locator('#transcript .turn-card-errors').last();
      const geometry = () => box.evaluate(node => {
        const head = node.querySelector('.error-row-head')!, rect = node.getBoundingClientRect();
        return { padding: getComputedStyle(head).paddingRight, width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      await transcript(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
      const atEnd = await geometry();
      expect(atEnd.padding).not.toBe('3px');
      const frames: unknown[] = [];
      for (let step = 0; step < 12; step++) {
        await transcript(page).evaluate(node => { node.scrollTop -= 60; });
        frames.push(await geometry());
      }
      expect(frames).toEqual(frames.map(() => atEnd));
      await transcript(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
      expect(await misses()).toEqual([]);
    });
  }

  test('at 860px a toast lifted above the composer stays clear of the live errors\' controls', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 800 });
    // A long thread, so the live card ends right above the composer, where the lifted toast sits.
    await open(page, Array.from({ length: 12 }, (_, index) => [{ role: 'user', content: `Step ${index}` }, { role: 'assistant', content: `Done with step ${index}.\n\nAll good.` }]).flat());
    for (const text of [ENOTFOUND, 'Second live failure', 'Third live failure']) await emit(page, 'error', text);
    await expect(liveRows(page)).toHaveCount(3);
    await transcript(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
    const covered = () => page.locator('#stream-region .live-errors .error-row-button, #stream-region .live-errors .error-dismiss-all').evaluateAll(nodes => nodes.flatMap(node => {
      const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (!box.width || y < 0 || y > innerHeight) return [];
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === node || node.contains(hit)) ? [] : [`${node.getAttribute('aria-label') ?? node.textContent} at ${Math.round(x)},${Math.round(y)} hit ${hit?.closest('[id]')?.id ?? hit?.className}`];
    }));
    expect(await covered()).toEqual([]);
    // A notice long enough to wrap: the taller toast reaches up past the transcript's bottom space.
    await page.evaluate(() => (window as any).__previewEmit('bot-notification', { botId: 'b', text: 'Release bot: the nightly build for orbit finished and its notes are ready for review in the releases channel' }));
    await expect(page.locator('#toast')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('errors-toast-860.png') });
    expect(await covered()).toEqual([]);
    // A live error arriving while the toast shows moves it clear again.
    await emit(page, 'error', 'Fourth live failure');
    await expect(liveRows(page)).toHaveCount(4);
    await transcript(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect(await covered()).toEqual([]);
  });
});
