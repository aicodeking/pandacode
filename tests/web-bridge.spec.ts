import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

/*
 * Browser mode (web-bridge.ts) against the Vite dev server. The page gets `<meta name="pandacode-web">`, so it
 * talks HTTP/WS instead of using the preview: `/api/auth` accepts the token, `/api/invoke` is answered by the
 * preview's in-memory backend (src/preview.ts, optionally in a separate desktop page), and `/api/events` is
 * a mocked WebSocket that records subscriptions and forwards host events.
 */
/** `fail`: commands answered with this status and body instead (closing the socket with `closeFirst` before replying);
 *  `refuseSockets`: new event sockets are closed at once, so the tab stays offline. */
type Controls = { fail: Map<string, { status: number; body: unknown; closeFirst?: number }>; refuseSockets: boolean };
type WebPage = { page: Page; subscriptions: Set<string>; commands: string[]; socket: () => WebSocketRoute; controls: Controls };

async function openWebMode(page: Page, host = page): Promise<WebPage> {
  await page.route(url => url.pathname === '/', async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('<head>', '<head><meta name="pandacode-web" content="1"/>');
    await route.fulfill({ response, body: html });
  });
  await page.route('**/api/auth', route => route.fulfill({ status: 200, body: '' }));
  const commands: string[] = [];
  const controls: Controls = { fail: new Map(), refuseSockets: false };
  let current: WebSocketRoute | undefined;
  await page.route('**/api/invoke', async route => {
    const { command, args } = route.request().postDataJSON() as { command: string; args: Record<string, unknown> };
    commands.push(command);
    const failure = controls.fail.get(command);
    if (failure) {
      if (failure.closeFirst) await current?.close({ code: failure.closeFirst, reason: 'Token rotated' });
      await route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify(failure.body) });
      return;
    }
    const reply = await host.evaluate(async ([name, values]) => {
      const preview = await import('/src/preview.ts');
      try { return { ok: true, value: await preview.invoke(name, values) }; } catch (error) { return { ok: false, value: String((error as Error)?.message ?? error) }; }
    }, [command, args] as const).catch(error => ({ ok: false, value: String(error) }));
    if (!reply.ok) { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: reply.value }) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: reply.value === undefined ? '' : JSON.stringify(reply.value) });
  });
  const subscriptions = new Set<string>();
  await page.routeWebSocket(/\/api\/events$/, ws => {
    if (controls.refuseSockets) { void ws.close({ code: 4000, reason: 'Unavailable' }); return; }
    current = ws;
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { type: string; token?: string; event?: string };
      if (frame.type === 'auth') ws.send(JSON.stringify({ type: frame.token === 'test-token' ? 'ready' : 'error' }));
      else if (frame.type === 'subscribe' && frame.event) subscriptions.add(frame.event);
      else if (frame.type === 'unsubscribe' && frame.event) subscriptions.delete(frame.event);
    });
  });
  await page.goto('/#token=test-token');
  await page.locator('#navigation .task-item').first().waitFor();
  // Once the app has subscribed to the session list, the startup subscriptions are in.
  await expect.poll(() => subscriptions.has('sessions-changed')).toBe(true);
  return { page, subscriptions, commands, socket: () => current!, controls };
}

const selected = (page: Page) => page.locator('#navigation .task-item.selected');

const queueRows = (page: Page) => page.getByRole('region', { name: 'Queued messages' }).locator('.queue-row .queue-text');

