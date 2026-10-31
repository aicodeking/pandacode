import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const side = (page: Page) => page.getByRole('textbox', { name: 'Message the side thread', exact: true });
const log = (page: Page) => page.getByRole('log', { name: 'Side thread conversation', exact: true });
const answers = (page: Page) => log(page).locator('.btw-agent:not(.btw-live)');
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__btwCalls ?? []).filter((c: any) => c.command === name), name);

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    // The main thread's run is held open; side threads answer like any preview task.
    const body = source.replace(marker, `(window.__btwCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'send_message' && args.sessionId !== window.__mainId && window.__failSide) throw new Error('Side run failed.');
      if (command === 'send_message' && (args.sessionId === window.__mainId || window.__holdSide)) { session(args.sessionId).status = 'running'; (messages[args.sessionId] ??= []).push({ id: ++id, sessionId: args.sessionId, role: 'user', content: args.text, createdAt: Date.now() }); return; }
      if (command === 'get_messages' && args.sessionId === window.__slowSide) await new Promise(resolve => setTimeout(resolve, 400));
      switch (command) {`);
    await route.fulfill({ response, body: body + `
window.__btwEmit = emit; window.__btwSession = session;
window.__btwFinish = (sessionId, text) => { const task = session(sessionId); task.status = 'idle'; messages[sessionId].push({ id: ++id, sessionId, role: 'assistant', content: text, createdAt: Date.now() }); emit('agent-event', { sessionId, kind: 'done', text: '' }); };
window.__btwDelete = id => { sessions.splice(sessions.findIndex(task => task.id === id), 1); emit('sessions-changed', null); };
` });
  });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
  await page.evaluate(() => { (window as any).__mainId = document.querySelector<HTMLTextAreaElement>('#prompt')!.dataset.sessionId; });
  await prompt(page).fill('Build the feature');
  await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

