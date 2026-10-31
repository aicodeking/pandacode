import { expect, test, type Page } from '@playwright/test';

const sessionId = 'session-2';
const request = 'Keep `main.cpp` in the reply.\n\nDo not create a file yet.';
const commentary = 'I’ll check **the interface** before making changes.';
const answer = 'Here is the code:\n\n```cpp\n#include <iostream>\nint main() { std::cout << "Hello"; }\n```\n\n[Reference](https://example.com/guide)';
const history = [
  { id: 201, sessionId, role: 'user', content: request, createdAt: 100 },
  { id: 202, sessionId, role: 'assistant', content: commentary, createdAt: 200 },
  { id: 203, sessionId, role: 'tool', content: 'Read README.md', createdAt: 300 },
  { id: 204, sessionId, role: 'assistant', content: answer, createdAt: 400 },
  { id: 205, sessionId, role: 'user', content: 'Later request must not enter an earlier fork.', createdAt: 500 },
  { id: 206, sessionId, role: 'assistant', content: 'Later response must stay in the source.', createdAt: 600 },
];
const errors = new WeakMap<Page, string[]>();
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const prompt = (page: Page) => page.locator('#prompt');
const action = (page: Page, key: number | string, kind: 'copy' | 'fork' | 'edit', task = sessionId) => transcript(page)
  .locator(`[data-message-action="${kind}"][data-message-session="${task}"][data-message-key="${key}"]`);

async function install(page: Page): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__clipboardWrites.push(text); },
    } });
  });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      if (!window.__messageActionsTest) {
        messages['session-2'] = ${JSON.stringify(history)};
        id = Math.max(id, 206);
        Object.assign(session('session-2'), {
          title: 'Message action fixture', provider: 'codex', model: 'gpt-6-astra',
          mode: 'ask', reasoningEffort: 'high', taskStage: 'review',
          resumeId: 'source-provider-conversation', worktreePath: '/sample/worktrees/message-actions',
          goalState: { threadId: 'source-provider-conversation', objective: 'Source goal', status: 'complete',
            tokenBudget: null, tokensUsed: 1200, timeUsedSeconds: 12, createdAt: 100, updatedAt: 200 },
        });
        worktreeGit.set('/sample/worktrees/message-actions', structuredClone(git));
        window.__messageActionsTest = {
          calls: [], emit: event => agent(event),
          history: task => structuredClone(messages[task] ?? []),
          task: task => structuredClone(session(task)),
          tasks: () => structuredClone(sessions),
          setContent: (messageId, content) => { messages['session-2'].find(message => message.id === messageId).content = content; },
        };
      }
      const fixture = window.__messageActionsTest;
      fixture.calls.push({ command, args: structuredClone(args) });
      if (command === 'get_message_content' && fixture.holdContent) {
        await new Promise(resolve => { fixture.releaseContent = resolve; });
      }
      if (command === 'fork_session_at_message') {
        if (fixture.failFork) throw new Error('Could not save this fork. Try again.');
        if (fixture.holdFork) await new Promise(resolve => { fixture.releaseFork = resolve; });
      }
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.locator(`.task-item[data-id="${sessionId}"]`).click();
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId);
  await expect(transcript(page)).toContainText(history[5].content);
}

async function snapshot(page: Page, task = sessionId): Promise<{ task: any; messages: any[] }> {
  return page.evaluate(task => {
    const fixture = (window as any).__messageActionsTest;
    return { task: fixture.task(task), messages: fixture.history(task) };
  }, task);
}

async function calls(page: Page, command: string): Promise<any[]> {
  return page.evaluate(command => (window as any).__messageActionsTest.calls.filter((call: any) => call.command === command), command);
}

async function revealHistory(page: Page): Promise<void> {
  const groups = transcript(page).locator('.turn-activity');
  for (let index = 0; index < await groups.count(); index++) {
    const group = groups.nth(index);
    if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  }
}

async function selectedFork(page: Page): Promise<string> {
  await expect(prompt(page)).not.toHaveAttribute('data-session-id', sessionId);
  const forkId = await prompt(page).getAttribute('data-session-id');
  expect(forkId).toBeTruthy();
  return forkId!;
}

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

