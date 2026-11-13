import { expect, test, type Page } from '@playwright/test';
import { type CrashWindow, crashed, failing, leftOver, when, calls, stored, ready, selected, openGeneral, SWITCH, DETAIL, REPORTS_DETAIL, SHOW_LATEST, INTERRUPTED, AGENTS_STOPPED, RESTARTS_BACK, interruptedTasks, DRAFTS, DRAFTS_OFF, KEEP_DRAFTS, CLEAR_DRAFTS, pausedLead, notRestarted, NOTHING, resume, PAUSED_REPORT_STEP_START, noticeReady, OPEN_NAVIGATION, PAUSED, CRASH_SETTINGS, CRASH_SETTINGS_NAME } from './crash-recovery-helpers';
import { launchRestoreTests } from './crash-recovery-restore';

// Crash recovery: the notice on the launch after a crash and the Settings switch here; what a
// launch brings back (safely) in crash-recovery-restore.ts, which is part of this spec so both
// Playwright configs run it. Helpers and wording: crash-recovery-helpers.ts.
test.describe('crash recovery notice', () => {
  test('an automatic restart says so in the polite status toast, with no report button', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.`);
    // The live region is the toast's text alone (its buttons are never read with it).
    await expect(toast.locator('.toast-text')).toHaveAttribute('role', 'status');
    // Only the close button: no report was kept.
    await expect(toast.getByRole('button')).toHaveCount(1);
    await expect(toast.getByRole('button', { name: 'Dismiss notice' })).toBeVisible();
    // Asked once per launch.
    expect(await calls(page, 'crash_recovery_take')).toHaveLength(1);
  });

  test('a manual launch after a crash never claims a restart, and shows a plain cause', async ({ page }) => {
    await crashed(page, { summary: 'Crashed with SIGSEGV', hasReport: false, restarted: false, restartsPaused: false, agoMs: 3 * 60_000 });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(`${notRestarted(await when(page))} Cause: a memory error (SIGSEGV).`);
  });

  test('a panic shows no cause, and Show crash report reveals the local report from the keyboard', async ({ page }) => {
    await crashed(page, { summary: 'Panic: <b>index</b> out of bounds at /Users/alex/src/x.rs', hasReport: true, restarted: true, restartsPaused: false, agoMs: 3 * 60_000 });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`);
    await expect(toast).not.toContainText('Panic');
    await expect(toast).not.toContainText('/Users');
    await expect(toast.locator('b')).toHaveCount(0);
    const reveal = toast.getByRole('button', { name: 'Show crash report' });
    await reveal.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await calls(page, 'crash_report_reveal')).length).toBe(1);
    // Showing the report does not end the notice: it is still there when the user comes back.
    await page.waitForTimeout(500);
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`);
    await expect(toast.getByRole('button', { name: 'Dismiss notice' })).toBeVisible();
  });

  test('paused restarts say the app did not restart, that agents stopped, that no thread was opened and when restarts resume, leaving the report to its button', async ({ page }) => {
    await crashed(page, { summary: 'Crashed with SIGSEGV', hasReport: true, restarted: false, restartsPaused: true, agoMs: 2 * 60_000, agentsInterrupted: true });
    await page.goto('/');
    await noticeReady(page);
    const toast = page.locator('#toast');
    // No task shows as Interrupted here, so the agents sentence points nowhere; the crash time fits beside when restarts resume.
    await expect(toast).toHaveText(`${pausedLead(await when(page))} ${AGENTS_STOPPED} ${NOTHING} ${await resume(page)}Show crash report`);
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeVisible();
  });

  test('paused restarts leave out when restarts resume once the crash is over 10 minutes old, say they are on again and point to the report', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: false, restartsPaused: true, agoMs: 2 * 60 * 60_000, agentsInterrupted: false });
    await page.goto('/');
    await noticeReady(page);
    const toast = page.locator('#toast');
    // Restarts are on again: the unnamed nothing-opened sentence goes (nothing to act on).
    await expect(toast).toContainText(`${RESTARTS_BACK} ${PAUSED_REPORT_STEP_START}`);
    await expect(toast).not.toContainText(NOTHING);
    await expect(toast).toContainText(/^PandaCode kept crashing/);
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeVisible();
  });

  test('a paused notice past the resume time with no report closes by saying restarts are back on', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: true, agoMs: 2 * 60 * 60_000, agentsInterrupted: false });
    await page.goto('/');
    await noticeReady(page);
    await expect(page.locator('#toast')).toHaveText(`${pausedLead(await when(page))} ${RESTARTS_BACK}`);
  });

  test('agents stopped with no task showing as Interrupted: the notice does not ask to open one', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false, agentsInterrupted: true });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(`PandaCode crashed ${await when(page)} and restarted. ${AGENTS_STOPPED}`);
  });

  test('the native agentsInterrupted answer decides the agent line', async ({ page }) => {
    await interruptedTasks(page, ['session-3']);
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false, agentsInterrupted: true });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(`PandaCode crashed ${await when(page)} and restarted. ${INTERRUPTED}`);
  });

  test('a native no is trusted: a task left Interrupted by an earlier quit never makes the notice say agents were stopped', async ({ page }) => {
    await interruptedTasks(page, ['session-3']);
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false, agentsInterrupted: false });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(`PandaCode crashed ${await when(page)} and restarted.`);
  });

  test('the agents sentence goes, in place and unannounced, once the last Interrupted task is resumed', async ({ page }) => {
    await page.addInitScript(() => { (window as Window & { __previewInterrupted?: string[] }).__previewInterrupted = ['session-2', 'session-3']; });
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false, agentsInterrupted: true });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast'), lead = `PandaCode crashed ${await when(page)} and restarted.`;
    await expect(toast).toHaveText(`${lead} ${INTERRUPTED}`);
    const setStatus = (id: string, status: string) => page.evaluate(([id, status]) => (window as Window & { __previewSetStatus?: (id: string, status: string) => void }).__previewSetStatus!(id, status), [id, status]);
    // One is resumed: another still shows as Interrupted, so the sentence stays.
    await setStatus('session-2', 'running');
    await expect(page.locator('.task-item[data-id="session-2"]')).not.toContainText('Interrupted');
    await expect(toast).toHaveText(`${lead} ${INTERRUPTED}`);
    await setStatus('session-3', 'idle');
    await expect(toast).toHaveText(lead);
    await expect(toast).toHaveAttribute('aria-live', 'off');
  });

  test('Escape dismisses it only with focus in it, where the close button promises it, and never reaches the page from there', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast'), close = toast.getByRole('button', { name: 'Dismiss notice' });
    await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted.`);
    // What the page's own Escape handling (it stops a running agent) gets to see.
    await page.evaluate(() => document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) (window as Window & { __pageEscapes?: number }).__pageEscapes = ((window as Window & { __pageEscapes?: number }).__pageEscapes ?? 0) + 1;
    }));
    const pageEscapes = () => page.evaluate(() => (window as Window & { __pageEscapes?: number }).__pageEscapes ?? 0);
    // With focus in the composer Escape is the page's: the notice stays, and its tip promised nothing else.
    await expect(close).toHaveAttribute('data-tip', 'Dismiss');
    await expect(close).not.toHaveAttribute('aria-keyshortcuts', /Escape/);
    await page.locator('#prompt').focus();
    await page.keyboard.press('Escape');
    await expect(toast).toBeVisible();
    const before = await pageEscapes();
    // With focus in the toast the close button announces Escape, and Escape closes it without reaching the page.
    await page.keyboard.press('F6');
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeFocused();
    await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
    await page.keyboard.press('F6');
    await expect(page.locator('#prompt')).toBeFocused();
    await expect(close).not.toHaveAttribute('aria-keyshortcuts', /Escape/);
    await page.keyboard.press('F6');
    await page.keyboard.press('Escape');
    await expect(toast).toBeHidden();
    expect(await pageEscapes()).toBe(before);
  });

  test('the close button and Escape dismiss it for good, and F6 reaches its actions and returns', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted.`);
    await page.locator('#prompt').focus();
    await page.keyboard.press('F6');
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeFocused();
    // The close button follows the action (WebKit's Tab skips buttons by default, hence F6).
    await expect(toast.getByRole('button')).toHaveText(['Show crash report', '']);
    await expect(toast.getByRole('button').nth(1)).toHaveAccessibleName('Dismiss notice');
    // F6 is announced on the button it reaches; the close button's tip names no key.
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toHaveAttribute('aria-keyshortcuts', 'F6');
    await expect(toast.getByRole('button').nth(1)).toHaveAttribute('data-tip', 'Dismiss');
    await page.keyboard.press('F6');
    await expect(page.locator('#prompt')).toBeFocused();
    await page.keyboard.press('F6');
    await page.keyboard.press('Escape');
    await expect(toast).toBeHidden();
    await expect(page.locator('#prompt')).toBeFocused();
    // A dismissed notice does not come back after the next toast.
    await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
    await expect(toast).toHaveText('A routine note');
    await expect(toast).toBeHidden({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await expect(toast).toBeHidden();
  });

  test('the close button closes it with a click', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    await page.locator('#toast').getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(page.locator('#toast')).toBeHidden();
  });

  test('a routine toast right after it does not erase the notice unseen', async ({ page }) => {
    // Two other toasts come and go.
    test.setTimeout(60_000);
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    // Every animation started on the toast, by the text it showed then.
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
        if (this.id === 'toast') ((window as Window & { __toastAnimations?: string[] }).__toastAnimations ??= []).push(this.textContent ?? '');
        return animate.apply(this, args);
      };
    });
    const noticeAnimations = () => page.evaluate(() => ((window as Window & { __toastAnimations?: string[] }).__toastAnimations ?? []).filter(text => text.includes('PandaCode crashed')).length);
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted.`);
    const entrances = await noticeAnimations();
    await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
    await expect(toast).toHaveText('A routine note');
    // The first showing is announced; the routine toast is too.
    await expect(toast).not.toHaveAttribute('aria-live', 'off');
    // Once the routine toast leaves, the notice comes back with its action, without being read again.
    await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted.`, { timeout: 15_000 });
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeVisible();
    await expect(toast).toHaveAttribute('aria-live', 'off');
    // It is back as it was: no second entrance animation.
    await page.waitForTimeout(300);
    expect(await noticeAnimations()).toBe(entrances);
    // The next toast is announced as usual, and the notice keeps coming back after it.
    await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'Another note' }));
    await expect(toast).toHaveText('Another note');
    await expect(toast).not.toHaveAttribute('aria-live', 'off');
    await expect(toast).toContainText(`PandaCode crashed ${await when(page)} and restarted.`, { timeout: 15_000 });
  });

  test('it stays until the user closes it, however long they are away', async ({ page }) => {
    await page.clock.install();
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    const text = `PandaCode crashed ${await when(page)} and restarted.`;
    await expect(toast).toHaveText(text);
    // A clock time: still true an hour later, when the notice comes back after another toast too.
    await page.clock.fastForward('01:00:00');
    await expect(toast).toHaveText(text);
    await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
    await expect(toast).toHaveText('A routine note');
    await page.clock.fastForward('00:20');
    await expect(toast).toHaveText(text);
    expect(text).not.toMatch(/just now|ago/);
    await toast.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(toast).toBeHidden();
  });

  test('left on screen past midnight, its time gains the date without being announced again', async ({ page }) => {
    // Half past noon UTC is the same local day four seconds earlier in every time zone in use.
    await page.clock.install({ time: new Date('2026-11-11T12:30:00Z') });
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    const today = await when(page);
    expect(today).toMatch(/^at /);
    await expect(toast).toHaveText(`PandaCode crashed ${today} and restarted.`);
    await expect(toast).not.toHaveAttribute('aria-live', 'off');
    // Past the next local midnight, plus the timer's slack.
    const untilMidnight = await page.evaluate(() => { const next = new Date(); next.setHours(24, 0, 0, 0); return next.getTime() - Date.now(); });
    await page.clock.fastForward(untilMidnight + 5 * 60_000);
    const yesterday = await when(page);
    expect(yesterday).toMatch(/^on .+ at /);
    await expect(toast).toHaveText(`PandaCode crashed ${yesterday} and restarted.`, { timeout: 15_000 });
    await expect(toast).toHaveAttribute('aria-live', 'off');
    await expect(toast.getByRole('button', { name: 'Dismiss notice' })).toBeVisible();
  });

  test('left on screen while restarts resume, the paused notice drops its resume sentence in place, unannounced', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-11T12:30:00Z') });
    await crashed(page, { summary: null, hasReport: true, restarted: false, restartsPaused: true, agoMs: 9 * 60_000, agentsInterrupted: false });
    await page.goto('/');
    await noticeReady(page);
    const toast = page.locator('#toast'), lead = pausedLead(await when(page));
    await expect(toast).toHaveText(`${lead} ${NOTHING} ${await resume(page)}Show crash report`);
    await expect(toast).not.toHaveAttribute('aria-live', 'off');
    // The guard's ten-minute window ends a minute later: restarts are on again, the report is the next step,
    // and the unnamed nothing-opened sentence goes.
    await page.clock.fastForward(2 * 60_000);
    await expect(toast).toContainText(`${RESTARTS_BACK} ${PAUSED_REPORT_STEP_START}`);
    await expect(toast).not.toContainText(NOTHING);
    await expect(toast).toContainText(/^PandaCode kept crashing/);
    await expect(toast).toHaveAttribute('aria-live', 'off');
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeVisible();
  });

  test('a manual launch with restarts switched off says so', async ({ page }) => {
    await page.addInitScript(() => { (window as CrashWindow).__crashRestartEnabled = false; });
    await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(`PandaCode crashed ${await when(page)}. Automatic restarts are off in Settings.${CRASH_SETTINGS}`);
  });

  test('restarts off: Crash settings opens Settings at Crash recovery from the keyboard, and the notice is back unannounced after', async ({ page, browserName }) => {
    await page.addInitScript(() => { (window as CrashWindow).__crashRestartEnabled = false; });
    await crashed(page, { summary: null, hasReport: true, restarted: false, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    const text = `PandaCode crashed ${await when(page)}. Automatic restarts are off in Settings.Show crash report${CRASH_SETTINGS}`;
    await expect(toast).toHaveText(text);
    const settings = toast.getByRole('button', { name: CRASH_SETTINGS_NAME, exact: true });
    // Both quiet: without Open thread no button takes the accent fill.
    await expect(settings).toHaveClass(/toast-secondary/);
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toHaveClass(/toast-secondary/);
    await expect(toast.locator('.toast-action')).toHaveCount(0);
    // F6 reaches the toast's first button; Tab (Option+Tab in WebKit, as in Safari) moves on to Crash settings.
    await page.locator('#prompt').focus();
    await page.keyboard.press('F6');
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(settings).toBeFocused();
    // Marks the notice's text node, to tell that it is never written again (which would announce it).
    await toast.evaluate(element => { (element.firstChild as Node & { mark?: boolean }).mark = true; });
    await page.keyboard.press('Enter');
    // Settings → General, at the Crash recovery group, with its switch focused.
    const region = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(region.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
    const toggle = page.locator('#crash-restart-enabled');
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeInViewport();
    await expect(toast).toBeHidden();
    await region.getByRole('button', { name: 'Back' }).first().click();
    // Back as it was: same text and buttons, not announced again.
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(text);
    expect(await toast.evaluate(element => (element.firstChild as Node & { mark?: boolean }).mark)).toBe(true);
    // Focus returns to the button that opened Settings.
    await expect(settings).toBeFocused();
    expect(await calls(page, 'crash_recovery_take')).toHaveLength(1);
  });

  test('restarts off: turning the switch on from Crash settings drops the sentence and the button, unannounced', async ({ page }) => {
    await page.addInitScript(() => { (window as CrashWindow).__crashRestartEnabled = false; });
    await crashed(page, { summary: null, hasReport: true, restarted: false, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)}. Automatic restarts are off in Settings.Show crash report${CRASH_SETTINGS}`);
    await toast.getByRole('button', { name: CRASH_SETTINGS_NAME, exact: true }).click();
    const toggle = page.locator('#crash-restart-enabled');
    await expect(toggle).toBeFocused();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('button', { name: 'Back' }).first().click();
    // Restarts are on: it reads as a crash that did not restart itself, with the report as the next step.
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(`${notRestarted(await when(page))} If it keeps happening, open a GitHub issue with the crash report (check it for private details first).Show crash report`);
    await expect(toast.getByRole('button', { name: CRASH_SETTINGS_NAME })).toHaveCount(0);
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toHaveClass(/toast-secondary/);
    // Already announced: the rewrite is not read out again.
    await expect(toast).toHaveAttribute('aria-live', 'off');
    expect(await calls(page, 'crash_recovery_take')).toHaveLength(1);
  });

  test('a crash restart with a report highlights no button: Show crash report is quiet', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast.getByRole('button', { name: 'Show crash report' })).toHaveClass(/toast-secondary/);
    await expect(toast.locator('.toast-action')).toHaveCount(0);
  });

  test('only restarts that are off get the Crash settings button', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: false, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toHaveText(notRestarted(await when(page)));
    await expect(page.locator('#toast').getByRole('button', { name: CRASH_SETTINGS_NAME })).toHaveCount(0);
  });

  test('F6 out of a notice that was clicked into goes to the composer', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    const report = toast.getByRole('button', { name: 'Show crash report' });
    await expect(report).toBeVisible();
    // A click on the text records no place to go back to.
    await toast.click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('F6');
    await expect(report).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.locator('#prompt')).toBeFocused();
    // Nor does focus put straight on a button; Escape then closes it and leaves focus in the composer too.
    await report.focus();
    await page.keyboard.press('F6');
    await expect(page.locator('#prompt')).toBeFocused();
    await report.focus();
    await page.keyboard.press('Escape');
    await expect(toast).toBeHidden();
    await expect(page.locator('#prompt')).toBeFocused();
  });

  test('F6 leaves the keyboard alone while a modal dialog makes the toast unreachable', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toContainText(`PandaCode crashed ${await when(page)} and restarted.`);
    await page.keyboard.press('Meta+K');
    await expect(page.locator('#command-query')).toBeFocused();
    await page.evaluate(() => window.addEventListener('keydown', event => { if (event.key === 'F6') (window as Window & { __f6?: boolean }).__f6 = event.defaultPrevented; }));
    const before = await page.evaluate(() => document.activeElement?.outerHTML);
    await page.keyboard.press('F6');
    expect(await page.evaluate(() => (window as Window & { __f6?: boolean }).__f6)).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(before);
  });

  test('a failing reveal says so, and the notice comes back after the error', async ({ page }) => {
    test.setTimeout(60_000);
    await crashed(page, { summary: null, hasReport: true, restarted: true, restartsPaused: false });
    await failing(page, { crash_report_reveal: 1 });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await toast.getByRole('button', { name: 'Show crash report' }).click();
    await expect(toast).toHaveText('Could not show the crash report: crash_report_reveal failed in the preview');
    // The error leaves by itself; the notice returns with its action, which works on the next try.
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.Show crash report`, { timeout: 20_000 });
    await expect(toast).toHaveAttribute('aria-live', 'off');
    await toast.getByRole('button', { name: 'Show crash report' }).click();
    await expect.poll(async () => (await calls(page, 'crash_report_reveal')).length).toBe(2);
    await page.waitForTimeout(500);
    await expect(toast).toContainText('PandaCode crashed');
  });

  test('a page that dies before showing the notice gets it again; once shown, the next load does not', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    // The first page asks but never gets to show the notice (its answer never arrives).
    await page.addInitScript(() => {
      if (sessionStorage.getItem('first-page')) return;
      sessionStorage.setItem('first-page', '1');
      (window as Window & { __crashGates?: Record<string, Promise<void>> }).__crashGates = { crash_recovery_take: new Promise<void>(() => {}) };
    });
    await page.goto('/');
    await expect.poll(async () => (await calls(page, 'crash_recovery_take')).length).toBe(1);
    const toast = page.locator('#toast');
    await expect(toast).toBeHidden();
    expect(await calls(page, 'crash_recovery_shown')).toHaveLength(0);
    await page.reload();
    await ready(page);
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.`);
    await expect.poll(async () => (await calls(page, 'crash_recovery_shown')).length).toBe(1);
    expect((await calls(page, 'crash_recovery_shown'))[0].args).toEqual({});
    await page.reload();
    await ready(page);
    await page.waitForTimeout(1000);
    await expect(toast).toBeHidden();
    expect(await calls(page, 'crash_recovery_shown')).toHaveLength(0);
  });

  test('a failing acknowledgement is logged and the notice stays', async ({ page }) => {
    await crashed(page, { summary: null, hasReport: false, restarted: true, restartsPaused: false });
    await failing(page, { crash_recovery_shown: 1 });
    const warnings: string[] = [];
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await expect(toast).toHaveText(`PandaCode crashed ${await when(page)} and restarted.`);
    await expect.poll(() => warnings.some(text => text.includes('Could not mark the crash notice as shown'))).toBe(true);
    await page.waitForTimeout(500);
    await expect(toast).toBeVisible();
  });

  test('a normal launch shows nothing, and a failing check never breaks startup', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await failing(page, { crash_recovery_take: 1 });
    await page.goto('/');
    await ready(page);
    await expect.poll(async () => (await calls(page, 'crash_recovery_take')).length).toBe(1);
    await expect(page.locator('#toast')).toBeHidden();
    await expect(page.locator('#prompt')).toBeEditable();
    expect(errors).toEqual([]);
  });
});

