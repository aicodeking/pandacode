import { expect, test, type Locator, type Page } from '@playwright/test';

// The Google Colab runtime pip over the first preview thread (src/colab-pip.ts). Runtimes are seeded with
// window.__previewColabRuntime(sessionId, runtimes), which stores them and sends `colab-runtime`;
// window.__previewColabCalls records every command the pip made.
const errors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

type Runtime = {
  id: string; endpoint: string; name: string; hardware: string; highMem: boolean; state: string; activity: string | null;
  browserUrl: string | null; startedAt: number; busySince: number | null; error: string | null;
};
const MINUTE = 60_000;
const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'colab:gpu-t4-s-abc', endpoint: 'gpu-t4-s-abc', name: 'pandacode-t4', hardware: 'T4 GPU', highMem: false, state: 'ready', activity: null,
  browserUrl: 'https://colab.research.google.com/drive/preview', startedAt: Date.now() - 8 * MINUTE - 5000, busySince: null, error: null, ...over,
});
async function open(page: Page, query = ''): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto(`/${query}`);
  // The first load compiles the app; on a busy machine that outlasts the default wait.
  await expect(page.locator('#prompt')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.task-item[data-id="session-1"]')).toBeVisible({ timeout: 30_000 });
}
/** Seeds a thread's runtimes, and waits for the pip's module (loaded by the first event) to have asked for its list. */
async function seed(page: Page, runtimes: Runtime[], sessionId = 'session-1'): Promise<void> {
  await page.evaluate(([id, list]) => { (window as any).__previewColabRuntime(id, list); }, [sessionId, runtimes] as const);
  await page.waitForFunction(() => ((window as any).__previewColabCalls ?? []).length > 0, null, { timeout: 30_000 });
}
const calls = (page: Page) => page.evaluate(() => ((window as any).__previewColabCalls ?? []) as { command: string; sessionId: string; endpoint?: string; action?: string; refresh?: boolean }[]);
const pip = (page: Page) => page.locator('#colab-pip');
const pill = (page: Page) => page.locator('#colab-pip .cp-pill');
const card = (page: Page) => page.locator('#colab-pip .cp-card');
const rows = (page: Page) => card(page).locator('.cp-runtime');
/** The composer's live region, which the pip speaks through: it stays mounted while the pip is hidden. */
const spoken = (page: Page) => page.locator('#composer-live');
/** A theme token's computed colour inside the pip, to compare with what an element paints. */
const token = (page: Page, name: string) => pip(page).evaluate((root, name) => {
  const probe = document.createElement('i'); probe.style.color = `var(${name})`; root.append(probe);
  const colour = getComputedStyle(probe).color; probe.remove(); return colour;
}, name);
const colour = (target: Locator, property: 'color' | 'backgroundColor' = 'color') => target.evaluate((el, property) => getComputedStyle(el)[property], property);
const box = async (target: Locator) => (await target.boundingBox())!;
const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
/** The thread's first message, scrolled to the top, starts below the pip's pill. */
const firstMessageClear = async (page: Page) => {
  const [mine, message] = [await box(pill(page)), await box(page.locator('#transcript .message').first())];
  return message.y >= mine.y + mine.height ? 'clear' : `pill ${JSON.stringify(mine)} covers the first message ${JSON.stringify(message)}`;
};
/** Every finite animation has finished (the state pulse keeps looping). */
const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.timeline !== document.timeline || a.effect?.getTiming().iterations === Infinity));

test('colab-pip stays hidden, and its module unloaded, while the thread has no Colab runtimes', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', request => { if (/colab-pip/.test(request.url())) loaded.push(request.url()); });
  await open(page);
  await expect(page.locator('#transcript .message').first()).toBeVisible();
  await expect(pip(page)).toBeHidden();
  await expect(pip(page)).toHaveAttribute('aria-label', 'Google Colab runtimes');
  expect(await pip(page).evaluate(el => el.childElementCount)).toBe(0);
  expect(loaded).toEqual([]);
  expect((await calls(page)).length).toBe(0);
  // The first `colab-runtime` event loads it. A runtime of another thread does not show here.
  await seed(page, [runtime()], 'session-2');
  expect(loaded.length).toBeGreaterThan(0);
  await expect.poll(async () => (await calls(page)).some(call => call.command === 'cloud_colab_thread_runtimes' && call.sessionId === 'session-1')).toBe(true);
  await expect(pip(page)).toBeHidden();
  // An empty list hides it again.
  await seed(page, [runtime()]);
  await expect(pill(page)).toBeVisible();
  await seed(page, []);
  await expect(pip(page)).toBeHidden();
  await expect(pill(page)).toHaveCount(0);
});