test('/btw while the main thread runs opens a side thread without queueing or steering', async ({ page }) => {
  const mainId = await page.evaluate(() => (window as any).__mainId);
  await prompt(page).fill('/btw what does the index cost?');
  await prompt(page).press('Enter');
  await expect(prompt(page)).toHaveValue('');
  await expect(page.locator('#inspector-title')).toHaveText('By the way');
  await expect(page.locator('.btw-head strong')).toHaveText('what does the index cost?');
  await expect(log(page).locator('.btw-agent .markdown').first()).toContainText('browser preview');
  const sends = await calls(page, 'send_message');
  expect(sends).toHaveLength(2);
  expect(sends[1].args.sessionId).not.toBe(mainId);
  expect(sends[1].args.text).toMatch(/^what does the index cost\?\n\nMain thread context: ".*" \(running\)/);
  expect(sends[1].args.text).toContain('User: Build the feature');
  expect(await calls(page, 'queue_add')).toHaveLength(0);
  expect(await calls(page, 'steer_task')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  // The context shows as one chip that opens its raw text, and the sidebar keeps the BTW title.
  const chip = log(page).locator('.btw-user .prompt-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('.prompt-chip-name')).toHaveText('Main thread context');
  await chip.click();
  await expect(page.locator('#dialog .message-attachment-raw')).toContainText('Main thread context: "');
  await page.keyboard.press('Escape');
  await expect(page.locator(`.task-item[data-id="${sends[1].args.sessionId}"]`)).toHaveAttribute('title', /^BTW: what does the index cost\?/);
  await expect(page.locator('.btw-head small')).toHaveText('Ready · main running');
  // A bare /btw reopens the panel and focuses its composer.
  await page.getByRole('button', { name: 'Close side thread panel', exact: true }).click();
  await prompt(page).fill('/btw ');
  await prompt(page).press('Enter');
  await expect(side(page)).toBeFocused();
  expect(await calls(page, 'send_message')).toHaveLength(2);
  // By the way is an ordinary inspector tab: selected while open, and closable.
  const tab = page.locator('#inspector .inspector-tab[data-view="btw"]');
  await expect(tab.locator('.inspector-tab-button')).toHaveAttribute('aria-current', 'true');
  await tab.getByRole('button', { name: 'Close By the way', exact: true }).click();
  await expect(tab).toBeHidden();
  await expect(page.locator('#inspector-title')).not.toHaveText('By the way');
});

test('follow-ups reuse the side thread with only new main-thread context, and the panel comes back', async ({ page }) => {
  await prompt(page).fill('/btw first question');
  await prompt(page).press('Enter');
  await expect(answers(page)).toHaveCount(1); await idle(page);
  await side(page).fill('second question');
  await side(page).press('Enter');
  await expect(answers(page)).toHaveCount(2); await idle(page);
  await prompt(page).fill('/btw third question');
  await prompt(page).press('Enter');
  await expect(answers(page)).toHaveCount(3);
  const sends = (await calls(page, 'send_message')).slice(1);
  expect(new Set(sends.map(call => call.args.sessionId)).size).toBe(1);
  expect(sends[1].args.text).toContain('Nothing new in the main thread since your last message.');
  expect(sends[1].args.text).not.toContain('Build the feature');
  expect(sends[2].args.text).not.toContain('Build the feature');

  // Insert an answer into the main prompt.
  await log(page).getByRole('button', { name: 'Insert this answer into the main prompt' }).first().click();
  await expect(prompt(page)).toHaveValue(/browser preview/);
  await prompt(page).fill('');

  const sideId = sends[0].args.sessionId, mainId = await page.evaluate(() => (window as any).__mainId);
  await page.getByRole('button', { name: 'Open side thread as a full thread', exact: true }).click();
  await expect(page.locator(`.task-item[data-id="${sideId}"]`)).toHaveAttribute('aria-current', 'page');
  await page.locator(`.task-item[data-id="${mainId}"]`).click();
  await expect(page.locator('#inspector-title')).toHaveText('By the way');
  await expect(page.locator('.btw-head strong')).toHaveText('first question');
  await expect(answers(page)).toHaveCount(3);

  // A new side thread starts empty; the next message creates it.
  await page.getByRole('button', { name: 'New side thread', exact: true }).click();
  await expect(page.getByText('No side thread yet')).toBeVisible();
  await side(page).fill('fresh start');
  await side(page).press('Enter');
  await expect(page.locator('.btw-head strong')).toHaveText('fresh start');
  const fresh = (await calls(page, 'send_message')).at(-1);
  expect(fresh.args.sessionId).not.toBe(sideId);
  expect(fresh.args.text).toContain('User: Build the feature');
});

const sideId = async (page: Page) => {
  await expect.poll(() => calls(page, 'send_message').then(list => list.at(-1)?.args.sessionId)).not.toBe(await page.evaluate(() => (window as any).__mainId));
  return (await calls(page, 'send_message')).at(-1).args.sessionId as string;
};

test('Cmd/Ctrl+Enter on /btw goes to the side thread, never steers', async ({ page }) => {
  await prompt(page).fill('/btw steer path');
  await prompt(page).press('ControlOrMeta+Enter');
  await expect(answers(page)).toHaveCount(1);
  expect(await calls(page, 'steer_task')).toHaveLength(0);
  expect(await calls(page, 'queue_add')).toHaveLength(0);
  expect(await sideId(page)).not.toBe(await page.evaluate(() => (window as any).__mainId));
});

test('a deleted side thread is forgotten, so the next /btw starts a new one', async ({ page }) => {
  await prompt(page).fill('/btw first');
  await prompt(page).press('Enter');
  await expect(answers(page)).toHaveCount(1); await idle(page);
  const first = await sideId(page);
  await page.evaluate(id => (window as any).__btwDelete(id), first);
  await expect(page.locator(`.task-item[data-id="${first}"]`)).toHaveCount(0);
  await prompt(page).fill('/btw second');
  await prompt(page).press('Enter');
  await expect(page.locator('.btw-head strong')).toHaveText('second');
  expect(await sideId(page)).not.toBe(first);
  expect(await calls(page, 'create_session')).toHaveLength(2);
});

test('a failed side send puts the /btw draft back', async ({ page }) => {
  await page.evaluate(() => { (window as any).__failSide = true; });
  await prompt(page).fill('/btw will fail');
  await prompt(page).press('Enter');
  await expect(prompt(page)).toHaveValue('/btw will fail');
  await expect(page.getByText('Side run failed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
  // The unsent message does not stay on screen as if it was sent.
  await expect(log(page).locator('.btw-user')).toHaveCount(0);
});

test('the final answer stays visible from the end of the run until its saved copy shows', async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await prompt(page).fill('/btw finish it');
  await prompt(page).press('Enter');
  const id = await sideId(page);
  await page.evaluate(sessionId => (window as any).__btwEmit('agent-event', { sessionId, kind: 'text', text: 'Final answer.' }), id);
  await expect(log(page)).toContainText('Final answer.');
  await page.evaluate(sessionId => {
    const w = window as any, log = document.querySelector('.btw-transcript')!;
    w.__answerGone = false;
    new MutationObserver(() => { if (!log.textContent!.includes('Final answer.')) w.__answerGone = true; }).observe(log, { childList: true, subtree: true, characterData: true });
    w.__slowSide = sessionId; w.__btwFinish(sessionId, 'Final answer.');
    // A late event redraws the panel while the saved messages are still loading.
    setTimeout(() => w.__btwEmit('agent-event', { sessionId, kind: 'usage', text: '', data: null }), 50);
  }, id);
  await expect(answers(page)).toHaveCount(1);
  await expect(answers(page)).toContainText('Final answer.');
  await expect(log(page).locator('.btw-live')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__answerGone)).toBe(false);
});

test('a worktree task forks its side thread and hides the copied transcript', async ({ page }) => {
  await page.evaluate(() => { const w = window as any; w.__btwSession(w.__mainId).worktreePath = '/tmp/orbit-worktree'; w.__btwEmit('sessions-changed', null); });
  await expect.poll(() => calls(page, 'list_sessions').then(list => list.length)).toBeGreaterThan(1);
  await prompt(page).fill('/btw on the side');
  await prompt(page).press('Enter');
  await expect(answers(page)).toHaveCount(1);
  expect(await calls(page, 'fork_session_at_message')).toHaveLength(1);
  expect(await calls(page, 'create_session')).toHaveLength(0);
  await expect(log(page).locator('.btw-user')).toHaveCount(1);
  await expect(log(page)).not.toContainText('Build the feature');
  await expect(log(page)).not.toContainText('Search feels a little slow');
  const sent = (await calls(page, 'send_message')).at(-1);
  expect(sent.args.text).toContain('Nothing new in the main thread since your last message.');
});

test('tasks on another computer and prompts with attachments are refused, keeping the draft', async ({ page }) => {
  if (!await page.locator('#inspector').isVisible()) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-files');
  await page.locator('[data-action="tab-files"]').click();
  await page.locator('#inspector-content button[aria-label^="Attach "]').first().click();
  await prompt(page).fill('/btw with a file');
  await prompt(page).press('Enter');
  await expect(page.getByText('Side questions cannot carry attachments.', { exact: false })).toBeVisible();
  await expect(prompt(page)).toHaveValue('/btw with a file');

  await page.evaluate(() => { const w = window as any; w.__btwSession(w.__mainId).remoteDevice = { id: 'studio', name: 'Studio Mac' }; w.__btwEmit('sessions-changed', null); });
  await expect.poll(() => calls(page, 'list_sessions').then(list => list.length)).toBeGreaterThan(1);
  await prompt(page).fill('/btw elsewhere');
  await prompt(page).press('Enter');
  await expect(page.getByText('this task runs elsewhere', { exact: false })).toBeVisible();
  await expect(prompt(page)).toHaveValue('/btw elsewhere');
  expect(await calls(page, 'create_session')).toHaveLength(0);
});

test('typing in the side prompt survives streaming, and Esc there never stops the main agent', async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await prompt(page).fill('/btw stream please');
  await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeDisabled();
  const id = await sideId(page);
  await side(page).fill('draft while it streams');
  await side(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(5, 5));
  for (const chunk of ['Here ', 'is **the** ', 'answer.']) {
    await page.evaluate(([sessionId, text]) => (window as any).__btwEmit('agent-event', { sessionId, kind: 'text', text }), [id, chunk]);
  }
  await expect(log(page).locator('.btw-live .markdown')).toHaveText('Here is the answer.');
  await expect(side(page)).toBeFocused();
  await expect(side(page)).toHaveValue('draft while it streams');
  expect(await side(page).evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(5);
  await expect(log(page)).toHaveAttribute('role', 'log');

  await side(page).press('Escape');
  await expect(prompt(page)).toBeFocused();
  expect(await calls(page, 'stop_session')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
