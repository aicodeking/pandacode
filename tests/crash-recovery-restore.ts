import { expect, test } from '@playwright/test';
import { type CrashWindow, crashed, leftOver, when, calls, stored, ready, selected, openGeneral, INTERRUPTED, INTERRUPTED_SHORT, RELOADED, PAUSED, pausedLead, NOTHING, RELOADED_AGAIN, STOPPED_BEFORE, resume, deadWindow, noticeReady, held, heldNoOther, heldNotLast, interruptedTasks, OPEN_NAVIGATION } from './crash-recovery-helpers';

/** What a launch restores: drafts, the open thread, and the threads it keeps closed after a crash
 * or a window death. Registered by crash-recovery.spec.ts. */
export function launchRestoreTests(): void {
  test.describe('what a launch restores', () => {
    test('the open thread and its unsent draft come back, and a sent draft does not', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      // The first keystroke of a burst is written at once: a crash right after it loses nothing.
      await page.locator('#prompt').press('h');
      expect(await stored(page, 'pandacode.draft:session-2')).toContain('"text":"h"');
      await page.locator('#prompt').fill('half-written prompt');
      // The rest is written on its own timer, so an abrupt exit (no pagehide) still keeps it.
      await expect.poll(() => stored(page, 'pandacode.draft:session-2')).toContain('half-written prompt');
      await page.reload();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(page.locator('#prompt')).toHaveValue('half-written prompt');
      // Sending removes it from storage at once.
      await page.locator('#prompt').press('Enter');
      await expect.poll(() => stored(page, 'pandacode.draft:session-2')).toBeNull();
    });

    test('text typed into a New task comes back at the next launch and in that project’s New task, until it is sent', async ({ page }) => {
      test.setTimeout(60_000);
      const PROMPT = 'A long first prompt for a new task, typed before the crash';
      const newTaskKeys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.draft:new:')));
      const kept = async () => { const [key] = await newTaskKeys(); return key ? JSON.parse((await stored(page, key)) ?? '{}').text : null; };
      const openNewTask = async () => {
        await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
        await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
      };
      const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
      await page.goto('/');
      await ready(page);
      await openNewTask();
      await prompt.fill(PROMPT);
      // Written on its own timer under the project, since the New task's draft session does not outlive the launch.
      await expect.poll(kept).toBe(PROMPT);
      expect(await newTaskKeys()).toHaveLength(1);
      await page.reload();
      // The New task was open: it opens again with the text.
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible({ timeout: 15_000 });
      await expect(prompt).toHaveValue(PROMPT);
      // From another thread, at a later launch, New task in that project brings it back too.
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await page.reload();
      await expect(selected(page)).toContainText('Refine the navigation', { timeout: 15_000 });
      await openNewTask();
      await expect(prompt).toHaveValue(PROMPT);
      // Sending removes it at once; the next launch's New task starts empty. (The preview keeps no
      // sessions across a reload, so the sent thread is gone and the New task view opens.)
      await prompt.press('Enter');
      await expect.poll(newTaskKeys).toEqual([]);
      await page.reload();
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible({ timeout: 15_000 });
      await expect(prompt).toHaveValue('');
    });

    test('a New task whose first send failed keeps its text under the project, so the next launch brings it back', async ({ page }) => {
      const PROMPT = 'A first prompt whose send failed';
      await page.addInitScript(() => { (window as Window & { __previewSendFails?: number }).__previewSendFails = 1; });
      const newTaskKeys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.draft:')));
      const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
      await page.goto('/');
      await ready(page);
      await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
      await prompt.fill(PROMPT);
      await prompt.press('Enter');
      await expect(page.getByText('The agent could not start.').first()).toBeVisible();
      await expect(prompt).toHaveValue(PROMPT);
      // Kept under the project's New task key, not the draft session's id, which the next launch discards.
      await expect.poll(newTaskKeys).toEqual(['pandacode.draft:new:project-1']);
      expect(JSON.parse((await stored(page, 'pandacode.draft:new:project-1')) ?? '{}').text).toBe(PROMPT);
      await page.reload();
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible({ timeout: 15_000 });
      await expect(prompt).toHaveValue(PROMPT);
    });

    test('clearing a New task’s text removes it from storage', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
      const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
      const keys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.draft:new:')));
      await prompt.fill('soon gone');
      await expect.poll(keys).toHaveLength(1);
      await prompt.fill('');
      await expect.poll(keys).toEqual([]);
    });

    test('after a crash, a thread whose opening may have taken the app down is kept closed, named, and opens on request', async ({ page }) => {
      // The last launch marked "Refine the navigation" as opening and never finished.
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      await expect(selected(page)).not.toContainText('Refine the navigation');
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      const toast = page.locator('#toast');
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted. ${held('Refine the navigation')}Open thread`);
      // The free action slot opens it: the user chose to.
      await toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toBeHidden();
    });

    test('after a crash, the thread open before the held-back one comes back instead of the newest', async ({ page }) => {
      // In "Add keyboard shortcuts", the user opened "Refine the navigation", which loaded and took the app down while painting.
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2', 'pandacode.restoringPrevious': 'session-3' });
      await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      await expect(selected(page)).toContainText('Add keyboard shortcuts');
      await expect(page.locator('#toast')).toHaveText(`PandaCode crashed ${await when(page)} and restarted. ${held('Refine the navigation')}Open thread`);
      await expect.poll(() => stored(page, 'pandacode.restoringPrevious')).toBeNull();
      await expect.poll(() => stored(page, 'pandacode.openThread')).toBe('session-3');
    });

    test('after a real crash with a report, Open thread leads and Show crash report follows as a quieter button', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await interruptedTasks(page, ['session-3']);
      await crashed(page, { summary: 'Panic: boom', hasReport: true, restarted: true, restartsPaused: false, agentsInterrupted: true });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted. ${INTERRUPTED_SHORT} ${held('Refine the navigation')}`);
      // Beside the kept-closed thread the agents line never says to open one.
      await expect(toast).not.toContainText('Open one');
      await expect(toast.getByRole('button')).toHaveText(['Open thread', 'Show crash report', '']);
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toHaveClass('toast-action');
      await expect(toast.getByRole('button', { name: 'Show crash report' })).toHaveClass('toast-secondary');
      // F6 reaches the primary action first.
      await page.locator('#prompt').focus();
      await page.keyboard.press('F6');
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toBeFocused();
      await toast.getByRole('button', { name: 'Show crash report' }).click();
      await expect.poll(async () => (await calls(page, 'crash_report_reveal')).length).toBe(1);
      // Using one action keeps the other: Open thread is still there.
      await page.waitForTimeout(500);
      await expect(toast.getByRole('button')).toHaveText(['Open thread', 'Show crash report', '']);
      await toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      // Opening the thread drops only what was about it: the report stays reachable, unannounced.
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted. ${INTERRUPTED}Show crash report`);
      await expect(toast).toHaveAttribute('aria-live', 'off');
      await toast.getByRole('button', { name: 'Show crash report' }).click();
      await expect.poll(async () => (await calls(page, 'crash_report_reveal')).length).toBe(2);
      await toast.getByRole('button', { name: 'Dismiss' }).click();
      await expect(toast).toBeHidden();
    });

    test('Open thread, next to Show crash report, opens the held-back thread and leaves the report button', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      await expect(selected(page)).not.toContainText('Refine the navigation');
      const toast = page.locator('#toast');
      await toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`);
      await expect(toast.getByRole('button')).toHaveText(['Show crash report', '']);
      // It stays until closed.
      await page.waitForTimeout(1500);
      await expect(toast).toBeVisible();
    });

    test('without a crash, a mark left by quitting during the last launch is cleared and the thread reopens', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await page.goto('/');
      await ready(page);
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      await page.waitForTimeout(500);
      await expect(page.locator('#toast')).toBeHidden();
    });

    test('a window reloaded after its content died keeps the marked thread closed and says why', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      // The reloaded page finds the mark that a dead window (no pagehide) leaves behind.
      await deadWindow(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await ready(page);
      await expect(selected(page)).not.toContainText('Refine the navigation');
      await expect(page.locator('#toast')).toHaveText(`PandaCode's window stopped and was reloaded. ${held('Refine the navigation')}Open thread`);
    });

    test('a window that died once after its thread had loaded reopens it quietly, and a second death holds it back', async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await ready(page);
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect.poll(() => stored(page, 'pandacode.openThread')).toBe('session-2');
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      // No mark: the thread had painted. A single death (macOS ending the content) is usually harmless.
      await deadWindow(page);
      await ready(page);
      await expect(selected(page)).toContainText('Refine the navigation');
      const toast = page.locator('#toast');
      // Everything came back: no toast, only the console hears of it.
      await expect.poll(async () => (await calls(page, 'crash_recovery_take')).length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(1000);
      await expect(toast).toBeHidden();
      expect(await stored(page, 'pandacode.windowDied')).toBe('session-2');
      // It dies again before the page proved stable: now that thread is held back and named.
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      await deadWindow(page);
      await noticeReady(page);
      await expect(toast).toHaveText(`${RELOADED_AGAIN} ${heldNoOther('Refine the navigation')}Open thread`);
      await expect(selected(page)).toHaveCount(0);
      await toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
    });

    test('a window reloaded after its content died with every thread back shows no toast and logs it', async ({ page }) => {
      test.setTimeout(60_000);
      const logged: string[] = [];
      page.on('console', message => { if (message.type() === 'info') logged.push(message.text()); });
      await page.goto('/');
      await ready(page);
      // No thread was open when it died, so none is held back.
      await deadWindow(page, {}, ['pandacode.openThread']);
      await ready(page);
      await expect.poll(() => logged.includes(RELOADED), { timeout: 15_000 }).toBe(true);
      const toast = page.locator('#toast');
      await page.waitForTimeout(1000);
      await expect(toast).toBeHidden();
      // Nor does it come back after the next toast.
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
      await expect(toast).toHaveText('A routine note');
      await expect(toast).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      await expect(toast).toBeHidden();
    });

    test('a window that dies again before it proved stable opens no thread and says so', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      // The first death left its note (no suspect); the page died again with nothing remembered
      // (nor mid-open: ready() does not wait for the transcript to paint and clear its mark).
      await deadWindow(page, { 'pandacode.windowDied': '' }, ['pandacode.openThread', 'pandacode.restoringThread']);
      await noticeReady(page);
      const toast = page.locator('#toast');
      await expect(toast).toHaveText(`${RELOADED_AGAIN} ${NOTHING}`);
      await page.waitForTimeout(1000);
      await expect(selected(page)).toHaveCount(0);
      // The note stays while the window keeps dying.
      expect(await stored(page, 'pandacode.windowDied')).toBe('');
    });

    test('the suspicion survives Restart PandaCode: the next launch keeps that thread closed, once', async ({ page }) => {
      // The window died with "Refine the navigation" open, was reloaded, died for good, and the user
      // chose Restart PandaCode in the native dialog: a new launch, no crash notice, not a reload.
      await leftOver(page, { 'pandacode.windowDied': 'session-2', 'pandacode.openThread': 'session-1' });
      await page.goto('/');
      await noticeReady(page);
      const toast = page.locator('#toast');
      await expect(toast).toHaveText(`${STOPPED_BEFORE} ${heldNoOther('Refine the navigation')}Open thread`);
      await page.waitForTimeout(1000);
      await expect(selected(page)).toHaveCount(0);
      expect(await stored(page, 'pandacode.windowDied')).toBeNull();
      // Honoured once: the launch after that is an ordinary one.
      await toast.getByRole('button', { name: 'Dismiss' }).click();
      await page.reload();
      await ready(page);
      await page.waitForTimeout(1000);
      await expect(toast).toBeHidden();
    });

    test('an ordinary reload says nothing', async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await ready(page);
      await page.reload();
      await ready(page);
      await expect.poll(async () => (await calls(page, 'crash_recovery_take')).length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(1000);
      await expect(page.locator('#toast')).toBeHidden();
      expect(await stored(page, 'pandacode.pageAlive')).toBe('1');
    });

    test('the mark outlives the render: it clears only after the transcript has painted', async ({ page }) => {
      // Counts animation frames from the moment boot marks its thread to the moment the mark is removed.
      await page.addInitScript(() => {
        const w = window as Window & { __markFrames?: number };
        const { setItem, removeItem } = Storage.prototype;
        let frames = -1;
        const count = () => { if (frames < 0) return; frames++; requestAnimationFrame(count); };
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'pandacode.restoringThread') { frames = 0; requestAnimationFrame(count); }
          return setItem.call(this, key, value);
        };
        Storage.prototype.removeItem = function (key: string) {
          if (key === 'pandacode.restoringThread' && frames >= 0 && w.__markFrames === undefined && this.getItem(key) !== null) { w.__markFrames = frames; frames = -1; }
          return removeItem.call(this, key);
        };
      });
      await page.goto('/');
      await ready(page);
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      // Two frames: the transcript was laid out and painted while the thread was still marked.
      expect(await page.evaluate(() => (window as Window & { __markFrames?: number }).__markFrames)).toBeGreaterThanOrEqual(2);
    });

    test('the mark clears once the messages have painted, before the slow inspector refresh, and on pagehide', async ({ page }) => {
      // git status never answers, as on a huge repository.
      await page.route('**/src/preview.ts*', async route => {
        const response = await route.fetch();
        const source = await response.text();
        // Served as JavaScript, so the quotes may have changed.
        const marker = /case ["']git_status["']:\s*result = /;
        expect(marker.test(source)).toBe(true);
        await route.fulfill({ response, body: source.replace(marker, match => match.replace('result = ', 'await new Promise(() => {}); result = ')) });
      });
      await page.goto('/');
      await ready(page);
      await expect(page.locator('#transcript')).not.toBeEmpty();
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      // An orderly unload clears a mark that is still there.
      await page.evaluate(() => localStorage.setItem('pandacode.restoringThread', 'session-1'));
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      expect(await stored(page, 'pandacode.restoringThread')).toBeNull();
    });

    test('opening the held-back thread from the sidebar does what Open thread does', async ({ page }) => {
      // With a report: the sentence and button go, the notice stays for the report.
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(held('Refine the navigation'));
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`);
      await expect(toast).toHaveAttribute('aria-live', 'off');
    });

    test('without a report, opening the held-back thread from the sidebar closes the notice for good', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(held('Refine the navigation'));
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toBeHidden();
      // It does not come back after the next toast.
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
      await expect(toast).toHaveText('A routine note');
      await expect(toast).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      await expect(toast).toBeHidden();
    });

    test('with restarts off, opening the held-back thread keeps the notice for the restarts-off line and Crash settings', async ({ page }) => {
      await page.addInitScript(() => { (window as CrashWindow).__crashRestartEnabled = false; });
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(held('Refine the navigation'));
      await toast.getByRole('button', { name: OPEN_NAVIGATION }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)}. Automatic restarts are off in Settings.Crash settings`);
      await expect(toast).toHaveAttribute('aria-live', 'off');
    });

    test('paused, opening the held-back thread from the sidebar keeps the notice for when restarts resume', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true });
      await page.goto('/');
      await noticeReady(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(heldNoOther('Refine the navigation'));
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      await expect(toast).toHaveText(`${pausedLead(await when(page))} ${await resume(page)}`);
      await expect(toast).toHaveAttribute('aria-live', 'off');
    });

    test('a held-back thread deleted while the notice shows loses its sentence and button', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast.getByRole('button')).toHaveText(['Open thread', 'Show crash report', '']);
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('sessions-deleted', { sessionIds: ['session-2'] }));
      // The task list changing rewrites the notice at once: no stale button is left to press.
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`);
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toHaveCount(0);
      await expect(selected(page)).not.toContainText('Refine the navigation');
    });

    test('a held-back thread deleted while another toast has the slot is gone from the notice when it comes back', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(held('Refine the navigation'));
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
      await expect(toast).toHaveText('A routine note');
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('sessions-deleted', { sessionIds: ['session-2'] }));
      await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.`, { timeout: 10_000 });
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toHaveCount(0);
    });

    test('a committed quit (app-quitting) clears the window note, the restoring mark and the alive key, and writes drafts', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      await page.evaluate(() => {
        localStorage.setItem('pandacode.windowDied', 'session-2');
        localStorage.setItem('pandacode.restoringThread', 'session-1');
      });
      // Typed text waiting on the save timer is written too.
      await page.locator('#prompt').fill('first');
      await page.locator('#prompt').fill('first and more');
      await page.evaluate(() => (window as CrashWindow).__previewEmit!('app-quitting', null));
      expect(await stored(page, 'pandacode.windowDied')).toBeNull();
      expect(await stored(page, 'pandacode.restoringThread')).toBeNull();
      expect(await stored(page, 'pandacode.pageAlive')).toBeNull();
      expect(JSON.parse((await stored(page, 'pandacode.draft:session-1')) ?? '{}').text).toBe('first and more');
    });

    test('a thread the user opens is marked until it has painted, so a crash while painting holds it back', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      // Record every mark written from here on.
      await page.evaluate(() => {
        const w = window as Window & { __marks?: string[] };
        const { setItem } = Storage.prototype;
        w.__marks = [];
        Storage.prototype.setItem = function (key: string, value: string) { if (key === 'pandacode.restoringThread') w.__marks!.push(value); return setItem.call(this, key, value); };
      });
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect(selected(page)).toContainText('Refine the navigation');
      expect(await page.evaluate(() => (window as Window & { __marks?: string[] }).__marks)).toEqual(['session-2']);
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      // Quick switches leave no mark behind once the last thread has painted.
      await page.locator('.task-item', { hasText: 'Make search feel instant' }).click();
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await page.locator('.task-item', { hasText: 'Make search feel instant' }).click();
      await expect(selected(page)).toContainText('Make search feel instant');
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
    });

    test('a thread opened again while its first load is pending stays marked until the second load has painted', async ({ page }) => {
      // session-2's pages are held while `__holdPages` is set, in order, until released one by one.
      await page.route('**/src/preview.ts*', async route => {
        const response = await route.fetch(), source = await response.text(), marker = /switch\s*\(command\)\s*\{/;
        expect(source).toMatch(marker);
        await route.fulfill({ response, body: source.replace(marker, match => `if (command === 'get_messages' && args.sessionId === 'session-2' && window.__holdPages) await new Promise(resolve => (window.__heldPages ??= []).push(resolve));
      ${match}`) });
      });
      await page.goto('/');
      await ready(page);
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
      type Held = Window & { __holdPages?: boolean; __heldPages?: (() => void)[] };
      await page.evaluate(() => { (window as Held).__holdPages = true; });
      const held = () => page.evaluate(() => (window as Held).__heldPages?.length ?? 0);
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect.poll(held).toBe(1);
      await page.locator('.task-item', { hasText: 'Make search feel instant' }).click();
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect.poll(held).toBe(2);
      expect(await stored(page, 'pandacode.restoringThread')).toBe('session-2');
      // The first load's late page is superseded by the same thread's second load, which has not painted yet.
      await page.evaluate(() => (window as Held).__heldPages!.shift()!());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await stored(page, 'pandacode.restoringThread')).toBe('session-2');
      await page.evaluate(() => (window as Held).__heldPages!.shift()!());
      await expect.poll(() => stored(page, 'pandacode.restoringThread')).toBeNull();
    });

    test('nor is the newest thread when it was the one that took the app down', async ({ page }) => {
      await leftOver(page, { 'pandacode.restoringThread': 'session-1' });
      await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
      await page.goto('/');
      await ready(page);
      await expect(selected(page)).not.toContainText('Make search feel instant');
    });

    test('paused restarts open no thread by themselves, and name the one kept closed', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true });
      await page.goto('/');
      await noticeReady(page);
      // Boot opened nothing, so the sentence says so and names the thread kept closed.
      await expect(page.locator('#toast')).toHaveText(`${PAUSED} ${heldNoOther('Refine the navigation')} ${await resume(page)}Open thread`);
      await page.waitForTimeout(1000);
      await expect(selected(page)).toHaveCount(0);
    });

    test('paused restarts with no remembered thread open none either, since the newest may be the one that crashes', async ({ page }) => {
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 60_000 });
      await page.goto('/');
      await noticeReady(page);
      // Nothing is open and no thread is named: the notice says why the window is empty.
      await expect(page.locator('#toast')).toHaveText(`${pausedLead(await when(page))} ${NOTHING} ${await resume(page)}`);
      await page.waitForTimeout(1000);
      await expect(selected(page)).toHaveCount(0);
      await expect(page.locator('#prompt')).toHaveCount(0);
    });

    test('paused restarts never open the remembered thread, even when it is the newest, and say why', async ({ page }) => {
      // The crash came after the thread had loaded, so there is no restoring marker.
      await leftOver(page, { 'pandacode.openThread': 'session-1' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true });
      await page.goto('/');
      await noticeReady(page);
      await expect(selected(page)).toHaveCount(0);
      // The paused limit holds the whole held-back sentence beside when restarts resume.
      await expect(page.locator('#toast')).toHaveText(`${PAUSED} No thread was opened, in case your last thread, “Make search feel instant”, caused this. ${await resume(page)}Open thread`);
    });

    test('paused restarts still reopen an unsent New task with its kept text, and do not claim nothing was opened', async ({ page }) => {
      const draft = JSON.stringify({ t: Date.now(), text: 'kept through the crashes' });
      await leftOver(page, { 'pandacode.openThread': 'draft-gone', 'pandacode.openNewTask': '1', 'pandacode.project': 'project-1', 'pandacode.draft:new:project-1': draft });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 60_000 });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('textbox', { name: 'Message your coding agent', exact: true })).toHaveValue('kept through the crashes');
      await noticeReady(page);
      await expect(page.locator('#toast')).toHaveText(`${pausedLead(await when(page))} ${await resume(page)}`);
      await expect(page.locator('#toast')).not.toContainText(NOTHING);
    });

    test('a New task whose project was removed while the app was closed falls back to the newest thread, silently', async ({ page }) => {
      const draft = JSON.stringify({ t: Date.now(), text: 'for a project that is gone' });
      await leftOver(page, { 'pandacode.openThread': 'draft-gone', 'pandacode.openNewTask': '1', 'pandacode.project': 'project-removed', 'pandacode.draft:new:project-removed': draft });
      await page.goto('/');
      await ready(page);
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(page.locator('#toast')).toBeHidden();
    });

    test('paused restarts that reopen a New task call the held-back thread "the thread", not "your last thread"', async ({ page }) => {
      const draft = JSON.stringify({ t: Date.now(), text: 'kept through the crashes' });
      // The crash came while session-2 was opening from the New task.
      await leftOver(page, { 'pandacode.openThread': 'draft-gone', 'pandacode.openNewTask': '1', 'pandacode.project': 'project-1', 'pandacode.draft:new:project-1': draft, 'pandacode.restoringThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 60_000 });
      await page.goto('/');
      await expect(page.getByRole('textbox', { name: 'Message your coding agent', exact: true })).toHaveValue('kept through the crashes', { timeout: 15_000 });
      await noticeReady(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(heldNotLast('Refine the navigation'));
      await expect(toast).not.toContainText(/your last thread/i);
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toBeVisible();
    });

    test('after a paused launch that opened nothing, opening any thread drops "no thread was opened", in place and unannounced', async ({ page }) => {
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 60_000 });
      await page.goto('/');
      await noticeReady(page);
      const toast = page.locator('#toast'), text = `${pausedLead(await when(page))} ${await resume(page)}`;
      await expect(toast).toHaveText(`${pausedLead(await when(page))} ${NOTHING} ${await resume(page)}`);
      await page.locator('.task-item[data-id="session-1"]').click();
      await expect(selected(page)).toContainText('Make search feel instant');
      await expect(toast).toHaveText(text);
      await expect(toast).toHaveAttribute('aria-live', 'off');
    });

    test('after a paused launch that named the kept-closed thread, a New task turns the sentence into the plain held-back one and keeps Open thread', async ({ page }) => {
      await leftOver(page, { 'pandacode.openThread': 'session-2' });
      await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 60_000 });
      await page.goto('/');
      await noticeReady(page);
      const toast = page.locator('#toast');
      await expect(toast).toContainText(heldNoOther('Refine the navigation'));
      await page.keyboard.press('Meta+n');
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
      await expect(toast).toContainText(held('Refine the navigation'));
      await expect(toast).not.toContainText('No thread was opened');
      await expect(toast).toHaveAttribute('aria-live', 'off');
      await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toBeVisible();
    });

    test('a window that dies again reopens an unsent New task with its kept text, and does not say nothing was opened', async ({ page }) => {
      const draft = JSON.stringify({ t: Date.now(), text: 'kept through the reloads' });
      await page.goto('/');
      await ready(page);
      await deadWindow(page, { 'pandacode.windowDied': '', 'pandacode.openThread': 'draft-gone', 'pandacode.openNewTask': '1', 'pandacode.project': 'project-1', 'pandacode.draft:new:project-1': draft }, ['pandacode.restoringThread']);
      await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('textbox', { name: 'Message your coding agent', exact: true })).toHaveValue('kept through the reloads');
      await noticeReady(page);
      await expect(page.locator('#toast')).toHaveText(RELOADED_AGAIN);
    });

    test('drafts of threads deleted while the app was closed are dropped at launch; a failed check keeps them', async ({ page }) => {
      const draft = (text: string) => JSON.stringify({ t: Date.now(), text });
      await leftOver(page, { 'pandacode.draft:session-2': draft('still here'), 'pandacode.draft:deleted-thread': draft('gone with it'), 'pandacode.draft:new:project-2': draft('a New task'), 'pandacode.draft:new:removed-project': draft('removed elsewhere') });
      await page.goto('/');
      await ready(page);
      await expect.poll(() => stored(page, 'pandacode.draft:deleted-thread')).toBeNull();
      expect(await stored(page, 'pandacode.draft:session-2')).not.toBeNull();
      expect(await stored(page, 'pandacode.draft:new:project-2')).not.toBeNull();
      // New task text of a project that is no longer listed goes too (removed some other way than this window's Remove).
      expect(await stored(page, 'pandacode.draft:new:removed-project')).toBeNull();
      // Only per-thread drafts are asked about.
      const asked = (await calls(page, 'sessions_missing')).map(call => call.args.ids);
      expect(asked).toEqual([expect.arrayContaining(['session-2', 'deleted-thread'])]);
      expect((asked[0] as string[]).some(id => id.startsWith('new:'))).toBe(false);
      // A failing check changes nothing.
      await page.evaluate(draft => {
        localStorage.setItem('pandacode.draft:deleted-thread', draft);
        sessionStorage.setItem('fail-missing', '1');
      }, draft('gone with it'));
      await page.addInitScript(() => {
        if (sessionStorage.getItem('fail-missing')) (window as Window & { __crashFailCommands?: Record<string, number> }).__crashFailCommands = { sessions_missing: 1 };
      });
      await page.reload();
      await ready(page);
      await expect.poll(async () => (await calls(page, 'sessions_missing')).length).toBe(1);
      await page.waitForTimeout(500);
      expect(await stored(page, 'pandacode.draft:deleted-thread')).not.toBeNull();
    });

    test('removing a project removes its unsent New task text from storage', async ({ page }) => {
      await page.goto('/');
      await ready(page);
      await openGeneral(page);
      const row = page.locator('#projects-settings .project-row').first();
      await expect(row).toBeVisible();
      const key = `pandacode.draft:new:${await row.getAttribute('data-project')}`;
      await page.evaluate(name => localStorage.setItem(name, JSON.stringify({ t: Date.now(), text: 'never sent' })), key);
      await row.getByRole('button', { name: /^Remove / }).click();
      await page.locator('#projects-settings .project-row').first().getByRole('button', { name: 'Remove project' }).click();
      await expect.poll(() => stored(page, key)).toBeNull();
    });

    test('choosing a project without threads is where the next launch lands', async ({ page }) => {
      await page.route('**/src/preview.ts*', async route => {
        const response = await route.fetch();
        const source = await response.text();
        // Served as JavaScript, so the type annotation may be gone.
        const marker = /let projects(?:: Project\[\])? = \[/;
        expect(source).toMatch(marker);
        await route.fulfill({ response, body: source.replace(marker, match => `${match}{ id: 'project-empty', name: 'empty-project', path: '/Users/you/Projects/empty' }, `) });
      });
      await page.goto('/');
      await ready(page);
      await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
      await expect.poll(() => stored(page, 'pandacode.openThread')).toBe('session-2');
      await page.getByRole('button', { name: 'Filter projects' }).first().click();
      await page.getByRole('dialog', { name: 'Filter projects', exact: true }).getByRole('menuitemradio', { name: 'empty-project', exact: true }).click();
      await expect(selected(page)).toHaveCount(0);
      expect(await stored(page, 'pandacode.openThread')).toBeNull();
      await page.reload();
      // Boot asks for the crash recovery before it picks a thread; give the pick time to happen.
      await expect.poll(async () => (await calls(page, 'crash_recovery_take')).length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(2000);
      await expect(page.getByRole('button', { name: 'Filter projects' }).first()).toContainText('empty-project');
      await expect(selected(page)).toHaveCount(0);
    });
  });
}