test('older history and forks preserve authors when the later harness switch is outside the page', async ({page}) => {
  const oldResponse = {id:202,sessionId,role:'assistant',content:'Saved Claude answer\n\n```cpp\n#include <iostream>\nint main() { std::cout << "Hello, world!"; }\n```',createdAt:200};
  // The saved answer ends its turn (a later request follows), so it keeps copy and fork.
  const seeded = [history[0], oldResponse, {id:203,sessionId,role:'user',content:'Next request',createdAt:250},
    ...Array.from({length:110}, (_, index) => ({id:204+index,sessionId,role:'tool',content:'Completed operation',createdAt:300+index})),
    {id:400,sessionId,role:'handoff',content:JSON.stringify({fromProvider:'claude',toProvider:'codex',summary:'Saved harness switch'}),createdAt:500},
    {id:401,sessionId,role:'assistant',content:'Current Codex answer',createdAt:600}];
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({response,body:source.replace(marker, `async function invoke(command, args) {
      if (!window.__authorFixture) {
        window.__authorFixture = true; messages['session-2'] = ${JSON.stringify(seeded)}; id = Math.max(id,401);
        Object.assign(session('session-2'),{provider:'codex',resumeId:'current-native-id',status:'idle'});
      }`)});
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(transcript(page).locator('[data-message-id="401"] .message-meta strong')).toHaveText('Codex');
  await transcript(page).evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await transcript(page).dispatchEvent('wheel', { deltaY: -200 });
  await expect(transcript(page).locator('[data-message-id="202"]')).toHaveCount(1);
  await revealHistory(page);
  await expect(transcript(page).locator('.provider-handoff')).toHaveCount(1);
  await expect(transcript(page).locator('[data-message-id="202"] .message-meta strong')).toHaveText('Claude Code');
  const earlierReply = transcript(page).locator('[data-message-id="202"]');
  await expect(earlierReply.locator('pre code')).toContainText('Hello, world!');
  await earlierReply.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/private/tmp/pandacode-history-scroll.png', animations: 'disabled' });
  await action(page,202,'fork').click();
  await selectedFork(page);
  const saved = transcript(page).locator('.agent-message').filter({hasText:'Saved Claude answer'});
  await expect(saved.locator('.message-meta strong')).toHaveText('Claude Code');
  await expect(transcript(page).locator('.provider-handoff')).toHaveCount(1);
  await expect(transcript(page)).not.toContainText('Current Codex answer');
});