async function openQueueClients(page: Page, beforeConnect?: (host: Page, sessionId: string, agentStatus: (running: boolean) => Promise<void>) => Promise<void>) {
  const host = await page.context().newPage();
  await host.goto('/');
  await expect(host.locator('#prompt')).toBeEnabled();
  const sessionId = (await selected(host).getAttribute('data-id'))!;
  const agentStatus = (running: boolean) => host.evaluate(({ id, running }) => {
    (window as any).__previewSetStatus(id, running ? 'running' : 'idle');
    (window as any).__previewEmit('agent-event', { sessionId: id, kind: running ? 'status' : 'done', text: '' });
  }, { id: sessionId, running });
  await beforeConnect?.(host, sessionId, agentStatus);
  const web = await openWebMode(page, host);
  await expect.poll(() => web.subscriptions.has('queue-changed')).toBe(true);
  const queueEvents: { sessionId: string; held?: boolean }[] = [];
  const finishedRuns: string[] = [];
  await host.exposeFunction('forwardHostEvent', (name: string, payload: { sessionId: string; held?: boolean; kind?: string }) => {
    if (name === 'queue-changed') queueEvents.push(payload);
    if (name === 'agent-event' && payload.kind === 'done') finishedRuns.push(payload.sessionId);
    if (web.subscriptions.has(name)) web.socket().send(JSON.stringify({ type: 'event', name, payload }));
  });
  await host.evaluate(async () => {
    const { listen } = await import('/src/preview.ts');
    const forward = (window as any).forwardHostEvent;
    for (const name of ['queue-changed', 'agent-event']) listen(name, payload => void forward(name, payload));
  });
  const sentCount = (text: string) => host.evaluate(async ({ sessionId, text }) => {
    const { invoke } = await import('/src/preview.ts');
    const { messages } = await invoke<{ messages: { role: string; content: string }[] }>('get_messages', { sessionId });
    return messages.filter(message => message.role === 'user' && message.content === text).length;
  }, { sessionId, text });
  return { host, sessionId, web, queueEvents, finishedRuns, agentStatus, sentCount };
}

/** The sidebar renders no project heading today, so a stand-in row drives the real handler (thread-order.ts:
 *  a right-click on `.folder-row` opens the project menu for its `.folder-heading`). */
async function projectMenuItems(page: Page): Promise<string[]> {
  const projectId = await page.evaluate(async () => {
    const preview = await import('/src/preview.ts');
    const projects = await preview.invoke<{ id: string; path: string }[]>('list_projects', {});
    return projects.find(project => project.path)?.id;
  });
  expect(projectId).toBeTruthy();
  const menu = page.getByRole('dialog', { name: 'Project actions' }).or(page.getByRole('menu', { name: 'Project actions' })).first();
  // Added and right-clicked in one step, so a sidebar redraw in between cannot drop the row; retried if one closes the menu.
  await expect(async () => {
    await page.evaluate(id => {
      document.querySelector('[data-test-row]')?.remove();
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.dataset.testRow = '';
      row.innerHTML = `<button type="button" class="folder-heading" data-project="${id}">Project</button>`;
      document.querySelector('#navigation')!.prepend(row);
      const heading = row.querySelector('.folder-heading')!, box = heading.getBoundingClientRect();
      heading.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + 4 }));
    }, projectId);
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 12_000 });
  const labels = await menu.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  return labels.map(label => label.trim());
}