test.describe('crash recovery notice placement', () => {
  type Box = { x: number; y: number; width: number; height: number };
  const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const clearOfComposer = async (page: Page) => {
    const toast = page.locator('#toast');
    await expect(toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true })).toBeVisible();
    // Measured once the entrance has settled.
    await expect.poll(async () => {
      const [notice, composer] = await Promise.all([toast.boundingBox(), page.locator('#composer-area .composer').boundingBox()]);
      return Boolean(notice && composer && composer.width > 0 && !intersects(notice, composer));
    }).toBe(true);
    const notice = (await toast.boundingBox())!;
    expect(notice.y).toBeGreaterThanOrEqual(0);
  };
  const longCrash = async (page: Page) => {
    await leftOver(page, { 'pandacode.openThread': 'session-2', 'pandacode.restoringThread': 'session-2' });
    await crashed(page, { summary: 'Crashed with SIGSEGV', hasReport: true, restarted: true, restartsPaused: false, agentsInterrupted: true });
  };

  test('at 1300px wide with the inspector closed, the persistent notice does not cover the composer', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 820 });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#toast')).toBeVisible();
    if (await page.locator('#inspector').isVisible()) {
      await page.getByRole('button', { name: 'Toggle inspector', exact: true }).first().click();
      await expect(page.locator('#inspector')).toBeHidden();
    }
    await clearOfComposer(page);
    // An ordinary toast keeps its corner.
    await page.evaluate(() => (window as CrashWindow).__previewEmit!('bot-notification', { text: 'A routine note' }));
    await expect(page.locator('#toast')).toHaveText('A routine note');
    await expect.poll(() => page.locator('#toast').evaluate(element => (element as HTMLElement).style.getPropertyValue('--toast-lift'))).toBe('');
  });

  /** Clear of the composer and of every inspector panel, in the conversation pane. */
  const clearOfPanels = async (page: Page) => {
    await clearOfComposer(page);
    const inspector = page.locator('#inspector');
    await expect(inspector).toBeVisible();
    await expect.poll(async () => {
      const [notice, panel, pane, dock] = await Promise.all([page.locator('#toast').boundingBox(), inspector.boundingBox(), page.locator('.main-pane').boundingBox(), page.locator('#action-dock').boundingBox()]);
      if (!notice || !panel || !pane) return 'unmeasured';
      if (intersects(notice, panel)) return 'covers the inspector';
      if (dock && intersects(notice, dock)) return 'covers the dock';
      return notice.x >= pane.x && notice.x + notice.width <= pane.x + pane.width ? 'clear' : 'outside the pane';
    }).toBe('clear');
  };
  for (const width of [1300, 1600]) {
    test(`at ${width}px wide with the inspector open, the persistent notice covers neither it nor the composer`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await longCrash(page);
      await page.goto('/');
      await ready(page);
      if (!(await page.locator('#inspector').isVisible())) await page.getByRole('button', { name: 'Toggle inspector', exact: true }).first().click();
      await clearOfPanels(page);
      // The Git list and commit form live in the inspector's lower half; it stays clear when the inspector closes and opens again.
      await page.getByRole('button', { name: 'Toggle inspector', exact: true }).first().click();
      await expect(page.locator('#inspector')).toBeHidden();
      await clearOfComposer(page);
      await page.getByRole('button', { name: 'Toggle inspector', exact: true }).first().click();
      await clearOfPanels(page);
    });
  }

  test('its two buttons share a row at 1300px, after text that wraps normally', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 820 });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    const open = toast.getByRole('button', { name: OPEN_NAVIGATION, exact: true }), report = toast.getByRole('button', { name: 'Show crash report' });
    await expect(open).toBeVisible();
    const [a, b, box] = await Promise.all([open.boundingBox(), report.boundingBox(), toast.boundingBox()]);
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(4);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
    // Neither stretches across the toast.
    expect(a!.width).toBeLessThan(box!.width / 2);
    expect(await toast.evaluate(element => getComputedStyle(element).display)).toBe('block');
  });

  test('scrolled to the end, the last message is not under the persistent notice, and the room goes with it', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 620 });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    await clearOfComposer(page);
    const transcript = page.locator('#transcript'), toast = page.locator('#toast');
    const room = () => transcript.evaluate(element => (element as HTMLElement).style.getPropertyValue('--toast-room'));
    await expect.poll(room).not.toBe('');
    // Pinned: a transcript at its bottom stays there when the room arrives.
    await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => {
      // The last thing shown: messages folded into a closed turn trace still have a layout box, so only visible ones count.
      const [notice, last] = await Promise.all([toast.boundingBox(), transcript.locator('[data-message-id], .turn-card').filter({ visible: true }).last().boundingBox()]);
      return notice && last ? Math.round(last.y + last.height - notice.y) : 'unmeasured';
    }).toBeLessThanOrEqual(0);
    await toast.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(toast).toBeHidden();
    await expect.poll(room).toBe('');
  });

  test('in a narrow window the persistent notice sits above the composer', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 820 });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    await clearOfComposer(page);
    // And stays clear when the window grows.
    await page.setViewportSize({ width: 1300, height: 820 });
    await clearOfComposer(page);
  });

  /** The labels of the focusable controls outside the toast that it covers, as it is drawn now. */
  const coveredControls = (page: Page) => page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>('#toast')!;
    if (toast.hidden || getComputedStyle(toast).visibility === 'hidden') return [];
    const box = toast.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
      .filter(element => !toast.contains(element) && element.tabIndex >= 0 && element.checkVisibility({ visibilityProperty: true }))
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top; })
      .map(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? element.tagName);
  });
  const showView = async (page: Page, name: string) => {
    await page.getByRole('button', { name: /^Workspace view: / }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };

  test('beside an inspector drawer with too little room left of it, the notice steps aside, and is back unannounced when the drawer closes or the window grows', async ({ page }) => {
    // The minimum window with the widest sidebar: under 180px would be left beside the drawer.
    await page.setViewportSize({ width: 860, height: 820 });
    await page.addInitScript(() => { localStorage.setItem('pandacode.sidebarWidth', '440'); localStorage.setItem('pandacode.inspectorWidth', '400'); });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast'), inspector = page.locator('#inspector');
    const toggle = page.getByRole('button', { name: 'Toggle inspector', exact: true }).first();
    if (await inspector.isVisible()) await toggle.click();
    await expect(inspector).toBeHidden();
    await clearOfComposer(page);
    const text = await toast.textContent();
    await toggle.click();
    await expect(inspector).toBeVisible();
    const [pane, drawer] = await Promise.all([page.locator('.main-pane').boundingBox(), inspector.boundingBox()]);
    expect(drawer!.x - pane!.x).toBeLessThan(180 + 16);
    await expect(toast).toBeHidden();
    expect(await coveredControls(page)).toEqual([]);
    await expect(toast).toHaveAttribute('aria-live', 'off');
    // The drawer covers the dock's toggle at this width: its own Hide inspector closes it.
    await inspector.getByRole('button', { name: 'Hide inspector', exact: true }).click();
    await expect(inspector).toBeHidden();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(text!);
    await expect(toast).toHaveAttribute('aria-live', 'off');
    await clearOfComposer(page);
    // Room returns: at 1300px the inspector is a column beside the pane, and the notice sits clear of it.
    await toggle.click();
    await expect(toast).toBeHidden();
    await page.setViewportSize({ width: 1300, height: 820 });
    await expect(toast).toBeVisible();
    await clearOfPanels(page);
  });

  test('Settings: the notice steps aside while it is open, covering none of its controls, and is back as it was after', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 820 });
    await longCrash(page);
    await page.goto('/');
    await ready(page);
    const toast = page.locator('#toast');
    await clearOfComposer(page);
    const text = await toast.textContent();
    await openGeneral(page);
    // At this width the window's corner holds the restart switch and Show latest crash report.
    await expect(page.locator('#crash-restart-settings').getByRole('button', { name: SHOW_LATEST, exact: true })).toBeVisible();
    await expect(toast).toBeHidden();
    expect(await coveredControls(page)).toEqual([]);
    await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('button', { name: 'Back' }).first().click();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText(text!);
    await clearOfComposer(page);
  });

  for (const [view, scroller] of [['Board', '#project-board .board-columns'], ['GitHub', '#github-hub .gh-body']] as const) {
    test(`${view} view: the notice covers none of its controls, and its list gets room to scroll clear`, async ({ page }) => {
      await page.setViewportSize({ width: 1300, height: 820 });
      await longCrash(page);
      await page.goto('/');
      await ready(page);
      await showView(page, view);
      const toast = page.locator('#toast');
      await expect(page.locator(scroller)).toBeVisible();
      await expect(toast).toBeVisible();
      await expect.poll(() => coveredControls(page)).toEqual([]);
      await expect.poll(() => page.locator(scroller).evaluate(element => (element as HTMLElement).style.getPropertyValue('--toast-room'))).not.toBe('');
      // Back in the conversation the room goes with the view.
      await showView(page, 'Conversation');
      await clearOfComposer(page);
      await expect.poll(() => page.locator(scroller).evaluate(element => (element as HTMLElement).style.getPropertyValue('--toast-room'))).toBe('');
    });
  }
});