test('colab-pip appears as a pill when a runtime starts, and follows it to ready and busy', async ({ page }) => {
  await open(page);
  const transcript = await box(page.locator('#transcript'));
  await seed(page, [runtime({ id: 'colab:pending-1', endpoint: '', state: 'creating', activity: 'Allocating T4 GPU…', browserUrl: null, startedAt: Date.now() - 3000 })]);
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · T4 GPU');
  await expect(pill(page).locator('.cp-activity')).toHaveText('Allocating T4 GPU…');
  await expect(pill(page).locator('.cp-clock')).toHaveText(/^0:\d\d$/);
  await expect(pill(page)).toHaveAttribute('aria-label', /Colab · T4 GPU, Allocating T4 GPU…/);
  // The dot is the info tone, breathing with the shared state pulse; the glyph takes the remote tint.
  const dot = pill(page).locator('.cp-dot');
  expect(await colour(dot, 'backgroundColor')).toBe(await token(page, '--ds-info'));
  expect(await dot.evaluate(el => getComputedStyle(el).animationName)).toBe('state-pulse');
  expect(await colour(pill(page).locator('.cp-glyph'))).toBe(await token(page, '--ds-tone-remote'));
  expect(await pill(page).locator('.cp-clock').evaluate(el => getComputedStyle(el).fontVariantNumeric)).toContain('tabular-nums');
  // It floats: the transcript keeps its box.
  expect(await box(page.locator('#transcript'))).toEqual(transcript);

  await seed(page, [runtime()]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Ready');
  await expect(pill(page).locator('.cp-clock')).toHaveText('8m');
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Ready · 8m. Show details');
  expect(await colour(dot, 'backgroundColor')).toBe(await token(page, '--ds-success'));
  expect(await dot.evaluate(el => getComputedStyle(el).animationName)).toBe('none');

  await seed(page, [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() - 18_000 })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running train.py');
  const clock = pill(page).locator('.cp-clock');
  await expect(clock).toHaveText(/^0:(1[89]|[2-5]\d)$/);
  // The clock is live: it moves on by itself, a second at a time.
  const first = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 4000 }).not.toBe(first);
  expect(await colour(dot, 'backgroundColor')).toBe(await token(page, '--ds-info'));

  // High-RAM shortens the hardware; a stopped runtime is muted, still and has no clock.
  await seed(page, [runtime({ highMem: true })]);
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · T4 · High-RAM');
  await seed(page, [runtime({ state: 'stopped' })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Stopped');
  await expect(clock).toBeHidden();
  expect(await colour(dot, 'backgroundColor')).toBe(await token(page, '--muted'));
});

test('colab-pip expands to a card with chips, uptime and actions, and Stop asks before stopping', async ({ page }) => {
  await open(page);
  // Restarting and Stopping last long enough here to be looked at.
  await page.evaluate(() => { (window as any).__colabRuntimeStepMs = 1500; });
  await seed(page, [runtime({ highMem: true })]);
  // Collapsed, the card is not in the page, so the pill points at nothing: aria-expanded says it opens something.
  await expect(pill(page)).not.toHaveAttribute('aria-controls');
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('id', 'colab-pip-card');
  await expect(pill(page)).toHaveCount(0);
  await expect(card(page).getByRole('heading', { name: 'Google Colab' })).toBeVisible();
  await expect(card(page).locator('.cp-count')).toHaveCount(0);
  const collapse = card(page).getByRole('button', { name: 'Collapse Google Colab runtimes' });
  // Its name already says what it does; it carries no expanded state of its own.
  await expect(collapse).not.toHaveAttribute('aria-expanded');
  await expect(collapse).not.toHaveAttribute('aria-controls');
  await expect(collapse).toBeFocused();
  const row = rows(page).first();
  await expect(rows(page)).toHaveCount(1);
  await expect(row.locator('.cp-name')).toHaveText('pandacode-t4');
  await expect(row.locator('.cp-chip')).toHaveText(['T4 GPU', 'High-RAM']);
  await expect(row.locator('.cp-activity')).toHaveText('Ready');
  await expect(row.locator('.cp-clock')).toHaveText('8m');
  await expect(row.getByRole('button')).toHaveText(['Open in Colab', 'Restart kernel', 'Stop']);
  await still(page);
  expect(await card(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');

  await row.getByRole('button', { name: 'Open in Colab' }).click();
  await expect.poll(async () => (await calls(page)).filter(call => call.action === 'open_browser')).toEqual([{ command: 'cloud_colab_runtime_action', sessionId: 'session-1', endpoint: 'gpu-t4-s-abc', action: 'open_browser' }]);

  // Restarting the kernel asks first too, in the row: Cancel and Escape each back out to Restart kernel.
  const restart = row.getByRole('button', { name: 'Restart kernel' });
  const restartQuestion = 'Restart kernel? Running work stops and variables are lost.';
  const asking = row.getByRole('group', { name: 'Restart kernel of pandacode-t4' });
  await restart.focus();
  await page.keyboard.press('Enter');
  await expect(asking.locator('.cp-confirm-text')).toHaveText(restartQuestion);
  await expect(asking.getByRole('button')).toHaveText(['Cancel', 'Restart']);
  await expect(asking.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(asking.getByRole('button', { name: 'Cancel' })).toHaveAccessibleDescription(restartQuestion);
  await expect(asking.getByRole('button', { name: 'Restart', exact: true })).toHaveClass(/is-danger/);
  await expect(row.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(asking).toHaveCount(0);
  await expect(restart).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(asking.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(asking).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(restart).toBeFocused();
  expect((await calls(page)).some(call => call.action === 'restart_kernel')).toBe(false);
  // Confirmed: the control waits (aria-disabled) while the kernel restarts, and keeps focus throughout.
  await page.keyboard.press('Enter');
  await asking.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(row.locator('.cp-activity')).toHaveText('Restarting kernel…');
  await expect(row).toHaveAttribute('data-runtime', 'restarting');
  await expect(restart).toHaveAttribute('aria-disabled', 'true');
  await expect(restart).toHaveAttribute('aria-busy', 'true');
  await expect(restart).toBeFocused();
  await expect(row.locator('.cp-activity')).toHaveText('Ready');
  await expect(restart).toBeFocused();
  await expect(restart).not.toHaveAttribute('aria-disabled', 'true');
  expect((await calls(page)).some(call => call.action === 'restart_kernel' && call.endpoint === 'gpu-t4-s-abc')).toBe(true);

  // Stop asks first, in the row, and says what is lost; Cancel, which takes focus, reads the question out and keeps the runtime.
  await row.getByRole('button', { name: 'Stop' }).click();
  const confirm = row.getByRole('group', { name: 'Stop pandacode-t4' });
  await expect(confirm.locator('.cp-confirm-text')).toHaveText('Stop runtime? Running work stops, and unsaved files and kernel state are lost.');
  await expect(confirm.getByRole('button')).toHaveText(['Cancel', 'Stop']);
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toHaveAccessibleDescription('Stop runtime? Running work stops, and unsaved files and kernel state are lost.');
  await expect(row.getByRole('button', { name: 'Restart kernel' })).toHaveCount(0);
  expect((await calls(page)).some(call => call.action === 'stop')).toBe(false);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Stop' })).toBeFocused();
  await expect(rows(page)).toHaveCount(1);
  expect((await calls(page)).some(call => call.action === 'stop')).toBe(false);

  // Confirming stops it: it passes through Stopping (the pip's one word for it) and the pip goes with its last runtime.
  await row.getByRole('button', { name: 'Stop' }).click();
  await confirm.getByRole('button', { name: 'Stop' }).click();
  await expect(row.locator('.cp-activity')).toHaveText('Stopping…');
  // Focus stays on Stop, which waits, in the row that was asked about: it does not jump to the card's header.
  await expect(row.getByRole('button', { name: 'Stop' })).toBeFocused();
  await expect(row.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-busy', 'true');
  await expect(collapse).not.toBeFocused();
  // The row keeps its shape while it goes: every action waits.
  expect(await row.getByRole('button').evaluateAll(buttons => buttons.map(b => `${b.textContent}:${b.getAttribute('aria-disabled')}`))).toEqual(['Open in Colab:true', 'Restart kernel:true', 'Stop:true']);
  await expect(row.getByRole('button', { name: 'Stop' })).toBeFocused();
  await expect(pip(page)).toBeHidden();
  // With the pip gone the composer has focus, and the live region outside it says what happened.
  await expect(page.locator('#prompt')).toBeFocused();
  await expect(spoken(page)).toHaveText('pandacode-t4 stopped');
  expect((await calls(page)).filter(call => call.action === 'stop')).toEqual([{ command: 'cloud_colab_runtime_action', sessionId: 'session-1', endpoint: 'gpu-t4-s-abc', action: 'stop' }]);
});

test('colab-pip shows an error in the danger tone, and Dismiss clears it', async ({ page }) => {
  await open(page);
  const failed = runtime({ state: 'error', error: 'The kernel died: CUDA out of memory.', activity: null });
  await seed(page, [failed]);
  const danger = await token(page, '--ds-danger');
  expect(await colour(pill(page).locator('.cp-dot'), 'backgroundColor')).toBe(danger);
  // The pill says it is an error in words, not only in the danger tone.
  await expect(pill(page).locator('.cp-activity')).toHaveText('Error: The kernel died: CUDA out of memory.');
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Error: The kernel died: CUDA out of memory. Show details');
  expect(await colour(pill(page).locator('.cp-activity'))).toBe(danger);
  await expect(pill(page).locator('.cp-clock')).toBeHidden();

  await pill(page).click();
  const row = rows(page).first();
  await expect(row.locator('.cp-activity')).toHaveText('Error');
  await expect(row.locator('.cp-error')).toHaveText('The kernel died: CUDA out of memory.');
  expect(await colour(row.locator('.cp-error'))).toBe(danger);
  expect(await colour(row.locator('.cp-dot'), 'backgroundColor')).toBe(danger);
  // A runtime that still exists can be restarted or stopped; one that never started can only be dismissed.
  await expect(row.getByRole('button')).toHaveText(['Open in Colab', 'Restart kernel', 'Stop', 'Dismiss']);
  await seed(page, [runtime({ id: 'colab:pending-2', endpoint: '', browserUrl: null, state: 'error', error: 'Colab has no A100 GPU free right now.', hardware: 'A100 GPU' })]);
  await expect(row.locator('.cp-error')).toHaveText('Colab has no A100 GPU free right now.');
  await expect(row.getByRole('button')).toHaveText(['Dismiss']);
  // A stopped runtime has nothing left to open in Colab, whatever address it had.
  await seed(page, [runtime({ state: 'stopped' })]);
  await expect(row.locator('.cp-activity')).toHaveText('Stopped');
  await expect(row.getByRole('button')).toHaveText(['Dismiss']);
  await seed(page, [runtime({ id: 'colab:pending-2', endpoint: '', browserUrl: null, state: 'error', error: 'Colab has no A100 GPU free right now.', hardware: 'A100 GPU' })]);

  await row.getByRole('button', { name: 'Dismiss' }).click();
  await expect(pip(page)).toBeHidden();
  expect((await calls(page)).filter(call => call.action === 'dismiss')).toEqual([{ command: 'cloud_colab_runtime_action', sessionId: 'session-1', endpoint: 'colab:pending-2', action: 'dismiss' }]);
});

test('colab-pip: a failed action says so in a toast and keeps the runtime', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  await pill(page).click();
  await page.evaluate(() => { (window as any).__colabRuntimeFail = true; });
  await rows(page).first().getByRole('button', { name: 'Restart kernel' }).click();
  await rows(page).first().getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Could not restart the kernel. Colab did not answer. Try again.');
  await rows(page).first().getByRole('button', { name: 'Stop' }).click();
  await rows(page).first().getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#toast')).toContainText('Could not stop the runtime. Colab did not answer. Try again.');
  await expect(rows(page).first().getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(rows(page).first().getByRole('button', { name: 'Restart kernel' })).not.toHaveAttribute('aria-disabled', 'true');
  await card(page).getByRole('button', { name: 'Refresh runtimes' }).click();
  await expect(page.locator('#toast')).toContainText('Could not refresh the Colab runtimes.');
  await expect(card(page).getByRole('button', { name: 'Refresh runtimes' })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(rows(page)).toHaveCount(1);
});

test('colab-pip: Escape collapses the card to the pill and restores focus; a click outside collapses too', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  await pill(page).focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  // Refresh asks the backend again, with `refresh`.
  await card(page).getByRole('button', { name: 'Refresh runtimes' }).click();
  await expect.poll(async () => (await calls(page)).some(call => call.command === 'cloud_colab_thread_runtimes' && call.refresh === true)).toBe(true);
  await expect(card(page).getByRole('button', { name: 'Refresh runtimes' })).not.toHaveAttribute('aria-disabled', 'true');

  // Escape first backs out of the Stop question, then collapses.
  await rows(page).first().getByRole('button', { name: 'Stop' }).click();
  await expect(card(page).locator('.cp-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page).locator('.cp-confirm')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(rows(page).first().getByRole('button', { name: 'Stop' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toBeFocused();
  await expect(pill(page)).toHaveAttribute('aria-expanded', 'false');
  expect((await calls(page)).some(call => call.action === 'stop')).toBe(false);

  // The collapse button does the same; an IME's committing Enter/Escape is not the pip's.
  await pill(page).click();
  await card(page).evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })));
  await expect(card(page)).toBeVisible();
  await card(page).getByRole('button', { name: 'Collapse Google Colab runtimes' }).click();
  await expect(pill(page)).toBeFocused();

  // A click elsewhere collapses it and leaves focus where the click put it.
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await page.locator('#prompt').click();
  await expect(card(page)).toHaveCount(0);
  await expect(pill(page)).toBeVisible();
  await expect(page.locator('#prompt')).toBeFocused();
  // So does one on the thread, and the pill does not take focus for itself.
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await page.locator('#transcript .message').first().click({ position: { x: 6, y: 6 } });
  await expect(card(page)).toHaveCount(0);
  await expect(pill(page)).not.toBeFocused();
});

test('colab-pip keeps each thread\'s runtimes to that thread, and counts several', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  await seed(page, [runtime({ id: 'colab:gpu-a100-xyz', endpoint: 'gpu-a100-xyz', name: 'trainer', hardware: 'A100 GPU' })], 'session-4');
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · T4 GPU');
  await pill(page).click();
  await expect(card(page)).toBeVisible();

  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · A100 GPU');
  // A switch starts collapsed.
  await expect(card(page)).toHaveCount(0);
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(pip(page)).toBeHidden();
  // An event for a thread that is not open changes nothing here.
  await seed(page, [runtime({ state: 'busy', activity: 'Running eval.py', busySince: Date.now() })]);
  await expect(pip(page)).toBeHidden();

  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running eval.py');
  // Several runtimes: the pill counts them and speaks for the one at work; the card lists each.
  await seed(page, [runtime(), runtime({ id: 'colab:tpu-v5e-1', endpoint: 'tpu-v5e-1', name: 'sweep', hardware: 'v5e-1 TPU', state: 'busy', activity: 'Running shell command', busySince: Date.now() - 4000 })]);
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · 2 runtimes');
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running shell command');
  await expect(pill(page)).toHaveAttribute('data-runtime', 'busy');
  await pill(page).click();
  // The count is a number to the eye and "2 runtimes" to a screen reader.
  await expect(card(page).locator('.cp-count')).toHaveText('2 runtimes');
  await expect(card(page).locator('.cp-count .sr-only')).toHaveText(' runtimes', { useInnerText: false });
  await expect(card(page).locator('.cp-count')).not.toHaveAttribute('aria-label');
  await expect(rows(page).locator('.cp-name')).toHaveText(['pandacode-t4', 'sweep']);
  // Stopping one leaves the other, and the card open. The first row is the same element throughout.
  await rows(page).first().evaluate(el => { (window as any).__cpFirstRow = el; });
  await rows(page).nth(1).getByRole('button', { name: 'Stop' }).click();
  await rows(page).nth(1).getByRole('button', { name: 'Stop' }).click();
  await expect(rows(page).nth(1).getByRole('button', { name: 'Stop' })).toBeFocused();
  await expect(rows(page)).toHaveCount(1);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.cp-count')).toHaveCount(0);
  expect(await rows(page).first().evaluate(el => el === (window as any).__cpFirstRow)).toBe(true);
  // The row that had focus is gone: the card's own control takes it, never the other runtime's Stop.
  await expect(card(page).getByRole('button', { name: 'Collapse Google Colab runtimes' })).toBeFocused();
});

test('colab-pip floats top right inside the pane, clear of the action dock, at desktop and narrow widths', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await open(page);
  await seed(page, [runtime(), runtime({ id: 'colab:gpu-l4-2', endpoint: 'gpu-l4-2', name: 'second', hardware: 'L4 GPU', state: 'busy', activity: 'Running train.py', busySince: Date.now() })]);
  const dock = page.locator('#action-dock'), pane = page.locator('.conversation-pane');
  await expect(pill(page)).toBeVisible();
  await expect(dock).toBeVisible();
  expect(await dock.evaluate(el => getComputedStyle(el).position)).toBe('absolute');
  const check = async (target: Locator) => {
    const [mine, theirs, around] = [await box(target), await box(dock), await box(pane)];
    expect(apart(mine, theirs), `pip ${JSON.stringify(mine)} overlaps the dock ${JSON.stringify(theirs)}`).toBe(true);
    expect(inside(mine, around), `pip ${JSON.stringify(mine)} leaves the pane ${JSON.stringify(around)}`).toBe(true);
    return { mine, theirs, around };
  };
  // Desktop: left of the dock's column, in the pane's top-right corner.
  const collapsed = await check(pill(page));
  expect(collapsed.mine.x + collapsed.mine.width).toBeLessThanOrEqual(collapsed.theirs.x - 8);
  expect(collapsed.mine.x).toBeGreaterThan(collapsed.around.x + collapsed.around.width / 2);
  expect(collapsed.mine.y - collapsed.around.y).toBeLessThan(40);
  await pill(page).click();
  await still(page);
  const expanded = await check(card(page));
  expect(expanded.mine.x + expanded.mine.width).toBeLessThanOrEqual(expanded.theirs.x - 8);
  // The card grows from the pill's top-right corner.
  expect(Math.abs(expanded.mine.x + expanded.mine.width - (collapsed.mine.x + collapsed.mine.width))).toBeLessThan(1);
  expect(Math.abs(expanded.mine.y - collapsed.mine.y)).toBeLessThan(1);
  // It is the dock's material.
  expect(await card(page).evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.borderRadius]; }))
    .toEqual(await dock.evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.borderRadius]; }));

  // A short window: the dock reaches higher, the card still clears it and stays in the pane.
  await page.setViewportSize({ width: 1100, height: 560 });
  await expect.poll(async () => { const { mine, theirs, around } = { mine: await box(card(page)), theirs: await box(dock), around: await box(pane) }; return apart(mine, theirs) && inside(mine, around); }).toBe(true);

  // ≤650px: the dock is a row in the header; the pip takes the pane's edge and still fits.
  await page.setViewportSize({ width: 620, height: 800 });
  await expect.poll(() => dock.evaluate(el => getComputedStyle(el).position)).toBe('relative');
  await expect.poll(async () => { const mine = await box(card(page)), around = await box(pane); return Math.round(around.x + around.width - (mine.x + mine.width)); }).toBe(14);
  await check(card(page));
  await page.keyboard.press('Escape');
  await check(pill(page));
});

