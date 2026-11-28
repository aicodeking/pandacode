import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

// The real page served by src-tauri/src/bots/channels/web.rs, exercised against a scripted API.
const source = readFileSync(new URL('../src-tauri/src/bots/channels/web.rs', import.meta.url), 'utf8');
const PAGE = source.slice(source.indexOf('const PAGE: &str = r#"') + 'const PAGE: &str = r#"'.length, source.lastIndexOf('"#;'));
const ENGINE = readFileSync(new URL('../src/vendor/enriched-markdown/md4c.js', import.meta.url), 'utf8');
const CHANNEL = '0f0e0d0c-1111-2222-3333-444455556666';
const ORIGIN = 'http://127.0.0.1:47399';

interface Script { history: unknown; events: { id: number; text: string }[]; busy: boolean; posts: string[]; auth: string[]; fail?: string; noEngine?: boolean }

async function openChat(page: Page, script: Partial<Script> = {}, hash = '#secret-token'): Promise<Script> {
  const state: Script = { history: { bot: { name: 'Scout', role: 'Research assistant', avatar: '🔭', paused: false }, messages: [], busy: false, cursor: 0 }, events: [], busy: false, posts: [], auth: [], ...script };
  await page.route(`${ORIGIN}/assets/md4c.js`, route => state.noEngine ? route.abort() : route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: ENGINE }));
  await page.route(`${ORIGIN}/chat/${CHANNEL}`, route => route.fulfill({ contentType: 'text/html', body: PAGE.replace('__CHANNEL__', CHANNEL) }));
  await page.route(`${ORIGIN}/api/chat/${CHANNEL}/**`, async (route: Route) => {
    const request = route.request(), url = new URL(request.url());
    state.auth.push(request.headers().authorization ?? '');
    if (state.fail) return route.fulfill({ status: 401, json: { error: state.fail } });
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: state.history });
    if (url.pathname.endsWith('/messages')) { state.busy = true; state.posts.push(JSON.parse(request.postData() ?? '{}').text); return route.fulfill({ json: { ok: true, busy: true } }); }
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after'));
      const events = state.events.filter(event => event.id > after);
      if (!events.length) await new Promise(resolve => setTimeout(resolve, 150));
      return route.fulfill({ json: { events, busy: state.busy, cursor: events.at(-1)?.id ?? after } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${ORIGIN}/chat/${CHANNEL}${hash}`);
  return state;
}

test.describe('bots web chat page', () => {
  test('greets with suggestions and hides the token from the address bar', async ({ page }) => {
    const state = await openChat(page);
    await expect(page.getByText('Say hi to Scout')).toBeVisible();
    await expect(page).toHaveTitle('Scout');
    expect(page.url()).not.toContain('secret-token');
    expect(state.auth[0]).toBe('Bearer secret-token');
    await page.getByRole('button', { name: 'What can you do for me?' }).click();
    await expect(page.locator('.msg.me')).toHaveText('What can you do for me?');
    await expect.poll(() => state.posts).toEqual(['What can you do for me?']);
    await expect(page.locator('body')).toHaveClass(/busy/);
    await expect(page.getByRole('status')).toContainText('Scout is working');
  });

  test('replies render safe markdown and approvals answer with one click', async ({ page }) => {
    const state = await openChat(page);
    await page.getByRole('textbox', { name: 'Message' }).fill('Summarize the repo');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    state.busy = false;
    state.events.push({ id: 1, text: '**Done.** Highlights:\n\n- one `fast` path\n- [docs](https://example.com)\n- <img src=x onerror=alert(1)>\n\n```\nnpm test\n```' });
    state.events.push({ id: 2, text: 'Approval needed: Bash: git push origin main\nReply yes, no, or always.' });
    const reply = page.locator('.msg.bot').first();
    await expect(reply.locator('b')).toHaveText('Done.');
    await expect(reply.locator('li')).toHaveCount(3);
    await expect(reply.locator('a')).toHaveAttribute('href', 'https://example.com');
    await expect(reply.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(reply.locator('img')).toHaveCount(0);
    await expect(reply).toContainText('<img src=x onerror=alert(1)>');
    await expect(reply.locator('pre code')).toHaveText('npm test\n');
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(() => state.posts).toEqual(['Summarize the repo', 'yes']);
    await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  });

  test('without the engine, a tool-run approval is one escaped pre', async ({ page }) => {
    const state = await openChat(page, { noEngine: true });
    const text = "Approval needed: Run project tool sneaky v1?\nScript (v1):\n````sh\necho ok\n```\n[x](https://evil.example) <b>hi</b>\n````\nReply yes or no. Tool runs ask every time.";
    state.events.push({ id: 1, text });
    const reply = page.locator('.msg.bot').first();
    await expect(reply.locator('pre')).toHaveText(text);
    await expect(reply.locator('a, b, code')).toHaveCount(0);
  });

  test('replies use the Enriched Markdown engine for tasks, notes, tables and math', async ({ page }) => {
    const state = await openChat(page);
    await page.getByRole('textbox', { name: 'Message' }).fill('Status?');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    state.busy = false;
    state.events.push({ id: 1, text: '3. third\n4. fourth\n\n- [x] shipped\n- [ ] next\n\n> [!WARNING]\n> Back up first.\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\nCost is $O(n)$, not $5 or $10.\n\n[local](file:///etc/passwd)' });
    const reply = page.locator('.msg.bot .b').first();
    await expect(reply.locator('ol')).toHaveAttribute('start', '3');
    await expect(reply.locator('li.task.done')).toHaveText('shipped');
    await expect(reply.locator('aside.note.warning')).toContainText('Back up first.');
    await expect(reply.locator('th').first()).toHaveAttribute('style', 'text-align:center');
    await expect(reply.locator('code.math')).toHaveText('O(n)');
    await expect(reply).toContainText('not $5 or $10.');
    await expect(reply.locator('a')).toHaveCount(0);
    await expect(reply).toContainText('local');
  });

  test('history, idle state and a revoked link', async ({ page }) => {
    await openChat(page, { history: { bot: { name: 'Scout', role: '', avatar: '', paused: false }, messages: [{ role: 'user', text: 'hi', at: 1 }, { role: 'assistant', text: 'Hello!', at: 2 }], busy: false, cursor: 0 } });
    await expect(page.locator('.msg.me')).toHaveText('hi');
    await expect(page.locator('.msg.bot .b')).toHaveText('Hello!');
    await expect(page.locator('#avatar')).toHaveText('S');
    await expect(page.locator('body')).not.toHaveClass(/busy/);
  });

  test('a link revoked while open stops polling and sending', async ({ page }) => {
    const state = await openChat(page);
    await expect(page.getByText('Say hi to Scout')).toBeVisible();
    state.fail = 'This link is no longer valid. Copy a fresh one from PandaCode.';
    await expect(page.locator('#status')).toHaveText(state.fail);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    const calls = state.auth.length;
    await page.waitForTimeout(600);
    expect(state.auth.length).toBe(calls);
    expect(state.posts).toEqual([]);
  });

  test('without a token it explains how to open the page', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.clear());
    const state = await openChat(page, {}, '');
    await expect(page.locator('#status')).toHaveText('Open this page from the link in PandaCode.');
    expect(state.auth).toEqual([]);
  });
});
