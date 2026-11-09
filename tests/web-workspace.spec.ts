import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });

async function installWorkspaceFixture(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    const injected = `
      if (command === 'send_message') {
        const session = sessions.find(item => item.id === args.sessionId);
        if (!session) throw new Error('Missing session');
        session.status = 'running'; session.updatedAt = Date.now();
        messages[session.id] ??= [];
        messages[session.id].push({ id: ++id, sessionId: session.id, role: 'user', content: args.text, createdAt: Date.now() });
        window.__webWorkspace ??= {};
        window.__webWorkspace[session.id] = {
          push(text) { messages[session.id].push({ id: ++id, sessionId: session.id, role: 'assistant', content: text, createdAt: Date.now() }); agent({ sessionId: session.id, kind: 'text', text }); },
          done() { session.status = 'idle'; session.taskStage = 'review'; agent({ sessionId: session.id, kind: 'done', text: '' }); }
        };
        window.__webWorkspaceLast = session.id;
        agent({ sessionId: session.id, kind: 'status', text: 'Starting agent' });
        return undefined;
      }
      if (command === 'stop_session') {
        const session = sessions.find(item => item.id === args.sessionId);
        if (session) { session.status = 'idle'; agent({ sessionId: session.id, kind: 'done', text: '' }); }
        return null;
      }
      switch (command) {`;
    await route.fulfill({ response, body: source.replace(marker, injected) });
  });
  await page.goto('/?sections');
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(page.locator('.task-item[data-id="sections-approval"]')).toBeAttached();
}

async function startFixtureTurn(page: Page, text = 'Inspect the project'): Promise<string> {
  const initialSessionId = await page.locator('#prompt').getAttribute('data-session-id');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect.poll(() => page.locator('#prompt').getAttribute('data-session-id')).not.toBe(initialSessionId);
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toBeEnabled();
  await prompt(page).fill(text);
  await expect(prompt(page)).toHaveValue(text);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await prompt(page).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__webWorkspaceLast ?? '')).not.toBe('');
  return page.evaluate(() => {
    const id = (window as any).__webWorkspaceLast;
    const selected = document.querySelector<HTMLTextAreaElement>('#prompt')?.dataset.sessionId;
    if (id !== selected) throw new Error(`Fixture sent session ${id}, but the composer selected ${selected ?? 'none'}.`);
    return id;
  });
}

test.describe('web workspace fixture', () => {
  test('streams a response and makes the completed turn durable', async ({ page }) => {
    await installWorkspaceFixture(page);
    const id = await startFixtureTurn(page);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await page.evaluate(({ id }) => (window as any).__webWorkspace[id].push('The workspace is connected.'), { id }); await expect(page.locator('#stream-region .live-text')).toHaveText('The workspace is connected.');
    await page.evaluate(({ id }) => (window as any).__webWorkspace[id].done(), { id });
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
    await expect(transcript(page).getByText('The workspace is connected.', { exact: true })).toBeVisible();
  });

  test('stops a running turn and restores the composer', async ({ page }) => {
    await installWorkspaceFixture(page); await startFixtureTurn(page, 'Stop this run');
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
    await expect(prompt(page)).toBeEnabled();
  });

  test('keeps an unsent draft while switching conversation and board views', async ({ page }) => {
    await installWorkspaceFixture(page); await prompt(page).fill('Keep this unsent draft');
    const view = page.getByRole('button', { name: /^Workspace view: /, exact: true });
    await view.click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Project board', exact: true })).toBeVisible();
    await view.click(); await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
    await expect(prompt(page)).toHaveValue('Keep this unsent draft');
  });

  test('renders an existing approval state and exposes an actionable response', async ({ page }) => {
    await installWorkspaceFixture(page); await page.locator('.task-item[data-id="sections-approval"]').click();
    await expect(page.locator('.task-item[data-id="sections-approval"] .task-indicator')).toHaveAttribute('aria-label', 'Needs approval');
  });

  test('keeps the composer reachable and preserves a draft at phone width', async ({ page }) => {
    await installWorkspaceFixture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(prompt(page)).toBeInViewport();
    await prompt(page).fill('Keep this mobile draft');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(prompt(page)).toBeInViewport();
    await expect(prompt(page)).toHaveValue('Keep this mobile draft');
  });

  test('connection loss events leave the workspace draft intact', async ({ page }) => {
    await installWorkspaceFixture(page); await prompt(page).fill('Draft during reconnect');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode-web-connection', { detail: { status: 'error', message: 'Session expired' } })));
    await expect(prompt(page)).toHaveValue('Draft during reconnect');
  });
});