test('colab-pip takes the other corner when the progress PiP is parked top right', async ({ page }) => {
  await page.setViewportSize({ width: 1760, height: 960 });
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: true, corner: 'tr' })));
  await open(page, '?progress');
  const progress = page.locator('#progress-pip .pp-pill');
  await expect(progress).toBeVisible();
  await seed(page, [runtime()]);
  await expect(pip(page)).toHaveAttribute('data-side', 'left');
  expect(apart(await box(pill(page)), await box(progress))).toBe(true);
  expect(apart(await box(pill(page)), await box(page.locator('#action-dock')))).toBe(true);
  const pane = await box(page.locator('.conversation-pane')), mine = await box(pill(page));
  expect(Math.round(mine.x - pane.x)).toBe(14);
  await pill(page).click();
  await still(page);
  expect(apart(await box(card(page)), await box(progress))).toBe(true);
});

test('colab-pip lets a wheel over it scroll the transcript', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  await expect(pill(page)).toBeVisible();
  const transcript = page.locator('#transcript');
  const top = () => transcript.evaluate(node => node.scrollTop);
  // Room to scroll either way, whatever the sample thread's length.
  await transcript.evaluate(node => { const room = document.createElement('div'); room.style.height = '3000px'; node.append(room); node.scrollTop = 1200; });
  await pill(page).hover();
  const before = await top();
  await page.mouse.wheel(0, -200);
  await expect.poll(top).toBeCloseTo(before - 200, 0);
  await page.mouse.wheel(0, 120);
  await expect.poll(top).toBeCloseTo(before - 80, 0);
  // Expanded, with nothing of its own to scroll, the card passes the wheel on as well.
  await pill(page).click();
  await card(page).hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(top).toBeCloseTo(before - 180, 0);
});