test.describe('crash recovery settings', () => {
  test('the switch is on by default, described like its neighbours, and saves both ways', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    const toggle = page.getByRole('switch', { name: SWITCH, exact: true });
    await expect(toggle).toBeChecked();
    const about = page.locator('#crash-restart-settings small#crash-restart-about');
    await expect(about).toBeVisible();
    await expect(about).toHaveText(DETAIL);
    await expect(toggle).toHaveAccessibleDescription(DETAIL);
    // Kept drafts are a plain note under the group (nothing to set), not a row without a control.
    const drafts = page.locator('#crash-restart-settings small#crash-drafts-note');
    await expect(drafts).toBeVisible();
    await expect(drafts).toHaveText(DRAFTS);
    await expect(page.locator('#crash-restart-settings .setting-row', { hasText: 'Unsent messages' })).toHaveCount(0);
    // The reports row says once that reports stay here, warns what they hold, and how to report a problem.
    const reports = page.locator('#crash-reports-about');
    await expect(reports).toHaveText(REPORTS_DETAIL);
    await expect(page.locator('#crash-restart-settings').getByRole('button', { name: SHOW_LATEST, exact: true })).toHaveAccessibleDescription(REPORTS_DETAIL);
    await expect(page.locator('#crash-restart-settings')).toContainText('on this computer', { useInnerText: true });
    expect((await page.locator('#crash-restart-settings').innerText()).match(/on this computer/g)).toHaveLength(1);
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as CrashWindow).__crashRestartEnabled)).toBe(false);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as CrashWindow).__crashRestartEnabled)).toBe(true);
  });

  test('Show latest crash report reveals this launch\'s or the newest report, says so plainly when there is none, and shows errors', async ({ page }) => {
    // Waits for the no-reports line to clear itself.
    test.setTimeout(45_000);
    await page.addInitScript(() => { (window as Window & { __crashNoReport?: boolean }).__crashNoReport = true; });
    await failing(page, { crash_report_reveal: 0 });
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    const reveal = page.locator('#crash-restart-settings').getByRole('button', { name: SHOW_LATEST, exact: true });
    await expect(reveal).toHaveClass(/\bds-btn\b/);
    await reveal.click();
    await expect(page.locator('#crash-restart-settings [role="status"]')).toHaveText('There are no crash reports on this computer.');
    await expect(page.locator('#crash-restart-settings [role="alert"]')).toBeHidden();
    // The line clears itself after a short while.
    await expect(page.locator('#crash-restart-settings [role="status"]')).toBeHidden({ timeout: 8000 });
    await page.evaluate(() => {
      const w = window as Window & { __crashNoReport?: boolean; __crashFailCommands?: Record<string, number> };
      w.__crashNoReport = false; w.__crashFailCommands = { crash_report_reveal: 1 };
    });
    await reveal.click();
    await expect(page.locator('#crash-restart-settings [role="alert"]')).toHaveText('Could not show the crash report: crash_report_reveal failed in the preview');
    await expect(page.locator('#crash-restart-settings [role="status"]')).toBeHidden();
    await reveal.click();
    await expect.poll(async () => (await calls(page, 'crash_report_reveal')).length).toBe(3);
    await expect(page.locator('#crash-restart-settings [role="alert"]')).toBeHidden();
  });

  test('Clear saved drafts removes every stored draft, leaves the open composer\'s text on screen unstored until its next edit, and says so', async ({ page }) => {
    const draft = (text: string) => JSON.stringify({ t: Date.now(), text });
    await leftOver(page, { 'pandacode.draft:session-2': draft('a pasted secret'), 'pandacode.draft:new:project-1': draft('a New task'), 'pandacode.draft:channel:c1': draft('channel text') });
    await page.goto('/');
    await ready(page);
    const prompt = page.locator('#prompt');
    await prompt.fill('still on screen');
    const draftKeys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.draft:')).sort());
    await expect.poll(draftKeys).toContain('pandacode.draft:session-1');
    await openGeneral(page);
    const clear = page.locator('#crash-restart-settings').getByRole('button', { name: CLEAR_DRAFTS, exact: true });
    await expect(clear).toHaveClass(/\bds-btn\b/);
    await expect(clear).toHaveAccessibleDescription(DRAFTS);
    await clear.click();
    await expect(page.locator('#toast')).toHaveText('Saved drafts cleared.');
    expect(await draftKeys()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveValue('still on screen');
    // Another thread's draft is gone from memory too.
    await page.locator('.task-item', { hasText: 'Refine the navigation' }).click();
    await expect(selected(page)).toContainText('Refine the navigation');
    await expect(prompt).toHaveValue('');
    await page.locator('.task-item', { hasText: 'Make search feel instant' }).click();
    await expect(prompt).toHaveValue('still on screen');
    expect(await draftKeys()).toEqual([]);
    // Stored again on its next edit.
    await prompt.press('End'); await prompt.press('!');
    await expect.poll(draftKeys).toEqual(['pandacode.draft:session-1']);
  });

  test('Keep unsent drafts off stops storing them and removes the stored ones; on again, they are stored from the next edit', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const prompt = page.locator('#prompt');
    const draftKeys = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pandacode.draft:')));
    await prompt.fill('a pasted secret');
    await expect.poll(draftKeys).toEqual(['pandacode.draft:session-1']);
    await openGeneral(page);
    const keep = page.getByRole('switch', { name: KEEP_DRAFTS, exact: true });
    const note = page.locator('#crash-restart-settings small#crash-drafts-note');
    await expect(keep).toBeChecked();
    await expect(keep).toHaveAccessibleDescription(DRAFTS);
    await keep.click();
    await expect(keep).not.toBeChecked();
    await expect(note).toHaveText(DRAFTS_OFF);
    await expect(keep).toHaveAccessibleDescription(DRAFTS_OFF);
    expect(await draftKeys()).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveValue('a pasted secret');
    await prompt.press('End'); await prompt.press('!');
    await page.reload();
    await ready(page);
    await expect(prompt).toHaveValue('');
    expect(await draftKeys()).toEqual([]);
    await openGeneral(page);
    await expect(keep).not.toBeChecked();
    await keep.click();
    await expect(note).toHaveText(DRAFTS);
    await page.keyboard.press('Escape');
    await prompt.fill('kept again');
    await expect.poll(draftKeys).toEqual(['pandacode.draft:session-1']);
    await page.reload();
    await ready(page);
    await expect(prompt).toHaveValue('kept again');
  });

  test('Settings search finds Keep unsent drafts and Clear saved drafts by "drafts"', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.keyboard.press('Meta+K');
    await page.locator('#command-query').fill('clear saved drafts');
    await expect(page.locator('#command-results').getByRole('button', { name: /Settings › General/ })).toBeVisible();
    await page.locator('#command-query').fill('keep unsent drafts');
    await expect(page.locator('#command-results').getByRole('button', { name: /Settings › General/ })).toBeVisible();
    await page.locator('#command-query').fill('drafts');
    await page.locator('#command-results').getByRole('button', { name: /Settings › General/ }).click();
    await expect(page.locator('#crash-restart-settings').getByRole('button', { name: CLEAR_DRAFTS, exact: true })).toBeVisible();
    await expect(page.locator('#crash-restart-settings').getByRole('switch', { name: KEEP_DRAFTS, exact: true })).toBeVisible();
  });

  test('the command palette finds Settings › General by crash words', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.keyboard.press('Meta+K');
    await page.locator('#command-query').fill('crash');
    await expect(page.locator('#command-results').getByRole('button', { name: /Settings › General/ })).toBeVisible();
    // And where the kept-drafts note lives, by its words.
    await page.locator('#command-query').fill('unsent messages');
    await expect(page.locator('#command-results').getByRole('button', { name: /Settings › General/ })).toBeVisible();
  });

  test('it shows the stored choice', async ({ page }) => {
    await page.addInitScript(() => { (window as CrashWindow).__crashRestartEnabled = false; });
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    await expect(page.getByRole('switch', { name: SWITCH, exact: true })).not.toBeChecked();
  });

  test('a rejected save puts the switch back and shows the error', async ({ page }) => {
    await failing(page, { set_crash_restart_enabled: 1 });
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    const toggle = page.getByRole('switch', { name: SWITCH, exact: true });
    await toggle.click();
    const alert = page.locator('#crash-restart-settings [role="alert"]');
    await expect(alert).toHaveText('Could not change automatic restarts: set_crash_restart_enabled failed in the preview');
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    // The next try succeeds and clears the error.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(alert).toBeHidden();
  });

  test('until the first read answers, the switch is disabled and shows no state, so a stored off never flashes on', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as Window & { __crashGates?: Record<string, Promise<void>>; __openGate?: () => void; __crashRestartEnabled?: boolean };
      w.__crashRestartEnabled = false;
      w.__crashGates = { crash_restart_enabled: new Promise<void>(resolve => { w.__openGate = resolve; }) };
    });
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    const toggle = page.getByRole('switch', { name: SWITCH, exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    // No knob while it loads: neither on nor off.
    expect(await toggle.evaluate(node => getComputedStyle(node, '::before').opacity)).toBe('0');
    // Focusable (Crash settings lands on it), but a click or Space changes nothing until it has loaded.
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await toggle.click({ force: true });
    await expect(toggle).not.toBeChecked();
    expect(await calls(page, 'set_crash_restart_enabled')).toHaveLength(0);
    await page.evaluate(() => (window as Window & { __openGate?: () => void }).__openGate?.());
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toHaveAttribute('aria-busy');
    await expect(toggle).not.toBeChecked();
  });

  test('a failed read keeps the default and says so', async ({ page }) => {
    await failing(page, { crash_restart_enabled: 1 });
    await page.goto('/');
    await ready(page);
    await openGeneral(page);
    await expect(page.locator('#crash-restart-settings [role="alert"]')).toHaveText('Could not read the automatic restart setting: crash_restart_enabled failed in the preview');
    await expect(page.getByRole('switch', { name: SWITCH, exact: true })).toBeChecked();
    await expect(page.getByRole('switch', { name: SWITCH, exact: true })).toBeEnabled();
  });
});

launchRestoreTests();