test.describe('conversation message actions', () => {
  test('copies the original user text and Markdown, including earlier activity responses, using keyboard controls', async ({ page }) => {
    await install(page); await revealHistory(page);
    await expect(action(page, 201, 'copy')).toBeVisible();
    // A reply between tool calls has no copy or fork; the turn's last reply does.
    await expect(transcript(page).locator('[data-message-key="202"]')).toHaveCount(0);
    for (const [key, content] of [[201, request], [204, answer], [206, history[5].content]] as const) {
      const copy = action(page, key, 'copy');
      await copy.focus(); await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe(content);
    }
    await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId);
    expect(await calls(page, 'fork_session_at_message')).toEqual([]);
    await page.screenshot({ path: 'test-results/pandacode-message-actions.png', animations: 'disabled' });
  });

  test('forks at a selected response with an independent saved prefix and leaves the source unchanged', async ({ page }) => {
    await install(page); const original = await snapshot(page);
    await action(page, 204, 'fork').click();
    const forkId = await selectedFork(page), fork = await snapshot(page, forkId);
    expect(fork.task).toMatchObject({ projectId: original.task.projectId, worktreePath: original.task.worktreePath,
      provider: original.task.provider, model: original.task.model, mode: original.task.mode,
      reasoningEffort: original.task.reasoningEffort, resumeId: null, status: 'idle', archived: false });
    expect(fork.task.goalState ?? null).toBeNull();
    expect(fork.messages.map(message => [message.role, message.content])).toEqual(history.slice(0, 4).map(message => [message.role, message.content]));
    expect(fork.messages.every(message => message.sessionId === forkId && !history.some(source => source.id === message.id))).toBe(true);
    expect(await snapshot(page)).toEqual(original);
    await expect(transcript(page)).toContainText('Here is the code:');
    await expect(transcript(page)).not.toContainText('Later request');
    await page.locator(`.task-item[data-id="${sessionId}"]`).click();
    await expect(transcript(page)).toContainText(history[5].content);
    await page.locator(`.task-item[data-id="${forkId}"]`).click();
    await expect(transcript(page)).not.toContainText('Later request');
    expect(await calls(page, 'send_message')).toEqual([]);
    expect(await calls(page, 'fork_session_at_message')).toEqual([{ command: 'fork_session_at_message', args: { sessionId, messageId: 204, exclusive: false } }]);
  });

  test('edit rewinds to before a user message, drops it from the new task and puts its text in the composer', async ({ page }) => {
    await install(page); const original = await snapshot(page);
    await page.evaluate(() => (window as any).__messageActionsTest.setContent(205, 'Fix the tpyo please.\n\nDocument context: notes.md\nbody'));
    await action(page, 205, 'edit').click();
    const forkId = await selectedFork(page), fork = await snapshot(page, forkId);
    expect(fork.task.resumeId).toBeNull();
    expect(fork.messages.map(message => message.content)).toEqual(history.slice(0, 4).map(message => message.content));
    await expect(prompt(page)).toHaveValue('Fix the tpyo please.');
    await expect(prompt(page)).toBeFocused();
    await expect(transcript(page)).not.toContainText('tpyo');
    expect((await snapshot(page)).messages.length).toBe(original.messages.length);
    expect(await calls(page, 'send_message')).toEqual([]);
    expect(await calls(page, 'fork_session_at_message')).toEqual([{ command: 'fork_session_at_message', args: { sessionId, messageId: 205, exclusive: true } }]);
    // Assistant responses have no Edit; a running thread disables it.
    await page.locator(`.task-item[data-id="${sessionId}"]`).click();
    await expect(action(page, 204, 'edit')).toHaveCount(0);
    await page.evaluate(id => (window as any).__messageActionsTest.emit({ sessionId: id, kind: 'status', text: 'Starting agent' }), sessionId);
    await expect(transcript(page)).toHaveAttribute('data-running', '');
  });

  test('starts a ClipboardItem write during the click and copies full stored text after the database responds', async ({ page }) => {
    await install(page);
    const fullContent = answer + '\n\n' + 'Long stored response. '.repeat(14000) + 'FULL_COPY_TAIL';
    await page.evaluate(fullContent => {
      const fixture = (window as any).__messageActionsTest;
      fixture.setContent(204, fullContent); fixture.holdContent = true;
      (window as any).__clipboardWriteStarted = false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        write: async (items: ClipboardItem[]) => {
          (window as any).__clipboardWriteStarted = true;
          const blob = await items[0].getType('text/plain');
          (window as any).__clipboardWrites.push(await blob.text());
        },
      } });
    }, fullContent);
    const copy = action(page, 204, 'copy'); await copy.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__messageActionsTest.releaseContent)).toBe('function');
    expect(await page.evaluate(() => (window as any).__clipboardWriteStarted)).toBe(true);
    expect(await page.evaluate(() => (window as any).__clipboardWrites)).toEqual([]);
    await expect(copy).toBeDisabled();
    await page.evaluate(() => (window as any).__messageActionsTest.releaseContent());
    await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1)?.length)).toBe(fullContent.length);
    expect(await page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe(fullContent);
    await expect(copy).toBeEnabled();
    await expect(copy).toHaveAttribute('aria-label', 'Copied');
    expect(await calls(page, 'get_message_content')).toEqual([{ command: 'get_message_content', args: { sessionId, messageId: 204 } }]);
  });

  test('uses a clipboard fallback when permission is denied and reports failure if no copy method succeeds', async ({ page }) => {
    await install(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      } });
      Object.defineProperty(document, 'execCommand', { configurable: true, value: (command: string) => {
        if (command !== 'copy' || (window as any).__failFallback) return false;
        (window as any).__clipboardWrites.push((document.activeElement as HTMLTextAreaElement).value);
        return true;
      } });
    });
    const copy = action(page, 204, 'copy'); await copy.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe(answer);
    await expect(copy).toBeFocused();
    await expect(copy).toHaveAttribute('aria-label', 'Copied');
    await page.evaluate(() => { (window as any).__failFallback = true; });
    const failedCopy = action(page, 206, 'copy'); await failedCopy.click();
    await expect(page.locator('#toast')).toContainText('Could not copy this message.');
    await expect(failedCopy).toBeEnabled();
    await expect(failedCopy).toHaveAttribute('aria-label', 'Copy message');
    expect(await page.evaluate(() => (window as any).__clipboardWrites)).toEqual([answer]);
    await expect(page.locator('textarea[readonly]')).toHaveCount(0);
  });

  test('forks at the first user message inside the board without opening the general conversation view', async ({ page }) => {
    await install(page);
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    const board = page.getByRole('region', { name: 'Project board', exact: true });
    await board.getByRole('button', { name: 'Open task: Message action fixture', exact: true }).click();
    await expect(action(page, 201, 'fork')).toBeVisible();
    await page.screenshot({ path: 'test-results/pandacode-message-actions-board.png', animations: 'disabled' });
    await action(page, 201, 'fork').click();
    const forkId = await selectedFork(page), fork = await snapshot(page, forkId);
    await expect(board).toBeVisible();
    await expect(page.getByRole('region', { name: 'Task details', exact: true })).toBeVisible();
    expect(fork.messages.map(message => [message.role, message.content])).toEqual([['user', request]]);
    await expect(transcript(page)).not.toContainText('Here is the code:');
    expect(await calls(page, 'send_message')).toEqual([]);
    expect(await calls(page, 'start_task')).toEqual([]);
  });

  test('copies the latest streaming response without replacing its controls or offering an unsaved fork', async ({ page }) => {
    await install(page);
    const initial = 'Reading **the files**.';
    await page.evaluate(({ sessionId, initial }) => {
      const fixture = (window as any).__messageActionsTest;
      fixture.emit({ sessionId, kind: 'status', text: 'Starting agent' });
      fixture.emit({ sessionId, kind: 'text', text: initial });
    }, { sessionId, initial });
    const live = page.locator('#stream-region .live-message');
    await expect(live).toBeVisible();
    await expect(live.locator('[data-message-action="fork"]')).toHaveCount(0);
    await action(page, 'live', 'copy').click();
    await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe(initial);
    await page.evaluate(() => { (window as any).__liveCopyNode = document.querySelector('.live-message [data-message-action="copy"]'); });
    await page.evaluate(sessionId => {
      const fixture = (window as any).__messageActionsTest;
      fixture.emit({ sessionId, kind: 'tool', text: 'Read', tool: { id: 'copy-live-tool', name: 'Read', status: 'completed', input: 'README.md', output: 'Read complete.' } });
      fixture.emit({ sessionId, kind: 'message_start', text: '' });
      fixture.emit({ sessionId, kind: 'text', text: 'New **response** with `code`.' });
    }, sessionId);
    await expect(live.locator('.live-text')).toHaveText('New response with code.');
    expect(await page.evaluate(() => (window as any).__liveCopyNode === document.querySelector('.live-message [data-message-action="copy"]'))).toBe(true);
    await action(page, 'live', 'copy').click();
    await expect.poll(() => page.evaluate(() => (window as any).__clipboardWrites.at(-1))).toBe('New **response** with `code`.');
    // The earlier reply is now between tool calls: no copy or fork.
    await expect(transcript(page).locator('[data-message-key^="commentary:"]')).toHaveCount(0);
    expect(await calls(page, 'fork_session_at_message')).toEqual([]);
  });

  test('keeps the source on a failed fork and prevents duplicate requests while a retry is pending', async ({ page }) => {
    await install(page); const original = await snapshot(page);
    await page.evaluate(() => { (window as any).__messageActionsTest.failFork = true; });
    await action(page, 204, 'fork').click();
    await expect(page.locator('#toast')).toContainText('Could not save this fork. Try again.');
    await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId);
    expect(await snapshot(page)).toEqual(original);
    await page.evaluate(() => {
      const fixture = (window as any).__messageActionsTest;
      fixture.failFork = false; fixture.holdFork = true;
    });
    const fork = action(page, 204, 'fork');
    await fork.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__messageActionsTest.releaseFork)).toBe('function');
    await expect(fork).toBeDisabled();
    await fork.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(await calls(page, 'fork_session_at_message')).toHaveLength(2);
    await page.evaluate(() => (window as any).__messageActionsTest.releaseFork());
    await selectedFork(page);
    expect(await calls(page, 'fork_session_at_message')).toHaveLength(2);
    expect(await snapshot(page)).toEqual(original);
  });
});

