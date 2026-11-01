import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const side = (page: Page) => page.getByRole('textbox', { name: 'Message the side thread', exact: true });
const log = (page: Page) => page.getByRole('log', { name: 'Side thread conversation', exact: true });
const answers = (page: Page) => log(page).locator('.message.agent-message[data-message-id]');
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
      if (command === 'configure_session' && window.__failConfigure) throw new Error('Model unavailable.');
      if (command === 'get_messages' && args.sessionId === window.__slowSide) await new Promise(resolve => setTimeout(resolve, 400));
      switch (command) {`);
    await route.fulfill({ response, body: body + `
window.__btwEmit = emit; window.__btwSession = session; window.__btwSaveConnection = previewSaveConnection;
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
  await expect(answers(page).locator('.markdown').first()).toContainText('browser preview');
  const sends = await calls(page, 'send_message');
  expect(sends).toHaveLength(2);
  expect(sends[1].args.sessionId).not.toBe(mainId);
  expect(sends[1].args.text).toMatch(/^what does the index cost\?\n\nMain thread context: ".*" \(running\)/);
  expect(sends[1].args.text).toContain('User: Build the feature');
  expect(await calls(page, 'queue_add')).toHaveLength(0);
  expect(await calls(page, 'steer_task')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  // The context shows as one chip that opens its raw text, and the sidebar keeps the BTW title.
  const chip = log(page).locator('.user-message .prompt-chip');
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
  await expect(log(page).locator('.user-message')).toHaveCount(0);
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
  await expect(log(page).locator('.btw-stream-region .live-message')).toHaveCount(0);
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
  await expect(log(page).locator('.user-message')).toHaveCount(1);
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
  await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  const id = await sideId(page);
  await side(page).fill('draft while it streams');
  await side(page).evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(5, 5));
  for (const chunk of ['Here ', 'is **the** ', 'answer.']) {
    await page.evaluate(([sessionId, text]) => (window as any).__btwEmit('agent-event', { sessionId, kind: 'text', text }), [id, chunk]);
  }
  await expect(log(page).locator('.btw-stream-region .live-text')).toHaveText('Here is the answer.');
  await expect(side(page)).toBeFocused();
  await expect(side(page)).toHaveValue('draft while it streams');
  expect(await side(page).evaluate((input: HTMLTextAreaElement) => input.selectionStart)).toBe(5);
  await expect(log(page)).toHaveAttribute('role', 'log');

  await side(page).press('Escape');
  await expect(prompt(page)).toBeFocused();
  expect(await calls(page, 'stop_session')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

// The side panel's own thread view and composer (docs/btw.md).
const panel = (page: Page) => page.locator('.btw-panel');
const mainTrigger = (page: Page) => page.locator('#model-picker-trigger');
const sideModel = (page: Page) => panel(page).getByRole('button', { name: 'Choose harness and model', exact: true });
const sideMode = (page: Page) => panel(page).locator('.mode-picker');
const picker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const mainId = (page: Page): Promise<string> => page.evaluate(() => (window as any).__mainId);
async function openSide(page: Page, question = 'first question'): Promise<string> {
  await prompt(page).fill(`/btw ${question}`);
  await prompt(page).press('Enter');
  await expect(answers(page)).toHaveCount(1); await idle(page);
  return (await calls(page, 'send_message')).at(-1).args.sessionId;
}
/** Each top-level transcript row, minus the panel's own Insert button and live/team hosts. */
const rows = (page: Page, selector: string) => page.locator(selector).evaluate(root => [...root.children]
  .filter(row => !row.matches('#stream-region, .btw-stream-region, #team-progress-host, .team-progress-slot, .inspector-hint'))
  .map(row => ({
    kind: row.className.replace(/\s+/g, ' ').trim(),
    tools: row.querySelectorAll('[data-tool-key]').length,
    chips: [...row.querySelectorAll('.prompt-chip-name')].map(chip => chip.textContent),
    actions: [...row.querySelectorAll('.message-actions button:not(.btw-insert)')].map(button => button.getAttribute('aria-label')),
    text: (row.querySelector('.message-content')?.textContent ?? row.querySelector('.turn-activity-label')?.textContent ?? '').trim().slice(0, 60),
  })));

test('the side thread is drawn as the main transcript draws it', async ({ page }) => {
  const sideId = await openSide(page);
  const inPanel = await rows(page, '.btw-transcript');
  // A user row with the context chip, the tool turn, then the answer with its actions.
  expect(inPanel.map(row => row.kind).slice(0, 3)).toEqual(['message user-message', expect.stringContaining('turn-activity'), 'message agent-message after-trace']);
  expect(inPanel[0].chips).toEqual(['Main thread context']);
  expect(inPanel[1].tools).toBeGreaterThan(0);
  expect(inPanel[2].actions).toEqual(['Copy message', 'Fork from here']);
  await expect(log(page).getByRole('button', { name: 'Insert this answer into the main prompt' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Open side thread as a full thread', exact: true }).click();
  await expect(page.locator(`.task-item[data-id="${sideId}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#transcript .agent-message[data-message-id]')).toHaveCount(1);
  expect(await rows(page, '#transcript')).toEqual(inPanel);
});

test('model, effort and permissions change the side thread only and survive reopening the panel', async ({ page }) => {
  const sideId = await openSide(page), main = await mainId(page);
  const mainLabel = await mainTrigger(page).textContent(), mainMode = await page.locator('#mode-picker-trigger').getAttribute('data-mode');
  // The main thread is running, so its model is locked; the side thread's is not.
  await expect(mainTrigger(page)).toBeDisabled();
  await sideModel(page).click();
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  await sideModel(page).click();
  await picker(page).getByRole('radiogroup', { name: 'Effort', exact: true }).getByRole('radio', { name: 'High', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(sideModel(page)).toContainText('High');
  await sideMode(page).click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  const choice = menu.getByRole('menuitemradio', { checked: false }).first();
  const chosen = (await choice.textContent())!.trim();
  await choice.click();
  await expect(sideMode(page)).not.toHaveAttribute('data-mode', mainMode!);

  expect((await calls(page, 'configure_session')).map(call => call.args)).toEqual([{ sessionId: sideId, provider: 'claude', model: 'opus' }]);
  expect((await calls(page, 'set_reasoning_effort')).map(call => call.args)).toEqual([{ sessionId: sideId, reasoningEffort: 'high' }]);
  const modes = (await calls(page, 'update_session')).filter(call => 'mode' in call.args);
  expect(modes.map(call => call.args.sessionId)).toEqual([sideId]);
  // The main composer is untouched.
  expect(await mainTrigger(page).textContent()).toBe(mainLabel);
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', mainMode!);
  expect([...await calls(page, 'configure_session'), ...await calls(page, 'set_reasoning_effort'), ...modes].some(call => call.args.sessionId === main)).toBe(false);

  // Closing and reopening the panel reads the saved side thread again.
  await page.getByRole('button', { name: 'Close side thread panel', exact: true }).click();
  await prompt(page).fill('/btw ');
  await prompt(page).press('Enter');
  await expect(side(page)).toBeFocused();
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  await expect(sideModel(page)).toContainText('High');
  await expect(sideMode(page)).toContainText(chosen.split('\n')[0].trim().slice(0, 8));
  const saved = await page.evaluate(id => (window as any).__TAURI_INTERNALS__.invoke('get_task', { sessionId: id }), sideId).catch(() => null);
  if (saved) expect(saved).toMatchObject({ model: 'opus', reasoningEffort: 'high' });
});

test('Enter queues, Cmd/Ctrl+Enter steers and Stop stops the side thread, never the main one', async ({ page }) => {
  const main = await mainId(page);
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await prompt(page).fill('/btw keep working');
  await prompt(page).press('Enter');
  const stop = panel(page).getByRole('button', { name: 'Stop side thread', exact: true });
  await expect(stop).toBeVisible();
  const sideId = (await calls(page, 'send_message')).at(-1).args.sessionId;
  expect(sideId).not.toBe(main);

  await side(page).fill('queued follow-up');
  await side(page).press('Enter');
  await expect(side(page)).toHaveValue('');
  await expect(panel(page).getByRole('region', { name: 'Queued messages', exact: true })).toContainText('queued follow-up');
  await expect(page.locator('#composer-area').getByRole('region', { name: 'Queued messages', exact: true })).toHaveCount(0);
  expect((await calls(page, 'queue_add')).map(call => call.args.sessionId)).toEqual([sideId]);

  await side(page).fill('steer this');
  await side(page).press('ControlOrMeta+Enter');
  await expect.poll(() => calls(page, 'steer_task').then(list => list.map(call => call.args))).toEqual([{ sessionId: sideId, text: 'steer this' }]);
  await expect(log(page).locator('.user-message').last()).toContainText('steer this');

  await stop.click();
  await expect.poll(() => calls(page, 'stop_session').then(list => list.map(call => call.args.sessionId))).toEqual([sideId]);
  // The main thread keeps running, and its own composer still queues to it.
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await prompt(page).fill('main follow-up');
  await prompt(page).press('Enter');
  await expect.poll(() => calls(page, 'queue_add').then(list => list.map(call => call.args.sessionId))).toEqual([sideId, main]);
  await expect(page.locator('#composer-area').getByRole('region', { name: 'Queued messages', exact: true })).toContainText('main follow-up');
  await expect(panel(page).getByRole('region', { name: 'Queued messages', exact: true })).not.toContainText('main follow-up');
});

test('a side thread approval is answered in the panel', async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await prompt(page).fill('/btw needs approval');
  await prompt(page).press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  const sideId = (await calls(page, 'send_message')).at(-1).args.sessionId;
  await page.evaluate(id => (window as any).__btwEmit('agent-event', { sessionId: id, kind: 'approval', requestId: 'side-approval', text: 'Run npm test?' }), sideId);
  const bar = panel(page).getByRole('region', { name: 'Approval needed', exact: true });
  await expect(bar).toBeVisible();
  await expect(page.locator('.btw-head small')).toHaveText(/^Needs your input/);
  await expect(page.locator('#approval-bar .approval-bar')).toHaveCount(0);
  await bar.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => calls(page, 'respond_approval').then(list => list.map(call => call.args))).toEqual([{ sessionId: sideId, requestId: 'side-approval', approved: true }]);
  await expect(bar).toHaveCount(0);
});

test('/btw typed in the side prompt sends to the side thread', async ({ page }) => {
  const sideId = await openSide(page);
  await side(page).fill('/btw and another thing');
  await side(page).press('Enter');
  await expect(answers(page)).toHaveCount(2);
  const sent = (await calls(page, 'send_message')).at(-1);
  expect(sent.args.sessionId).toBe(sideId);
  expect(sent.args.text).toMatch(/^and another thing\n\nMain thread context:/);
  expect(await calls(page, 'queue_add')).toHaveLength(0);
});

test('/model in the side prompt opens the side picker and never touches the main thread', async ({ page }) => {
  const sideId = await openSide(page), main = await mainId(page);
  const mainLabel = await mainTrigger(page).textContent();
  await side(page).fill('/model ');
  await side(page).press('Enter');
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  expect((await calls(page, 'configure_session')).map(call => call.args.sessionId)).toEqual([sideId]);
  expect(await mainTrigger(page).textContent()).toBe(mainLabel);
  // A command that would act on the open thread is refused, not run there.
  await side(page).fill('/pwd ');
  await side(page).press('Enter');
  await expect(page.getByText('Open the side thread as a full thread to use /pwd.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Working directory' })).toHaveCount(0);
  expect((await calls(page, 'send_message')).filter(call => call.args.sessionId === main)).toHaveLength(1);
});

test('model and permissions picked before the side thread exists apply to it before its first message', async ({ page }) => {
  const main = await mainId(page);
  await prompt(page).fill('/btw ');
  await prompt(page).press('Enter');
  await expect(page.getByText('No side thread yet')).toBeVisible();
  await expect(sideModel(page)).toContainText('Claude Sonnet 5');
  await page.evaluate(() => (window as any).__btwSaveConnection({ provider: 'claude', name: 'Claude Work', env: [] }));
  await sideModel(page).click();
  await picker(page).getByRole('tab', { name: 'Claude Work', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Claude Work · Claude Opus 5', exact: true }).click();
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  await sideMode(page).click();
  const choice = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { checked: false }).first();
  await choice.click();
  // Nothing is saved yet, and the main thread keeps its own.
  expect(await calls(page, 'configure_session')).toHaveLength(0);
  expect((await calls(page, 'update_session')).filter(call => 'mode' in call.args)).toHaveLength(0);
  await side(page).fill('first side question');
  await side(page).press('Enter');
  await expect(answers(page)).toHaveCount(1);
  const all: any[] = await page.evaluate(() => (window as any).__btwCalls);
  const sideId = all.filter(call => call.command === 'send_message').at(-1).args.sessionId;
  expect(sideId).not.toBe(main);
  const order = all.filter(call => call.args?.sessionId === sideId && ['configure_session', 'connection_assign', 'update_session', 'send_message'].includes(call.command) && (call.command !== 'update_session' || 'mode' in call.args)).map(call => call.command);
  expect(order).toEqual(['configure_session', 'connection_assign', 'update_session', 'send_message']);
  expect(all.find(call => call.command === 'connection_assign').args.connectionId).toBeTruthy();
  expect(all.find(call => call.command === 'configure_session').args).toEqual({ sessionId: sideId, provider: 'claude', model: 'opus' });
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  await expect(mainTrigger(page)).toContainText('Claude Sonnet 5');
});

test('editing a queued side message focuses its editor and survives streaming', async ({ page }) => {
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await prompt(page).fill('/btw keep going');
  await prompt(page).press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  const sideId = (await calls(page, 'send_message')).at(-1).args.sessionId;
  await side(page).fill('queued text');
  await side(page).press('Enter');
  await panel(page).getByRole('button', { name: 'Edit queued message 1', exact: true }).click();
  const editor = panel(page).getByRole('textbox', { name: 'Edit queued message', exact: true });
  await expect(editor).toBeFocused();
  await editor.fill('edited text');
  for (const chunk of ['Streaming ', 'more ', 'text.']) await page.evaluate(([id, text]) => (window as any).__btwEmit('agent-event', { sessionId: id, kind: 'text', text }), [sideId, chunk]);
  await expect(log(page).locator('.btw-stream-region .live-text')).toContainText('Streaming more text.');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('edited text');
});

test('at a narrow window nothing in the side panel runs past its edge', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openSide(page);
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await side(page).fill('a queued follow-up with quite a long line of text in it');
  await side(page).press('Enter');
  await side(page).fill('second');
  await side(page).press('Enter');
  await expect(panel(page).getByRole('region', { name: 'Queued messages', exact: true })).toBeVisible();
  await log(page).locator('details.tool-group, details.turn-activity').evaluateAll(nodes => nodes.forEach(node => { (node as HTMLDetailsElement).open = true; }));
  const overflow = await panel(page).evaluate(root => {
    const edge = root.getBoundingClientRect().right + 1;
    return [...root.querySelectorAll<HTMLElement>('*')].filter(node => !node.closest('pre, .sr-only') && node.getClientRects().length && node.getBoundingClientRect().right > edge).map(node => node.className.toString());
  });
  expect(overflow).toEqual([]);
  expect(await log(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('a side thread whose picked settings cannot be applied is removed, keeping the picks and the text', async ({ page }) => {
  await prompt(page).fill('/btw ');
  await prompt(page).press('Enter');
  await sideModel(page).click();
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await page.evaluate(() => { (window as any).__failConfigure = true; });
  await side(page).fill('will not start');
  await side(page).press('Enter');
  await expect(page.getByText('The side thread could not use the model you picked. Model unavailable.')).toBeVisible();
  // The task created for it (the one configure_session failed on) is deleted again.
  const created = (await calls(page, 'configure_session'))[0].args.sessionId;
  expect((await calls(page, 'delete_session')).map(call => call.args.sessionId)).toEqual([created]);
  expect((await calls(page, 'send_message')).length).toBe(1);
  await expect(page.locator('.task-item[title^="BTW:"]')).toHaveCount(0);
  await expect(side(page)).toHaveValue('will not start');
  await expect(page.getByText('No side thread yet')).toBeVisible();
  await expect(sideModel(page)).toContainText('Claude Opus 5');
  // With the problem gone, the same picks apply to the next try.
  await page.evaluate(() => { (window as any).__failConfigure = false; });
  await side(page).press('Enter');
  await expect(answers(page)).toHaveCount(1);
  const sideId = (await calls(page, 'send_message')).at(-1).args.sessionId;
  expect((await calls(page, 'configure_session')).at(-1).args).toEqual({ sessionId: sideId, provider: 'claude', model: 'opus' });
  await expect(sideModel(page)).toContainText('Claude Opus 5');
});