test.describe('web mode', () => {
  // Reconnect backoff and the 2 s offline notice need room under a 4-worker run (as web-server-settings.spec.ts).
  test.setTimeout(40_000);

  test('a browser follow-up notifies the desktop host and runs once after the current run', async ({ page }) => {
    const { host, sessionId, web, queueEvents, finishedRuns, agentStatus, sentCount } = await openQueueClients(page);
    await agentStatus(true);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    const prompt = page.locator('#prompt'), text = 'Follow up from the browser';
    await prompt.fill(text);
    await prompt.press('Enter');
    await expect.poll(() => queueEvents).toEqual([{ sessionId }]);
    await expect(queueRows(page)).toHaveText([text]);
    await expect(queueRows(host)).toHaveText([text]);
    expect(await sentCount(text)).toBe(0);

    await agentStatus(false);
    await expect.poll(() => finishedRuns).toEqual([sessionId, sessionId]);
    await expect(queueRows(page)).toHaveCount(0);
    await expect(queueRows(host)).toHaveCount(0);
    expect(await sentCount(text)).toBe(1);
    expect(web.commands.filter(command => ['queue_take', 'send_message'].includes(command))).toEqual([]);
  });

  test('opening and reloading a browser leaves a running host queue free to drain once', async ({ page }) => {
    const text = 'Follow up queued before the browser connected';
    const { host, sessionId, web, finishedRuns, agentStatus, sentCount } = await openQueueClients(page, async (host, _, agentStatus) => {
      await agentStatus(true);
      await expect(host.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
      const prompt = host.locator('#prompt');
      await prompt.fill(text);
      await prompt.press('Enter');
      await expect(queueRows(host)).toHaveText([text]);
    });

    await expect(queueRows(page)).toHaveText([text]);
    expect(web.commands).not.toContain('set_queue_hold');
    await page.reload();
    await expect(queueRows(page)).toHaveText([text], { timeout: 15_000 });
    expect(web.commands).not.toContain('set_queue_hold');
    for (const client of [host, page]) {
      await expect(client.getByText(/^Paused/)).toHaveCount(0);
      await expect(client.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
    }
    expect(await sentCount(text)).toBe(0);

    await agentStatus(false);
    await expect.poll(() => finishedRuns).toEqual([sessionId, sessionId]);
    await expect(queueRows(host)).toHaveCount(0);
    expect(await sentCount(text)).toBe(1);
  });

  test('a browser loads the host hold reason and shows live reason changes', async ({ page }) => {
    const text = 'Follow up in a held queue';
    const { host, sessionId } = await openQueueClients(page, async (host, sessionId) => {
      await host.evaluate(async sessionId => {
        const { invoke } = await import('/src/preview.ts');
        // Hold even an empty queue before the browser connects; a message added later must still show it.
        await invoke('set_queue_hold', { sessionId, held: true, reason: 'failed' });
      }, sessionId);
    });
    const resume = page.getByRole('button', { name: 'Resume', exact: true });
    await host.evaluate(async ({ sessionId, text }) => {
      const { invoke } = await import('/src/preview.ts');
      await invoke('queue_add', { sessionId, text, attachments: [] });
    }, { sessionId, text });
    await expect(queueRows(page)).toHaveText([text]);
    await expect(page.getByText('Paused after the run failed', { exact: true })).toBeVisible();
    await expect(resume).toBeVisible();

    await host.evaluate(async sessionId => {
      const { invoke } = await import('/src/preview.ts');
      await invoke('set_queue_hold', { sessionId, held: true, reason: 'limited' });
    }, sessionId);
    await expect(page.getByText('Paused until the usage limit resets', { exact: true })).toBeVisible();
    await expect(resume).toHaveCount(0);

    await page.reload();
    await expect(page.getByText('Paused until the usage limit resets', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(resume).toHaveCount(0);
  });

  test('browser Resume clears the host hold and the desktop drains the queue once', async ({ page }) => {
    const { host, sessionId, web, queueEvents, finishedRuns, sentCount } = await openQueueClients(page);
    const text = 'Resume this follow-up';
    await host.evaluate(async ({ sessionId, text }) => {
      const { invoke } = await import('/src/preview.ts');
      await invoke('set_queue_hold', { sessionId, held: true });
      await invoke('queue_add', { sessionId, text, attachments: [] });
    }, { sessionId, text });
    const resume = page.getByRole('button', { name: 'Resume', exact: true });
    await expect(resume).toBeVisible();
    await expect(host.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    expect(await sentCount(text)).toBe(0);

    const holdCall = page.waitForRequest(request => request.url().endsWith('/api/invoke') && request.postDataJSON().command === 'set_queue_hold');
    await resume.click();
    expect((await holdCall).postDataJSON()).toEqual({ command: 'set_queue_hold', args: { sessionId, held: false } });
    await expect.poll(() => finishedRuns).toEqual([sessionId]);
    await expect(queueRows(page)).toHaveCount(0);
    await expect(queueRows(host)).toHaveCount(0);
    expect(queueEvents.filter(event => event.held !== undefined)).toEqual([{ sessionId, held: true, reason: 'stopped' }, { sessionId, held: false }]);
    expect(await sentCount(text)).toBe(1);
    expect(web.commands.filter(command => ['set_queue_hold', 'queue_take', 'send_message'].includes(command))).toEqual(['set_queue_hold']);
  });

  test('connects with the session token and strips it from the address bar', async ({ page }) => {
    await openWebMode(page);
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.locator('.web-auth-gate')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('pandacode.web.token'))).toBe('test-token');
  });

  test('desktop navigation events never switch the task open in a browser tab', async ({ page }) => {
    const { subscriptions, socket } = await openWebMode(page);
    expect(subscriptions.has('overlay-open-task')).toBe(false);
    expect(subscriptions.has('tray-open-session')).toBe(false);
    const before = await selected(page).getAttribute('data-id');
    const other = await page.locator('#navigation .task-item').evaluateAll((rows, current) =>
      rows.map(row => (row as HTMLElement).dataset.id).find(id => id && id !== current), before);
    expect(other).toBeTruthy();
    // Even if a server forwarded them, nothing in the tab is listening.
    for (const name of ['overlay-open-task', 'tray-open-session']) {
      socket().send(JSON.stringify({ type: 'event', name, payload: name === 'overlay-open-task' ? { sessionId: other } : other }));
    }
    await page.waitForTimeout(300);
    await expect(selected(page)).toHaveAttribute('data-id', before!);
  });

  test('agent UI actions stay with the desktop window', async ({ page }) => {
    const { subscriptions, commands, socket } = await openWebMode(page);
    expect(subscriptions.has('agent-ui-action')).toBe(false);
    const sessionId = await selected(page).getAttribute('data-id');
    socket().send(JSON.stringify({ type: 'event', name: 'agent-ui-action', payload: { requestId: 'ui-1', sessionId, action: 'open_browser', args: { url: 'https://example.com' } } }));
    await page.waitForTimeout(400);
    expect(commands).not.toContain('resolve_agent_ui_action');
  });

  test('voice input is desktop-only: no mic, and the shortcut sends nothing', async ({ page }) => {
    const { commands } = await openWebMode(page);
    await expect(page.locator('#prompt')).toBeVisible();
    await expect(page.locator('#composer [data-voice="toggle"]')).toHaveCount(0);
    await page.locator('#prompt').focus();
    await page.keyboard.press('ControlOrMeta+Shift+D');
    await page.waitForTimeout(300);
    expect(commands.filter(command => command.startsWith('voice_'))).toEqual([]);
  });

  test('crash settings offer no Show crash report in a browser tab', async ({ page }) => {
    await openWebMode(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(page.locator('#crash-restart-settings')).toBeVisible();
    await expect(page.locator('#crash-restart-enabled')).toBeVisible();
    await expect(page.locator('#crash-reports-reveal')).toHaveCount(0);
  });

  test('web access: New token refused by the server asks for the new token instead of hanging', async ({ page }) => {
    const { controls } = await openWebMode(page);
    await page.evaluate(() => import('/src/preview.ts' as string).then(preview => preview.invoke('web_server_configure', { enabled: true })));
    // Another client rotated first: the server closes this tab's socket (4001) and refuses our rotation (401).
    controls.fail.set('web_server_rotate_token', { status: 401, body: { error: 'Invalid access token.' }, closeFirst: 4001 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await page.getByRole('tab', { name: 'Remote access' }).click();
    const section = page.getByRole('tabpanel', { name: 'Remote access' }).locator('.web-server-settings');
    await section.getByRole('button', { name: 'New token' }).click();
    const confirm = section.getByRole('group', { name: 'Generate a new access token?' });
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /new token|generate/i }).click();
    const gate = page.locator('dialog.web-auth-gate');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading', { name: 'Connect to PandaCode' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('pandacode.web.token'))).toBeNull();
    // Settings finished the request: its button is usable again behind the gate.
    await expect(section.locator('[data-web-rotate]')).toBeEnabled();
  });

  test('the reconnecting pill shows above an open modal dialog', async ({ page }) => {
    const { socket, controls } = await openWebMode(page);
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'test-modal';
      dialog.textContent = 'A modal dialog';
      document.body.append(dialog);
      dialog.showModal();
    });
    controls.refuseSockets = true;
    await socket().close({ code: 4000, reason: 'Server restarting' });
    const banner = page.locator('.web-conn-banner');
    await expect(banner).toHaveText('Reconnecting to PandaCode…', { timeout: 8_000 });
    await expect(page.locator('#test-modal .web-conn-banner')).toHaveCount(1);
    await expect(banner).toBeVisible();
    await expect(banner).toBeInViewport();
    // Another modal replaces this one's content (main.ts modal() rewrites innerHTML): the pill stays.
    await page.evaluate(() => { (document.querySelector('#test-modal') as HTMLDialogElement).innerHTML = '<p>Another modal</p>'; });
    await expect(page.locator('#test-modal .web-conn-banner')).toHaveCount(1);
    await expect(banner).toBeVisible();
    await expect(page.locator('#test-modal')).toContainText('Another modal');
    // The dialog closes: the pill moves back to the page.
    await page.evaluate(() => (document.querySelector('#test-modal') as HTMLDialogElement).close());
    await expect(page.locator('body > .web-conn-banner')).toHaveCount(1);
    // Back online: it goes away.
    controls.refuseSockets = false;
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
  });

  test('stopping web access leaves a calm "Web server stopped" notice, not endless reconnecting', async ({ page }) => {
    const { socket, controls } = await openWebMode(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode:web-stopped', {
      detail: 'You can turn it back on in the PandaCode desktop app or by restarting pandacode serve.',
    })));
    const banner = page.locator('.web-conn-banner');
    await expect(banner).toHaveText('Web server stopped. You can turn it back on in the PandaCode desktop app or by restarting pandacode serve.');
    await expect(banner).toHaveAttribute('data-stopped', 'true');
    await expect(banner).toHaveAttribute('role', 'status');
    expect(await banner.locator('.web-conn-dot').evaluate(dot => getComputedStyle(dot).animationName)).toBe('none');
    // The server goes away and new sockets are refused: it still says stopped, and nothing retries.
    controls.refuseSockets = true;
    await socket().close({ code: 4000, reason: 'Server stopped' }).catch(() => {});
    await page.waitForTimeout(2_600);
    await expect(banner).toHaveCount(1);
    await expect(banner).toHaveText(/^Web server stopped\./);
    await expect(banner).not.toContainText('Reconnecting');
  });

  test('the stopped notice stays inside a modal whose content is replaced', async ({ page }) => {
    await openWebMode(page);
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'swap-modal';
      dialog.innerHTML = '<p>First modal</p>';
      document.body.append(dialog);
      dialog.showModal();
      window.dispatchEvent(new CustomEvent('pandacode:web-stopped'));
    });
    const banner = page.locator('#swap-modal .web-conn-banner');
    await expect(banner).toHaveText('Web server stopped.');
    // As modal() does when one app dialog replaces another: same open <dialog>, new innerHTML.
    const connected = await page.evaluate(() => new Promise<boolean>(resolve => {
      const dialog = document.querySelector('#swap-modal') as HTMLDialogElement;
      dialog.innerHTML = '<p>Second modal</p>';
      // The observer runs as a microtask: by the next frame the pill is back.
      requestAnimationFrame(() => resolve(Boolean(dialog.querySelector('.web-conn-banner')?.isConnected)));
    }));
    expect(connected).toBe(true);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-stopped', 'true');
    await expect(page.locator('#swap-modal')).toContainText('Second modal');
  });

  test('the project menu has no Reveal in a browser tab', async ({ page }) => {
    await openWebMode(page);
    const labels = await projectMenuItems(page);
    expect(labels.some(label => /New task/.test(label))).toBe(true);
    expect(labels.some(label => /Reveal in Finder|Show in Explorer|Open folder/.test(label))).toBe(false);
  });
});