test('colab-pip keeps solid, legible surfaces under reduced transparency, more contrast and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await seed(page, [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() })]);
  await expect(pill(page)).toBeVisible();
  // Reduced motion: no pulse, and the card is simply there.
  expect(await pill(page).locator('.cp-dot').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await still(page);
  expect(await card(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
  const plain = await card(page).evaluate(el => { const s = getComputedStyle(el); return { blur: s.backdropFilter || (s as any).webkitBackdropFilter, outline: s.outlineStyle, fill: s.backgroundColor }; });
  expect(plain.blur).toBe('none');
  expect(plain.outline).toBe('solid');
  expect(plain.fill).toBe(await token(page, '--bg'));
});

test('colab-pip repaints in place: a row and its controls stay the same elements while the runtime works', async ({ page }) => {
  await open(page);
  const busy = (activity: string) => runtime({ state: 'busy', activity, busySince: Date.now() - 2000 });
  await seed(page, [busy('Running train.py')]);
  // Collapsed, the pill is one element across updates and keeps focus.
  await pill(page).focus();
  await pill(page).evaluate(el => { (window as any).__cpPill = el; });
  await seed(page, [runtime()]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Ready');
  expect(await pill(page).evaluate(el => el === (window as any).__cpPill)).toBe(true);
  await expect(pill(page)).toBeFocused();

  await seed(page, [busy('Running train.py')]);
  await pill(page).click();
  const row = rows(page).first(), openButton = row.getByRole('button', { name: 'Open in Colab' });
  await expect(row).toHaveAttribute('data-runtime', 'busy');
  const SELECTORS = ['.cp-card', '.cp-list', '.cp-runtime', '.cp-name', '.cp-chip', '.cp-activity', '.cp-clock', '.cp-actions', '[data-cp="open"]', '[data-cp="restart"]', '[data-cp="stop"]', '[data-cp="refresh"]', '[data-cp="collapse"]'];
  const nodes = (selectors: string[]) => selectors.map(selector => document.querySelector(`#colab-pip ${selector}`));
  await page.evaluate(`window.__cpNodes = (${nodes})(${JSON.stringify(SELECTORS)})`);
  /** Every recorded node is still the one in the pip, compared with ===. */
  const same = () => page.evaluate(`(${nodes})(${JSON.stringify(SELECTORS)}).map((el, i) => el !== null && el === window.__cpNodes[i])`);
  const all = SELECTORS.map(() => true);
  await openButton.focus();
  await page.evaluate(() => {
    const w = window as any; w.__cpChanges = [];
    // Nodes added or removed anywhere in the card: a repaint in place makes none.
    new MutationObserver(records => { for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n.nodeType === 1) w.__cpChanges.push((n as Element).className); })
      .observe(document.querySelector('#colab-pip .cp-card')!, { childList: true, subtree: true });
  });

  // busy → ready → busy, as every tool call does.
  await seed(page, [runtime()]);
  await expect(row).toHaveAttribute('data-runtime', 'ready');
  await expect(row.locator('.cp-activity')).toHaveText('Ready');
  await expect(row.locator('.cp-clock')).toHaveText('8m');
  expect(await same()).toEqual(all);
  await expect(openButton).toBeFocused();
  await seed(page, [busy('Running eval.py')]);
  await expect(row).toHaveAttribute('data-runtime', 'busy');
  await expect(row.locator('.cp-activity')).toHaveText('Running eval.py');
  await expect(row.locator('.cp-clock')).toHaveText(/^0:0\d$/);
  expect(await same()).toEqual(all);
  await expect(openButton).toBeFocused();
  // A manual refresh waits and comes back on the same button too.
  await card(page).getByRole('button', { name: 'Refresh runtimes' }).click();
  await expect.poll(async () => (await calls(page)).some(call => call.refresh === true)).toBe(true);
  await expect(card(page).getByRole('button', { name: 'Refresh runtimes' })).not.toHaveAttribute('aria-disabled', 'true');
  expect(await same()).toEqual(all);
  expect(await page.evaluate(() => (window as any).__cpChanges)).toEqual([]);

  // An error adds its line and Dismiss to the row; the controls that stay are still the same elements.
  await seed(page, [runtime({ state: 'error', error: 'The kernel died.' })]);
  await expect(row.locator('.cp-error')).toHaveText('The kernel died.');
  await expect(row.getByRole('button')).toHaveText(['Open in Colab', 'Restart kernel', 'Stop', 'Dismiss']);
  expect(await same()).toEqual(all);
  // A second runtime joins without disturbing the first row.
  await seed(page, [runtime(), runtime({ id: 'colab:tpu-v5e-1', endpoint: 'tpu-v5e-1', name: 'sweep', hardware: 'v5e-1 TPU' })]);
  await expect(rows(page)).toHaveCount(2);
  await expect(row.locator('.cp-error')).toHaveCount(0);
  await expect(row.getByRole('button')).toHaveText(['Open in Colab', 'Restart kernel', 'Stop']);
  expect(await same()).toEqual(all);
});

test('colab-pip announces what changed, once, through the live region that outlives it', async ({ page }) => {
  await open(page);
  const live = spoken(page);
  const hush = () => live.evaluate(el => { el.textContent = ''; });
  // A runtime that starts is announced as starting; the real one that takes its place, as ready.
  await seed(page, [runtime({ id: 'colab:pending-1', endpoint: '', state: 'creating', activity: 'Allocating T4 GPU…', browserUrl: null, startedAt: Date.now() - 3000 })]);
  await expect(live).toHaveText('Starting Google Colab runtime pandacode-t4');
  await expect(live).toHaveAttribute('role', 'status');
  expect(await live.evaluate(el => el.closest('#colab-pip'))).toBeNull();
  await seed(page, [runtime()]);
  await expect(live).toHaveText('Google Colab runtime pandacode-t4: Ready');

  // A tool call (ready → busy → ready) is not news.
  await hush();
  await seed(page, [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running train.py');
  await seed(page, [runtime()]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Ready');
  await seed(page, [runtime({ state: 'busy', activity: 'Running eval.py', busySince: Date.now() })]);
  await seed(page, [runtime()]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Ready');
  await expect(live).toHaveText('');
  // Coming back from a kernel restart is.
  await seed(page, [runtime({ state: 'restarting', activity: 'Restarting kernel…', busySince: Date.now() })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Restarting kernel…');
  await expect(live).toHaveText('');
  await seed(page, [runtime()]);
  await expect(live).toHaveText('pandacode-t4: Ready');

  // Several changes in one event make one message: the error's first line, and the runtime that appeared.
  await seed(page, [
    runtime({ state: 'error', error: 'The kernel died: CUDA out of memory.\nTraceback (most recent call last):\n  File "train.py", line 4' }),
    runtime({ id: 'colab:pending-2', endpoint: '', name: 'sweep', hardware: 'A100 GPU', state: 'creating', browserUrl: null, startedAt: Date.now() }),
  ]);
  await expect(live).toHaveText('pandacode-t4: error. The kernel died: CUDA out of memory. Starting Google Colab runtime sweep');
  // The same list again says nothing more.
  await hush();
  await seed(page, [
    runtime({ state: 'error', error: 'The kernel died: CUDA out of memory.\nTraceback (most recent call last):\n  File "train.py", line 4' }),
    runtime({ id: 'colab:pending-2', endpoint: '', name: 'sweep', hardware: 'A100 GPU', state: 'creating', browserUrl: null, startedAt: Date.now() }),
    runtime({ id: 'colab:cpu-1', endpoint: 'cpu-1', name: 'notes', hardware: 'CPU', state: 'busy', activity: 'Running shell command', busySince: Date.now() }),
  ]);
  await expect(live).toHaveText('Google Colab runtime notes: Running');
  // A stopped runtime, and then the removals: a failed one is dismissed, a live one stopped; the pip hides, the words stay.
  await seed(page, [
    runtime({ state: 'error', error: 'The kernel died: CUDA out of memory.' }),
    runtime({ id: 'colab:cpu-1', endpoint: 'cpu-1', name: 'notes', hardware: 'CPU', state: 'stopped' }),
    runtime({ id: 'colab:gpu-l4-2', endpoint: 'gpu-l4-2', name: 'second', hardware: 'L4 GPU' }),
  ]);
  await expect(live).toHaveText('pandacode-t4: error. The kernel died: CUDA out of memory. notes stopped. Google Colab runtime second: Ready');
  await seed(page, [runtime({ id: 'colab:cpu-1', endpoint: 'cpu-1', name: 'notes', hardware: 'CPU', state: 'stopped' })]);
  await expect(live).toHaveText('pandacode-t4 dismissed. second stopped');
  await seed(page, []);
  await expect(pip(page)).toBeHidden();
  await expect(live).toHaveText('notes dismissed');
});

test('colab-pip never overlaps a top-right progress PiP in a narrow window', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: true, corner: 'tr' })));
  await open(page, '?progress');
  // Narrow once the thread is open: at this width the sidebar the helper waits for is closed.
  await page.setViewportSize({ width: 620, height: 800 });
  const progress = page.locator('#progress-pip'), pane = page.locator('.conversation-pane');
  await expect(progress.locator('.pp-pill')).toBeVisible();
  await seed(page, [runtime(), runtime({ id: 'colab:gpu-l4-2', endpoint: 'gpu-l4-2', name: 'second', hardware: 'L4 GPU', state: 'error', error: 'The kernel died: CUDA out of memory.' })]);
  await expect(pip(page)).toHaveAttribute('data-side', 'left');
  /** The surface and the progress PiP share no pixel, and the surface stays in the pane. */
  const clear = async (target: Locator) => {
    const [mine, theirs, around] = [await box(target), await box(progress), await box(pane)];
    return apart(mine, theirs) && inside(mine, around) ? 'clear' : `pip ${JSON.stringify(mine)} against the progress PiP ${JSON.stringify(theirs)} in ${JSON.stringify(around)}`;
  };
  await expect.poll(() => clear(pill(page))).toBe('clear');
  await pill(page).click();
  await still(page);
  await expect.poll(() => clear(card(page))).toBe('clear');
  // 620px leaves room beside the PiP: the card sits on its row, no wider than the room to its left.
  const beside = { mine: await box(card(page)), theirs: await box(progress) };
  expect(beside.mine.x + beside.mine.width).toBeLessThanOrEqual(beside.theirs.x - 10 + 0.5);
  expect(Math.abs(beside.mine.y - beside.theirs.y)).toBeLessThan(40);

  // Narrower still, there is no room beside it: the card goes under the PiP, a gap below it, at the pane's edge.
  await page.setViewportSize({ width: 400, height: 800 });
  await expect.poll(async () => { const mine = await box(card(page)), theirs = await box(progress); return Math.round(mine.y - (theirs.y + theirs.height)); }).toBe(12);
  await expect.poll(() => clear(card(page))).toBe('clear');
  expect(Math.round((await box(card(page))).x - (await box(pane)).x)).toBe(14);
  // Collapsed there, the pill sits under the PiP's pill, and the thread's first message starts under both.
  await page.keyboard.press('Escape');
  await expect(pill(page)).toBeVisible();
  await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => clear(pill(page))).toBe('clear');
  await expect.poll(() => firstMessageClear(page)).toBe('clear');
  // The PiP's own card is bigger than its pill; the runtimes move down with it.
  await progress.locator('.pp-pill').click();
  await expect(progress.locator('.pp-card:not(.is-overlay)')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await still(page);
  await expect.poll(() => clear(pill(page))).toBe('clear');
  await pill(page).click();
  await still(page);
  await expect.poll(() => clear(card(page))).toBe('clear');
  // Back in a wide window it returns to the PiP's row.
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(() => clear(card(page))).toBe('clear');
  await expect.poll(async () => Math.abs((await box(card(page))).y - (await box(progress)).y) < 40).toBe(true);
});

test('colab-pip shows a long error clamped, selectable, and whole on request', async ({ page }) => {
  await open(page);
  const long = `RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 14.75 GiB total capacity; 12.01 GiB already allocated; 1.12 GiB free; 12.50 GiB reserved in total by PyTorch).\n${'  File "/content/train.py", line 88, in step\n'.repeat(6)}torch.cuda.OutOfMemoryError`;
  await seed(page, [runtime({ state: 'error', error: long })]);
  // The pill takes the first line only.
  await expect(pill(page).locator('.cp-activity')).toHaveText(/^Error: RuntimeError: CUDA out of memory\..*PyTorch\)\.$/);
  await pill(page).click();
  await still(page);
  const row = rows(page).first(), error = row.locator('.cp-error'), more = row.locator('[data-cp="error-more"]');
  const clipped = () => error.evaluate(el => el.scrollHeight > el.clientHeight + 1);
  const height = async () => (await box(error)).height;
  await expect(error).toHaveText(long, { useInnerText: false });
  // The text is all there to read: no tooltip repeats it.
  await expect(error).not.toHaveAttribute('title');
  expect(await error.evaluate(el => { const s = getComputedStyle(el); return s.userSelect === 'text' || (s as any).webkitUserSelect === 'text'; })).toBe(true);
  expect(await clipped()).toBe(true);
  await expect(more).toHaveText('Show full error');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // The toggle names the text it opens.
  await expect(error).toHaveAttribute('id', /^colab-pip-error-\d+$/);
  await expect(more).toHaveAttribute('aria-controls', (await error.getAttribute('id'))!);
  await expect(row.getByRole('button')).toHaveText(['Show full error', 'Open in Colab', 'Restart kernel', 'Stop', 'Dismiss']);
  // It can be selected and copied.
  await error.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  expect(await page.evaluate(() => getSelection()!.toString())).toContain('torch.cuda.OutOfMemoryError');

  // From the keyboard: the toggle shows it whole, keeps focus, and puts the clamp back.
  const clamped = await height();
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveText('Show less');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(more).toBeFocused();
  expect(await clipped()).toBe(false);
  expect(await height()).toBeGreaterThan(clamped + 20);
  expect(await error.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
  // The card stays in the pane; its list scrolls instead.
  expect(inside(await box(card(page)), await box(page.locator('.conversation-pane')))).toBe(true);
  // Another update of the same runtime leaves it open, on the same button.
  await more.evaluate(el => { (window as any).__cpMore = el; });
  await seed(page, [runtime({ state: 'error', error: long, activity: 'Kernel crashed' })]);
  await expect(more).toHaveText('Show less');
  expect(await more.evaluate(el => el === (window as any).__cpMore)).toBe(true);
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(more).toHaveText('Show full error');
  await expect(more).toBeFocused();
  expect(await clipped()).toBe(true);
  expect(Math.abs(await height() - clamped)).toBeLessThan(1);

  // The clamp is four lines, and the toggle is there only for text that does not fit them: four lines do, five do not.
  await seed(page, [runtime({ state: 'error', error: 'one\ntwo\nthree\nfour\nfive' })]);
  await expect(more).toHaveText('Show full error');
  await expect(more).toBeFocused();
  expect(await clipped()).toBe(true);
  await seed(page, [runtime({ state: 'error', error: 'one\ntwo\nthree\nfour' })]);
  await expect(error).toHaveText('one\ntwo\nthree\nfour', { useInnerText: false });
  await expect(more).toHaveCount(0);
  expect(await clipped()).toBe(false);
  // The toggle went while it had focus: the row's first control takes it.
  await expect(row.getByRole('button', { name: 'Open in Colab' })).toBeFocused();
  await seed(page, [runtime({ state: 'error', error: 'The kernel died.' })]);
  await expect(error).toHaveText('The kernel died.');
  await expect(more).toHaveCount(0);
});

test('colab-pip offers the whole error by whether it fits the card, not by its length', async ({ page }) => {
  await open(page);
  // 136 characters on one line: three lines of the card at its full width.
  const short = 'The runtime ran out of memory while loading the checkpoint, and the kernel was restarted by Colab before the cell could finish its work.';
  expect(short.length).toBeLessThanOrEqual(140);
  await seed(page, [runtime({ state: 'error', error: short })]);
  await pill(page).click();
  const row = rows(page).first(), error = row.locator('.cp-error'), more = row.locator('[data-cp="error-more"]');
  const clipped = () => error.evaluate(el => el.scrollHeight > el.clientHeight + 1);
  await expect(error).toHaveText(short);
  await still(page);
  expect((await box(card(page))).width).toBe(340);
  expect(await clipped()).toBe(false);
  await expect(more).toHaveCount(0);

  // In a narrow pane the card is narrow, the same text runs past four lines, and the toggle appears by itself.
  await page.setViewportSize({ width: 250, height: 800 });
  await expect.poll(async () => (await box(card(page))).width).toBeLessThan(240);
  await expect(more).toHaveText('Show full error');
  expect(await clipped()).toBe(true);
  const clamped = (await box(error)).height;
  await more.click();
  await expect(more).toHaveText('Show less');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(await clipped()).toBe(false);
  expect((await box(error)).height).toBeGreaterThan(clamped + 10);
  await expect(error).toContainText('finish its work.');
  // Wide again, it fits: no toggle is left behind, and the text is whole without one.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(more).toHaveCount(0);
  expect(await clipped()).toBe(false);
  // Collapsed and opened again at the narrow width, it is measured afresh.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 250, height: 800 });
  await pill(page).click();
  await expect(more).toHaveText('Show less');
  await more.click();
  await expect(more).toHaveText('Show full error');
  expect(await clipped()).toBe(true);
});

test('colab-pip renders HTML in a runtime\'s name, activity and error as literal text', async ({ page }) => {
  await open(page);
  const name = '<img src=x onerror="window.__xss=1">"\'&amp;', error = '<script>window.__xss=2</script><b onmouseover="window.__xss=3">bold</b> "quoted" & done';
  const hostile = (over: Partial<Runtime> = {}) => runtime({ id: 'colab:"><i id=cp-xss>', endpoint: 'ep"><i id=cp-xss2>', name, hardware: '<u>T4</u> GPU', activity: '<svg onload="window.__xss=4">', state: 'busy', busySince: Date.now(), ...over });
  await seed(page, [hostile()]);
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · <u>T4</u> GPU');
  await expect(pill(page).locator('.cp-activity')).toHaveText('<svg onload="window.__xss=4">');
  await expect(spoken(page)).toHaveText(`Google Colab runtime ${name}: Running`);
  await seed(page, [hostile({ state: 'error', error })]);
  await expect(spoken(page)).toHaveText(`${name}: error. ${error}`);
  await expect(pill(page).locator('.cp-activity')).toHaveText(`Error: ${error}`);
  await pill(page).click();
  const row = rows(page).first();
  await expect(row.locator('.cp-name')).toHaveText(name);
  await expect(row.locator('.cp-name')).toHaveAttribute('title', name);
  await expect(row.locator('.cp-chip')).toHaveText(['<u>T4</u> GPU']);
  await expect(row.locator('.cp-error')).toHaveText(error);
  await expect(row.locator('.cp-error')).not.toHaveAttribute('title');
  await expect(row).toHaveAttribute('data-id', 'colab:"><i id=cp-xss>');
  // The row's controls work with such an id: the question is asked in it, and Cancel returns to its Stop.
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(row.getByRole('group', { name: `Stop ${name}` })).toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Stop' })).toBeFocused();
  await row.getByRole('button', { name: 'Open in Colab' }).click();
  await expect.poll(async () => (await calls(page)).some(call => call.action === 'open_browser' && call.endpoint === 'ep"><i id=cp-xss2>')).toBe(true);
  // Nothing was parsed as markup, and nothing ran.
  expect(await pip(page).evaluate(root => root.querySelectorAll('img, script, b, u, i[id], svg:not(.icon)').length)).toBe(0);
  expect(await page.evaluate(() => [document.querySelector('#cp-xss'), document.querySelector('#cp-xss2'), (window as any).__xss])).toEqual([null, null, undefined]);
});

test('colab-pip pauses its clock while the window is hidden and catches up when it shows again', async ({ page }) => {
  await open(page);
  await seed(page, [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() - 5000 })]);
  const clock = pill(page).locator('.cp-clock');
  await expect(clock).toHaveText(/^0:0[5-9]$/);
  const first = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 4000 }).not.toBe(first);
  const setHidden = (hidden: boolean) => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  const frozen = await clock.textContent();
  await page.waitForTimeout(2600);
  expect(await clock.textContent()).toBe(frozen);
  // An update that lands while hidden is drawn, and still starts no ticking.
  await seed(page, [runtime({ state: 'busy', activity: 'Running eval.py', busySince: Date.now() - 30_000 })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running eval.py');
  const held = await clock.textContent();
  expect(held).toMatch(/^0:3\d$/);
  await page.waitForTimeout(2200);
  expect(await clock.textContent()).toBe(held);
  // Visible again: the clock is right at once, and runs.
  await setHidden(false);
  await expect(clock).not.toHaveText(held!, { timeout: 1500 });
  const shown = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 4000 }).not.toBe(shown);
});