// Your messages sit flush with the right edge of the transcript column, at any window width.
for (const width of [1600, 1000]) {
  test(`user bubbles align to the column's right edge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
    const bubble = page.locator('#transcript .user-message').first();
    await expect(bubble).toBeVisible();
    const edges = await page.evaluate(() => {
      const transcript = document.querySelector('#transcript')!;
      const agent = transcript.querySelector('.agent-message')!.getBoundingClientRect();
      const user = transcript.querySelector('.user-message')!.getBoundingClientRect();
      return { agentRight: agent.right, userRight: user.right, userLeft: user.left, agentLeft: agent.left };
    });
    expect(Math.abs(edges.userRight - edges.agentRight)).toBeLessThanOrEqual(1);
    expect(edges.userLeft).toBeGreaterThan(edges.agentLeft);
    // Bubble text reads left to right, and "Worked for" starts at the column edge like replies.
    expect(await bubble.locator('.message-content').evaluate(el => getComputedStyle(el).textAlign)).toBe('left');
    const activity = page.locator('#transcript>.turn-activity').first();
    const [box, summary] = await Promise.all([activity.boundingBox(), activity.locator('.turn-activity-summary').boundingBox()]);
    expect(Math.abs(summary!.x - box!.x)).toBeLessThanOrEqual(1);
    // The live "Working…" row of a running turn starts there too.
    await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).fill('Keep going.');
    await page.keyboard.press('Enter');
    const live = page.locator('#stream-region>.turn-activity');
    await expect(live).toBeVisible();
    const [liveBox, liveSummary, column] = await Promise.all([live.boundingBox(), live.locator('.turn-activity-summary').boundingBox(), activity.boundingBox()]);
    expect(Math.abs(liveSummary!.x - liveBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(liveSummary!.x - column!.x)).toBeLessThanOrEqual(1);
  });
}