test.describe('desktop (preview) control', () => {
  test('a web access CLI start off loopback shows a warning toast, not an error', async ({ page }) => {
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    await expect.poll(() => page.evaluate(() => (window as any).__previewListenerCount('web-server-cli-started'))).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).__previewEmit('web-server-cli-started', { url: 'http://0.0.0.0:47322', host: '0.0.0.0', port: 47322 }));
    const toast = page.locator('#toast');
    await expect(toast).toContainText('Web access listening on http://0.0.0.0:47322 — plain HTTP on 0.0.0.0: traffic and access token are unencrypted unless on a private Tailscale/WireGuard network. Prefer 127.0.0.1 with an SSH tunnel.');
    await expect(toast).toHaveAttribute('data-warn', '');
    await expect(toast).not.toHaveAttribute('data-danger', /.*/);
    await expect(toast.locator('.toast-icon[data-state-tone="warn"]')).toHaveCount(1);
    await expect(toast.getByRole('button', { name: 'Copy link' })).toBeVisible();
    // On loopback it is a plain notice.
    await page.evaluate(() => (window as any).__previewEmit('web-server-cli-started', { url: 'http://127.0.0.1:47322', host: '127.0.0.1', port: 47322 }));
    await expect(toast).toContainText('Web access listening on http://127.0.0.1:47322');
    await expect(toast).not.toHaveAttribute('data-warn', /.*/);
    await expect(toast.locator('.toast-icon')).toHaveCount(0);
  });

  test('overlay-open-task still opens the task and the project menu still offers Reveal', async ({ page }) => {
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    const labels = await projectMenuItems(page);
    expect(labels.some(label => /Reveal in Finder|Show in Explorer|Open folder/.test(label))).toBe(true);
    const before = await selected(page).getAttribute('data-id');
    const other = await page.locator('#navigation .task-item').evaluateAll((rows, current) =>
      rows.map(row => (row as HTMLElement).dataset.id).find(id => id && id !== current), before);
    await expect.poll(() => page.evaluate(() => (window as any).__previewListenerCount('overlay-open-task'))).toBeGreaterThan(0);
    await page.evaluate(id => (window as any).__previewEmit('overlay-open-task', { sessionId: id }), other);
    await expect(selected(page)).toHaveAttribute('data-id', other!);
  });
});