test('colab-pip in forced colors greys only a stopped runtime\'s dot, not an error\'s', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await open(page);
  // Not every engine can emulate forced colors.
  test.skip(!await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'forced-colors emulation is not available here');
  const system = (name: string) => pip(page).evaluate((root, name) => { const probe = document.createElement('i'); probe.style.color = name; root.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }, name);
  await seed(page, [runtime({ state: 'error', error: 'The kernel died.' })]);
  const dot = pill(page).locator('.cp-dot');
  const [ink, grey] = [await system('CanvasText'), await system('GrayText')];
  expect(ink).not.toBe(grey);
  expect(await colour(dot, 'backgroundColor')).toBe(ink);
  await seed(page, [runtime({ state: 'stopped' })]);
  await expect(pill(page)).toHaveAttribute('data-runtime', 'stopped');
  expect(await colour(dot, 'backgroundColor')).toBe(grey);
  await pill(page).click();
  expect(await colour(rows(page).first().locator('.cp-dot'), 'backgroundColor')).toBe(grey);
  await seed(page, [runtime({ state: 'error', error: 'The kernel died.' })]);
  await expect(rows(page).first()).toHaveAttribute('data-runtime', 'error');
  expect(await colour(rows(page).first().locator('.cp-dot'), 'backgroundColor')).toBe(ink);
});

test('colab-pip keeps clear of a progress PiP in its default top-left corner, pill or card, at any width', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: true, corner: 'tl' })));
  await open(page, '?progress');
  const progress = page.locator('#progress-pip'), pane = page.locator('.conversation-pane');
  await expect(progress).toHaveAttribute('data-corner', 'tl');
  await expect(progress.locator('.pp-pill')).toBeVisible();
  await seed(page, [runtime(), runtime({ id: 'colab:gpu-l4-2', endpoint: 'gpu-l4-2', name: 'second', hardware: 'L4 GPU', state: 'error', error: 'The kernel died: CUDA out of memory.' })]);
  // It stays on its own side, left of the dock.
  await expect(pip(page)).toHaveAttribute('data-side', 'right');
  const clear = async (target: Locator) => {
    const [mine, theirs, around] = [await box(target), await box(progress), await box(pane)];
    return apart(mine, theirs) && inside(mine, around) ? 'clear' : `pip ${JSON.stringify(mine)} against the progress PiP ${JSON.stringify(theirs)} in ${JSON.stringify(around)}`;
  };
  /** How the pip sits against the PiP: on its row, or a gap under it. */
  const stance = async (target: Locator) => {
    const [mine, theirs] = [await box(target), await box(progress)];
    return Math.abs(mine.y - theirs.y) < 40 ? 'beside' : Math.round(mine.y - (theirs.y + theirs.height)) === 12 ? 'under' : `neither: ${JSON.stringify(mine)} / ${JSON.stringify(theirs)}`;
  };
  const openCard = async () => { if (await card(page).count() === 0) await pill(page).click(); await expect(card(page)).toBeVisible(); await still(page); };
  const closeCard = async () => { if (await card(page).count()) await card(page).getByRole('button', { name: 'Collapse Google Colab runtimes' }).click(); await expect(pill(page)).toBeVisible(); await still(page); };
  const progressCard = progress.locator('.pp-card:not(.is-overlay)');
  const showProgressCard = async () => { await closeCard(); await progress.locator('.pp-pill').click(); await expect(progressCard).toBeVisible(); await still(page); };
  const showProgressPill = async () => { await closeCard(); if (await progressCard.count()) await progress.getByRole('button', { name: 'Collapse visual progress' }).click(); await expect(progress.locator('.pp-pill:not(.is-overlay)')).toBeVisible(); await still(page); };
  /** Both of the pip's surfaces clear the PiP as it is now, and sit as expected. */
  const check = async (expected: 'beside' | 'under') => {
    await closeCard();
    await expect.poll(() => clear(pill(page))).toBe('clear');
    await expect.poll(() => stance(pill(page))).toBe(expected);
    await openCard();
    await expect.poll(() => clear(card(page))).toBe('clear');
    await expect.poll(() => stance(card(page))).toBe(expected);
    // Still clear of the dock, wherever that is.
    expect(apart(await box(card(page)), await box(page.locator('#action-dock')))).toBe(true);
  };

  // A wide window has room beside the PiP, pill or card.
  await check('beside');
  await showProgressCard();
  expect(Math.round((await box(progressCard)).width)).toBe(340);
  await check('beside');
  await showProgressPill();

  // 620px: beside the PiP's pill, the card no wider than the room there; under its 340px card.
  await page.setViewportSize({ width: 620, height: 900 });
  await check('beside');
  expect((await box(card(page))).x).toBeGreaterThanOrEqual((await box(progress)).x + (await box(progress)).width + 10 - 0.5);
  await showProgressCard();
  expect(Math.round((await box(progressCard)).width)).toBe(340);
  await check('under');
  await showProgressPill();

  // 400px: under either, at the full width of the pane.
  await page.setViewportSize({ width: 400, height: 900 });
  await check('under');
  expect(Math.round((await box(pane)).x + (await box(pane)).width - ((await box(card(page))).x + (await box(card(page))).width))).toBe(14);
  // Under the PiP's pill, the thread's first message starts below the pip's own pill.
  await closeCard();
  await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => firstMessageClear(page)).toBe('clear');
  await showProgressCard();
  await check('under');
  // The PiP hides (its thread view goes): the pip returns to the top of its corner.
  await showProgressPill();
  await progress.evaluate(el => { el.hidden = true; });
  await expect.poll(async () => Math.round((await box(pill(page))).y - (await box(pane)).y)).toBeLessThan(80);
  await expect.poll(() => page.locator('.conversation-pane').evaluate(el => el.style.getPropertyValue('--colab-pip-clear'))).toBe('');
});

test('colab-pip ends above a progress PiP parked in a bottom corner under it', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1760, height: 960 });
  const many = [
    runtime(),
    ...['second', 'third', 'fourth', 'fifth', 'sixth'].map((name, i) => runtime({ id: `colab:gpu-${i}`, endpoint: `gpu-${i}`, name, hardware: 'L4 GPU', state: 'error', error: 'The kernel died: CUDA out of memory.\nRestart it to continue.' })),
  ];
  const room = () => pip(page).evaluate(el => parseFloat(el.style.getPropertyValue('--cp-room')));
  const rooms: Record<string, number> = {};
  for (const corner of ['br', 'bl'] as const) {
    await page.addInitScript(corner => localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: false, corner })), corner);
    await open(page, '?progress');
    const progress = page.locator('#progress-pip'), pane = page.locator('.conversation-pane');
    await expect(progress).toHaveAttribute('data-corner', corner);
    // Its card, whatever the pane's width made it start as.
    if (await progress.locator('.pp-pill:not(.is-overlay)').count()) await progress.locator('.pp-pill').click();
    await expect(progress.locator('.pp-card:not(.is-overlay)')).toBeVisible();
    await still(page);
    await seed(page, many);
    await expect(pip(page)).toHaveAttribute('data-side', 'right');
    await pill(page).click();
    await expect(rows(page)).toHaveCount(6);
    await still(page);
    const [mine, theirs, around] = [await box(card(page)), await box(progress), await box(pane)];
    expect(apart(mine, theirs), `card ${JSON.stringify(mine)} against the progress PiP ${JSON.stringify(theirs)}`).toBe(true);
    expect(inside(mine, around)).toBe(true);
    rooms[corner] = await room();
    if (corner === 'br') {
      // Under the pip: the card stops a gap above the PiP, and its list scrolls for the rest.
      expect(mine.y + mine.height).toBeLessThanOrEqual(theirs.y - 12 + 0.5);
      expect(await card(page).locator('.cp-list').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      // The PiP's pill is shorter: the card takes the room it leaves, and still stops above it.
      await progress.getByRole('button', { name: 'Collapse visual progress' }).click();
      await expect(progress.locator('.pp-pill:not(.is-overlay)')).toBeVisible();
      await expect.poll(room).toBeGreaterThan(rooms.br + 40);
      // (Collapsing the PiP was a click outside the card.)
      await pill(page).click();
      await still(page);
      await expect.poll(async () => apart(await box(card(page)), await box(progress))).toBe(true);
      expect((await box(card(page))).y + (await box(card(page))).height).toBeLessThanOrEqual((await box(progress)).y - 12 + 0.5);
    }
  }
  // In the other bottom corner of a wide pane the PiP is not under the pip, and takes none of its room.
  expect(rooms.bl).toBeGreaterThan(rooms.br + 40);
});

test('colab-pip says nothing about the runtimes a thread already has when it opens', async ({ page }) => {
  await open(page);
  const live = spoken(page);
  const trainer = (over: Partial<Runtime> = {}) => runtime({ id: 'colab:gpu-a100-xyz', endpoint: 'gpu-a100-xyz', name: 'trainer', hardware: 'A100 GPU', ...over });
  await seed(page, [runtime()]);
  await expect(pill(page)).toBeVisible();
  await seed(page, [trainer()], 'session-4');
  // Opening a thread with a ready runtime draws the pill and leaves the live region to the thread switch.
  await live.evaluate(el => { el.textContent = ''; });
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · A100 GPU');
  await expect(pill(page).locator('.cp-activity')).toHaveText('Ready');
  await expect.poll(async () => (await calls(page)).some(call => call.command === 'cloud_colab_thread_runtimes' && call.sessionId === 'session-4')).toBe(true);
  await page.waitForTimeout(300);
  expect(await live.textContent()).not.toMatch(/Colab|trainer|pandacode-t4/);
  // What happens to it from then on is read out.
  await seed(page, [trainer({ state: 'restarting', activity: 'Restarting kernel…', busySince: Date.now() })], 'session-4');
  await expect(pill(page).locator('.cp-activity')).toHaveText('Restarting kernel…');
  await seed(page, [trainer()], 'session-4');
  await expect(live).toHaveText('trainer: Ready');
  // Back on the first thread: silent again, and its next change is announced.
  await live.evaluate(el => { el.textContent = ''; });
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(pill(page).locator('.cp-primary')).toHaveText('Colab · T4 GPU');
  await page.waitForTimeout(300);
  expect(await live.textContent()).not.toMatch(/Colab|trainer|pandacode-t4/);
  await seed(page, [runtime({ state: 'error', error: 'The kernel died.' })]);
  await expect(live).toHaveText('pandacode-t4: error. The kernel died');
});

test('colab-pip lets a runtime that is still starting be dismissed', async ({ page }) => {
  await open(page);
  const starting = (over: Partial<Runtime> = {}) => runtime({ id: 'colab:pending-1', endpoint: '', state: 'creating', activity: 'Allocating T4 GPU…', browserUrl: null, startedAt: Date.now() - 95_000, ...over });
  // One Colab has already given an endpoint is past allocation: it is stopped, not dismissed.
  await seed(page, [starting({ id: 'colab:gpu-t4-s-abc', endpoint: 'gpu-t4-s-abc' })]);
  await pill(page).click();
  const row = rows(page).first();
  await expect(row.getByRole('button')).toHaveText(['Stop']);
  // An allocation that hangs always has a way out.
  await seed(page, [starting()]);
  await expect(row.locator('.cp-activity')).toHaveText('Allocating T4 GPU…');
  await expect(row.locator('.cp-clock')).toHaveText(/^1:[3-5]\d$/);
  await expect(row.getByRole('button')).toHaveText(['Dismiss']);
  const dismiss = row.getByRole('button', { name: 'Dismiss' });
  await expect(dismiss).not.toHaveAttribute('aria-disabled', 'true');
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(pip(page)).toBeHidden();
  expect((await calls(page)).filter(call => call.action === 'dismiss')).toEqual([{ command: 'cloud_colab_runtime_action', sessionId: 'session-1', endpoint: 'colab:pending-1', action: 'dismiss' }]);
  await expect(spoken(page)).toHaveText('pandacode-t4 dismissed');
  await expect(page.locator('#prompt')).toBeFocused();
});

test('colab-pip ticks every counting runtime on its own second', async ({ page }) => {
  await open(page);
  // Two at work, half a second out of step with each other.
  const started = Date.now(), since = { first: started - 10_000, second: started - 10_500 };
  await seed(page, [
    runtime({ state: 'busy', activity: 'Running train.py', busySince: since.first }),
    runtime({ id: 'colab:gpu-l4-2', endpoint: 'gpu-l4-2', name: 'second', hardware: 'L4 GPU', state: 'busy', activity: 'Running eval.py', busySince: since.second }),
  ]);
  await pill(page).click();
  await expect(rows(page)).toHaveCount(2);
  // Sampled for three seconds: each clock shows its own whole seconds, never the other's.
  const late = await page.evaluate(async ([first, second]) => {
    const clocks = [...document.querySelectorAll<HTMLElement>('#colab-pip .cp-runtime .cp-clock')], starts = [first, second], wrong = [0, 0];
    const seconds = (text: string) => { const [m, s] = text.split(':').map(Number); return m * 60 + s; };
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      // 30 ms of grace after a second turns, for the tick to land.
      clocks.forEach((el, n) => { const age = Date.now() - starts[n]; if (age % 1000 > 30 && seconds(el.textContent ?? '') !== Math.floor(age / 1000)) wrong[n]++; });
    }
    return wrong;
  }, [since.first, since.second] as const);
  expect(late[0], `first clock late in ${late[0]} of 60 samples`).toBeLessThanOrEqual(4);
  expect(late[1], `second clock late in ${late[1]} of 60 samples`).toBeLessThanOrEqual(4);
});

test('colab-pip keeps its spoken name short, and steady while it has focus', async ({ page }) => {
  await open(page);
  // An error's first line can be a wall of text: the pill shows it cut by the layout, and reads out a sentence of it.
  const wall = `OutOfMemoryError: ${'x'.repeat(400)}`;
  await seed(page, [runtime({ state: 'error', error: `${wall}\nTraceback` })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText(`Error: ${wall}`);
  await expect(pill(page)).toHaveAttribute('aria-label', `Google Colab runtime: Colab · T4 GPU, Error: ${wall.slice(0, 200)}. Show details`);
  // A ready runtime whose ninth minute is about to turn.
  await seed(page, [runtime({ startedAt: Date.now() - 9 * MINUTE + 2500 })]);
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Ready · 8m. Show details');
  await pill(page).focus();
  await expect(pill(page).locator('.cp-clock')).toHaveText('9m', { timeout: 8000 });
  // The clock moved on; the focused pill's name did not, so it is not read out again each minute.
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Ready · 8m. Show details');
  await expect(pill(page)).toBeFocused();
  // Without focus the next tick brings the name up to date.
  await page.locator('#prompt').focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Ready · 9m. Show details');
});

test('colab-pip fades out as it goes, in a shell nothing can reach, and a runtime that arrives ends the fade', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  const ghost = page.locator('.conversation-pane > .cp-ghost');
  /** The shell as it is: where it is, what it holds, and whether anything in it can be reached. */
  const shell = () => ghost.evaluate(el => {
    const box = el.firstElementChild!.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      holds: el.firstElementChild!.className.split(' ')[0], inert: el.hasAttribute('inert'), hidden: el.getAttribute('aria-hidden'), pointer: getComputedStyle(el).pointerEvents,
      ids: el.id + [...el.querySelectorAll('[id]')].map(node => node.id).join(''), reachable: el.contains(hit), label: el.getAttribute('aria-label'), animations: el.getAnimations().length,
    };
  });
  // Held still here, so the fade can be looked at: the shell's animation is paused as it starts.
  await page.evaluate(() => {
    const w = window as any, animate = Element.prototype.animate;
    w.__cpAnimate = animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<typeof animate>) { const animation = animate.apply(this, args); if (this.classList.contains('cp-ghost')) animation.pause(); return animation; };
  });
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await still(page);
  const where = await box(card(page));
  // Collapsing: the pill is there and focused at once; the card fades in a shell over it.
  await page.keyboard.press('Escape');
  await expect(pill(page)).toBeFocused();
  await expect(card(page)).toHaveCount(0);
  await expect(ghost).toHaveCount(1);
  expect(await shell()).toEqual({ holds: 'cp-card', inert: true, hidden: 'true', pointer: 'none', ids: '', reachable: false, label: null, animations: 1 });
  const fading = await box(ghost.locator('.cp-card'));
  expect(Math.abs(fading.x - where.x) + Math.abs(fading.y - where.y)).toBeLessThan(1);
  // Opening again ends that fade at once.
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await expect(ghost).toHaveCount(0);

  // The last runtime goes: the pip is hidden at once (the composer has focus), and what it showed fades in a shell.
  await card(page).getByRole('button', { name: 'Collapse Google Colab runtimes' }).click();
  await expect(ghost).toHaveCount(1);
  await seed(page, []);
  await expect(pip(page)).toBeHidden();
  await expect(page.locator('#prompt')).toBeFocused();
  await expect(ghost).toHaveCount(1);
  expect(await shell()).toEqual({ holds: 'cp-pill', inert: true, hidden: 'true', pointer: 'none', ids: '', reachable: false, label: null, animations: 1 });
  // A runtime that arrives before the fade is over ends it, and is drawn at full strength.
  await seed(page, [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running train.py');
  await expect(ghost).toHaveCount(0);
  await still(page);
  expect(await pip(page).evaluate(el => getComputedStyle(el).opacity)).toBe('1');

  // Left to itself the fade is over in a moment, under reduced motion too, and leaves nothing behind.
  await page.evaluate(() => { Element.prototype.animate = (window as any).__cpAnimate; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seed(page, []);
  await expect(pip(page)).toBeHidden();
  await expect(ghost).toHaveCount(0);
  await seed(page, [runtime()]);
  await pill(page).click();
  await page.keyboard.press('Escape');
  await expect(pill(page)).toBeFocused();
  await expect(ghost).toHaveCount(0);
  expect(await page.locator('.conversation-pane').evaluate(el => el.querySelectorAll('.cp-pill, .cp-card').length)).toBe(1);
});

test('colab-pip says an error is one in words, in the pill and its name, whatever its first line holds', async ({ page }) => {
  await open(page);
  // A blank first line is skipped: the pill and the announcement take the first line that says something.
  await seed(page, [runtime({ state: 'error', error: '\n   \nKernel crashed.\nTraceback' })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Error: Kernel crashed.');
  // The sentence's own period ends the name: no ". ." before "Show details".
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Error: Kernel crashed. Show details');
  await expect(pill(page)).toHaveAccessibleName(/Error: Kernel crashed\. Show details$/);
  expect(await pill(page).getAttribute('aria-label')).not.toContain('..');
  await expect(spoken(page)).toHaveText('Google Colab runtime pandacode-t4: error. Kernel crashed');
  // With no text at all it still says it is an error.
  await seed(page, [runtime({ state: 'error', error: '   ' })]);
  await expect(pill(page).locator('.cp-activity')).toHaveText('Error: Runtime error');
  await expect(pill(page)).toHaveAttribute('aria-label', 'Google Colab runtime: Colab · T4 GPU, Error: Runtime error. Show details');
});

test('colab-pip stays silent when an event lands on a thread it is switching to before that thread\'s list loads', async ({ page }) => {
  await open(page);
  const live = spoken(page);
  const trainer = runtime({ id: 'colab:gpu-a100-xyz', endpoint: 'gpu-a100-xyz', name: 'trainer', hardware: 'A100 GPU', state: 'busy', activity: 'Running train.py', busySince: Date.now() - 4000 });
  await seed(page, [runtime()]);
  await expect(pill(page)).toBeVisible();
  await seed(page, [trainer], 'session-4');
  // As session-4's list is asked for, and before its answer is back, an event brings that same busy runtime.
  await page.evaluate(list => {
    const w = window as any, record: unknown[] = w.__previewColabCalls, push = record.push.bind(record);
    record.push = (...items: { command: string; sessionId: string }[]) => {
      const length = push(...items);
      if (items.some(item => item.command === 'cloud_colab_thread_runtimes' && item.sessionId === 'session-4' && !w.__cpRaced)) { w.__cpRaced = true; w.__previewColabRuntime('session-4', list); }
      return length;
    };
  }, [trainer]);
  await live.evaluate(el => { el.textContent = ''; });
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(pill(page).locator('.cp-activity')).toHaveText('Running train.py');
  expect(await page.evaluate(() => (window as any).__cpRaced)).toBe(true);
  await page.waitForTimeout(300);
  // What the thread already had is not read out.
  expect(await live.textContent()).not.toMatch(/Colab|trainer|pandacode-t4/);
  // What happens from then on is.
  await seed(page, [{ ...trainer, state: 'error', error: 'The kernel died.' }], 'session-4');
  await expect(live).toHaveText('trainer: error. The kernel died');
});

test('colab-pip drops an action\'s answer when a newer colab-runtime event landed while it was in flight', async ({ page }) => {
  await open(page);
  await seed(page, [runtime()]);
  await pill(page).click();
  const row = rows(page).first();
  await page.evaluate(() => { const w = window as any; w.__colabRuntimeGate = new Promise(resolve => { w.__cpRelease = resolve; }); });
  const openButton = row.getByRole('button', { name: 'Open in Colab' });
  await openButton.click();
  await expect.poll(async () => (await calls(page)).some(call => call.action === 'open_browser')).toBe(true);
  await expect(openButton).toHaveAttribute('aria-disabled', 'true');
  // Meanwhile the runtime went to work: an event says so (the store, which answers the action, still says ready).
  await page.evaluate(list => { (window as any).__previewEmit('colab-runtime', { sessionId: 'session-1', runtimes: list }); },
    [runtime({ state: 'busy', activity: 'Running train.py', busySince: Date.now() })]);
  await expect(row.locator('.cp-activity')).toHaveText('Running train.py');
  // The action's answer, older than that event, is not painted over it; the row's controls come back.
  await page.evaluate(() => { const w = window as any; w.__cpRelease(); w.__colabRuntimeGate = undefined; });
  await expect(openButton).not.toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(200);
  await expect(row.locator('.cp-activity')).toHaveText('Running train.py');
  await expect(row).toHaveAttribute('data-runtime', 'busy');
});
