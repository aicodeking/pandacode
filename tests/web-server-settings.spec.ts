import { expect, test, type Locator, type Page } from '@playwright/test';

/* Settings → Remote access → Web access against the preview's in-memory server (src/preview-web-server.ts). */
async function openWebAccess(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await expect(panel.getByRole('heading', { name: 'Web access' })).toBeVisible();
  const section = panel.locator('.web-server-settings');
  await expect(section.getByRole('checkbox', { name: 'Serve in browser' })).toBeVisible();
  return section;
}
const toggleOf = (section: Locator) => section.getByRole('checkbox', { name: 'Serve in browser' });
const portOf = (section: Locator) => section.getByRole('textbox', { name: 'Web server port' });

async function turnOn(section: Locator) {
  await toggleOf(section).check();
  await expect(section.getByText(/Listening on 127\.0\.0\.1:\d+/)).toBeVisible();
}

test.describe('web access', () => {
  // Settings loads lazily; under heavy parallel load the first open can take most of the default 20 s.
  test.describe.configure({ timeout: 40_000 });
  test('is off by default with the default port', async ({ page }) => {
    const section = await openWebAccess(page);
    await expect(toggleOf(section)).not.toBeChecked();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await expect(portOf(section)).toHaveValue('47322');
    await expect(section.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await expect(section.locator('.web-server-link')).toHaveCount(0);
  });

  test('serving shows the session link, actions and SSH hint', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await expect(toggleOf(section)).toBeChecked();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
    await expect(section.getByRole('img', { name: 'Running' })).toBeVisible();
    const link = section.locator('.web-server-link');
    await expect(link.locator('code.web-server-url')).toHaveText('http://127.0.0.1:47322');
    await expect(link).toContainText('Token in link');
    await expect(link.getByRole('button', { name: 'Open' })).toBeVisible();
    await expect(link.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(link.getByRole('button', { name: 'New token' })).toBeVisible();
    await expect(link).toContainText('ssh -L 47322:127.0.0.1:47322 <host>');

    await page.evaluate(() => (window as any).__webServerClients(2));
    await expect(section).toContainText('2 browsers connected');
    await page.evaluate(() => (window as any).__webServerClients(1));
    await expect(section).toContainText('1 browser connected');
  });

  test('changing the port restarts on it, with Apply or Enter', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await portOf(section).fill('8080');
    await expect(section.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await section.getByRole('button', { name: 'Apply' }).click();
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:8080');
    await expect(section.getByText('Listening on 127.0.0.1:8080')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Apply' })).toBeDisabled();

    await portOf(section).fill('3000');
    await portOf(section).press('Enter');
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:3000');
    await expect(portOf(section)).toBeFocused();
    await expect(portOf(section)).toHaveValue('3000');
  });

  test('a port typed while off is used when the switch turns on', async ({ page }) => {
    const section = await openWebAccess(page);
    await portOf(section).fill('9100');
    await toggleOf(section).check();
    await expect(section.getByText('Listening on 127.0.0.1:9100')).toBeVisible();
    await expect(portOf(section)).toHaveValue('9100');
  });

  test('port 0 resolves to an automatic open port', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await portOf(section).fill('0');
    await portOf(section).press('Enter');
    await expect(section.getByText('Listening on 127.0.0.1:54321')).toBeVisible();
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:54321');
    await expect(portOf(section)).toHaveValue('0');
  });

  test('invalid ports show an inline error that can be dismissed', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    for (const bad of ['70000', 'abc']) {
      await portOf(section).fill(bad);
      await section.getByRole('button', { name: 'Apply' }).click();
      await expect(section.getByRole('alert')).toContainText('between 0 and 65535');
      await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
      await section.getByRole('button', { name: 'Dismiss error' }).click();
      await expect(section.getByRole('alert')).toHaveCount(0);
      await expect(portOf(section)).toBeFocused();
    }
    await portOf(section).press('Escape');
    await expect(portOf(section)).toHaveValue('47322');
  });

  test('a busy port reports clearly and keeps the running server', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerBusyPort = 9000; });
    await portOf(section).fill('9000');
    await portOf(section).press('Enter');
    await expect(section.getByRole('alert')).toHaveText('Port 9000 is already in use.');
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:47322');
    await expect(toggleOf(section)).toBeChecked();
    await expect(portOf(section)).toHaveValue('9000');

    await portOf(section).fill('9001');
    await portOf(section).press('Enter');
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.getByText('Listening on 127.0.0.1:9001')).toBeVisible();
  });

  test('a busy port while off leaves the switch off', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => { (window as any).__webServerBusyPort = 47322; });
    // The switch reverts when the server cannot start, so click rather than check().
    await toggleOf(section).click();
    await expect(section.getByRole('alert')).toHaveText('Port 47322 is already in use.');
    await expect(toggleOf(section)).not.toBeChecked();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
  });

  test('New token rotates the link; turning off hides it', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    const tokenUrl = () => page.evaluate(() => import('/src/bridge.ts' as string).then(b => b.call<{ tokenUrl: string }>('web_server_status')).then(s => s.tokenUrl));
    const before = await tokenUrl();
    expect(before).toMatch(/^http:\/\/127\.0\.0\.1:47322\/#token=/);
    await section.getByRole('button', { name: 'New token' }).click();
    await expect(page.getByText('Access token rotated')).toBeVisible();
    await expect.poll(tokenUrl).not.toBe(before);
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:47322');

    await toggleOf(section).uncheck();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await expect(section.locator('.web-server-link')).toHaveCount(0);
    await expect(toggleOf(section)).not.toBeChecked();
  });

  test('live changes from elsewhere update the section', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => import('/src/bridge.ts' as string).then(b => b.call('web_server_configure', { enabled: true, port: 5050 })));
    await expect(section.getByText('Listening on 127.0.0.1:5050')).toBeVisible();
    await expect(toggleOf(section)).toBeChecked();
    await expect(portOf(section)).toHaveValue('5050');
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:5050');
    await expect(section.getByRole('button', { name: 'Open' })).toBeEnabled();
    await expect(section.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`fits without horizontal overflow in ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(value => { localStorage.setItem('pandacode.theme', value); localStorage.setItem('pandacode.wallpapers', 'false'); }, theme);
      await page.setViewportSize({ width: 900, height: 760 });
      const section = await openWebAccess(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await turnOn(section);
      const overflow = await section.evaluate(el => {
        const panel = el.closest('[role="tabpanel"]') as HTMLElement;
        return { section: el.scrollWidth - el.clientWidth, panel: panel.scrollWidth - panel.clientWidth };
      });
      expect(overflow.section).toBeLessThanOrEqual(1);
      expect(overflow.panel).toBeLessThanOrEqual(1);
      const readable = await section.evaluate(el => [...el.querySelectorAll<HTMLElement>('strong, code.web-server-url, .web-server-port-input, .web-server-link button')]
        .map(node => { const s = getComputedStyle(node); return { color: s.color, size: parseFloat(s.fontSize), visible: node.getBoundingClientRect().width > 0 }; }));
      expect(readable.length).toBeGreaterThan(5);
      for (const item of readable) {
        expect(item.visible).toBe(true);
        expect(item.size).toBeGreaterThanOrEqual(10);
        expect(item.color).not.toBe('rgba(0, 0, 0, 0)');
      }
    });
  }

  test('a server started from the CLI shows as on with its live port', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8787));
    await expect(section.getByText('Listening on 127.0.0.1:8787')).toBeVisible();
    await expect(toggleOf(section)).toBeChecked();
    await expect(portOf(section)).toHaveValue('8787');
    await expect(section.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await portOf(section).fill('8888');
    await section.getByRole('button', { name: 'Apply' }).click();
    await expect(section.getByText('Listening on 127.0.0.1:8888')).toBeVisible();
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:8888');
    await expect(toggleOf(section)).toBeChecked();
    await expect(portOf(section)).toHaveValue('8888');
  });

  test('loopback says local only; a non-loopback host warns about plain HTTP', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await expect(section.locator('.web-server-note')).toContainText('Only reachable from this computer (127.0.0.1)');
    await expect(section.locator('.web-server-note-warn')).toHaveCount(0);

    await page.evaluate(() => (window as any).__webServerCliStart(8080, '0.0.0.0'));
    await expect(section.getByText('Listening on 0.0.0.0:8080').first()).toBeVisible();
    const warn = section.locator('.web-server-note-warn');
    await expect(warn).toContainText('Listening on 0.0.0.0 over plain HTTP');
    await expect(warn).toContainText('unencrypted unless on a private Tailscale/WireGuard network');
    await expect(section).not.toContainText('Only reachable from this computer');
    await expect(section.locator('code.web-server-url')).toHaveText('http://0.0.0.0:8080');
  });

  test('in a browser tab, turning the server off asks first', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; });

    await toggleOf(section).click();
    const confirm = section.getByRole('group', { name: 'Stop the web server?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('This browser tab will disconnect.');
    await expect(toggleOf(section)).toBeChecked();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(toggleOf(section)).toBeChecked();
    await expect(toggleOf(section)).toBeFocused();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();

    await toggleOf(section).click();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();

    await toggleOf(section).click();
    await confirm.getByRole('button', { name: 'Stop server' }).click();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await expect(toggleOf(section)).not.toBeChecked();
    await expect(section.locator('.web-server-link')).toHaveCount(0);
    await expect(toggleOf(section)).toBeFocused();
  });

  test('in a browser tab, changing the port asks first, then moves the tab', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; });
    await portOf(section).fill('9200');
    await portOf(section).press('Enter');
    const confirm = section.getByRole('group', { name: 'Move web server to port 9200?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('update it to point to the new port');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(portOf(section)).toBeFocused();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__webServerLastRedirect)).toBeUndefined();

    await portOf(section).press('Enter');
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(portOf(section)).toBeFocused();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();

    await section.getByRole('button', { name: 'Apply' }).click();
    await confirm.getByRole('button', { name: 'Change port' }).click();
    await expect(section.getByText('Listening on 127.0.0.1:9200')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__webServerLastRedirect)).toMatch(/:9200\/#token=/);
    await expect(page.getByText('Moving to port 9200…')).toBeVisible();
  });

  test('in a browser tab, port 0 asks to switch to an automatic port', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; });
    await portOf(section).fill('0');
    await portOf(section).press('Enter');
    const confirm = section.getByRole('group', { name: 'Switch to an automatic port?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Change port' }).click();
    await expect(section.getByText('Listening on 127.0.0.1:54321')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__webServerLastRedirect)).toMatch(/:54321\/#token=/);
  });

  test('events never carry the token link; the section keeps or fetches it', async ({ page }) => {
    const section = await openWebAccess(page);
    const events: { tokenUrl: unknown }[] = await page.evaluate(() => { const seen: { tokenUrl: unknown }[] = []; (window as any).__webEvents = seen; return import('/src/bridge.ts' as string).then(b => b.subscribe('web-server-changed', (e: { tokenUrl: unknown }) => seen.push(e))).then(() => seen); });
    expect(events).toEqual([]);
    await page.evaluate(() => (window as any).__webServerCliStart(8787));
    const link = section.locator('.web-server-link');
    await expect(link.getByRole('button', { name: 'Copy link' })).toBeEnabled();
    await expect(link.getByRole('button', { name: 'Open' })).toBeEnabled();
    await page.evaluate(() => (window as any).__webServerClients(3));
    await expect(section).toContainText('3 browsers connected');
    await expect(link.getByRole('button', { name: 'Copy link' })).toBeEnabled();
    const seen = await page.evaluate(() => (window as any).__webEvents as { tokenUrl: unknown }[]);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const event of seen) expect(event.tokenUrl).toBeNull();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedText = text; } } }); });
    await link.getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText as string)).toMatch(/^http:\/\/127\.0\.0\.1:8787\/#token=/);
  });

  test('without a clipboard (plain HTTP), Copy link falls back to a selection copy', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const original = document.execCommand.bind(document);
      (window as any).__execCopies = [];
      document.execCommand = ((command: string, ...rest: unknown[]) => {
        if (command === 'copy') { const area = document.activeElement as HTMLTextAreaElement; (window as any).__execCopies.push({ value: area?.value, readOnly: area?.readOnly }); return true; }
        return (original as any)(command, ...rest);
      }) as typeof document.execCommand;
    });
    const copy = section.getByRole('button', { name: 'Copy link' });
    await copy.click();
    await expect(page.getByText('Session link copied')).toBeVisible();
    const copies = await page.evaluate(() => (window as any).__execCopies as { value: string; readOnly: boolean }[]);
    expect(copies).toHaveLength(1);
    expect(copies[0].value).toMatch(/^http:\/\/127\.0\.0\.1:47322\/#token=/);
    expect(copies[0].readOnly).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll('body > textarea').length)).toBe(0);
    await expect(copy).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('when neither the clipboard nor the selection copy works, Copy link reports it', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = (() => false) as typeof document.execCommand;
    });
    await section.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Couldn’t copy the link; use Open instead')).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll('body > textarea').length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('an IPv6 loopback host is written in brackets', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8787, '::1'));
    await expect(section.getByText('Listening on [::1]:8787')).toBeVisible();
    await expect(section.locator('.web-server-note')).toContainText('Only reachable from this computer ([::1])');
    await expect(section.locator('.web-server-note code')).toHaveText('ssh -L 8787:[::1]:8787 <host>');
    await expect(section.locator('code.web-server-url')).toHaveText('http://[::1]:8787');
  });

  test('a non-loopback warning matches the CLI wording', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8080, '::'));
    await expect(section.locator('.web-server-note-warn')).toHaveText('Listening on [::] over plain HTTP — traffic and the access token are unencrypted unless on a private Tailscale/WireGuard network. Prefer 127.0.0.1 with an SSH tunnel.');
  });

  test('changing the port of a CLI session keeps it one-off', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8787));
    await expect(portOf(section)).toHaveValue('8787');
    await portOf(section).fill('8890');
    await portOf(section).press('Enter');
    await expect(section.getByText('Listening on 127.0.0.1:8890')).toBeVisible();
    await expect(toggleOf(section)).toBeChecked();
    await expect(portOf(section)).toHaveValue('8890');
    const saved = await page.evaluate(() => import('/src/bridge.ts' as string).then(b => b.call('web_server_status'))) as { enabled: boolean; running: boolean; port: number; configuredPort: number };
    expect(saved).toMatchObject({ enabled: false, running: true, port: 8890, configuredPort: 47322 });
  });

  test('stopping resets the listen host to 127.0.0.1', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8080, '0.0.0.0'));
    await expect(section.locator('.web-server-note-warn')).toBeVisible();
    await toggleOf(section).click();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await toggleOf(section).click();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
    await expect(section.locator('.web-server-note-warn')).toHaveCount(0);
  });

  test('in a browser tab, the link uses the tab\'s own address', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => {
      (window as any).__webServerTestInWebMode = true;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedText = text; } } });
    });
    await turnOn(section);
    const origin = await page.evaluate(() => location.origin);
    expect(origin).not.toBe('http://127.0.0.1:47322');
    await expect(section.locator('code.web-server-url')).toHaveText(origin);
    await section.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Session link copied')).toBeVisible();
    const copied = await page.evaluate(() => (window as any).__copiedText as string);
    expect(copied.startsWith(`${origin}/#token=`)).toBe(true);
    expect(copied).not.toContain(':47322');
  });

  test('in the desktop app, the link is the server\'s own address', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedText = text; } } }); });
    await turnOn(section);
    await expect(section.locator('code.web-server-url')).toHaveText('http://127.0.0.1:47322');
    await section.getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText as string)).toMatch(/^http:\/\/127\.0\.0\.1:47322\/#token=/);
  });

  test('in a browser tab, the loopback note names the PandaCode machine', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; });
    await turnOn(section);
    const note = section.locator('.web-server-note');
    await expect(note).toContainText('Only reachable from the PandaCode machine (127.0.0.1)');
    await expect(note).not.toContainText('this computer');
    await expect(note.locator('code')).toHaveText('ssh -L 47322:127.0.0.1:47322 <host>');
  });

  test('Stop server keeps normal ink with a danger icon', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; });
    await toggleOf(section).click();
    const stop = section.getByRole('button', { name: 'Stop server', exact: true });
    await expect(stop).toBeVisible();
    await expect(stop.locator('[data-state-tone="danger"] svg')).toBeVisible();
    const colors = await stop.evaluate(button => ({ label: getComputedStyle(button).color, cancel: getComputedStyle(button.previousElementSibling as HTMLElement).color, icon: getComputedStyle(button.querySelector('[data-state-tone]')!).color }));
    expect(colors.label).toBe(colors.cancel);
    expect(colors.icon).not.toBe(colors.label);
  });

  test('external token rotation updates Copy link', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedText = text; } } }); });
    await turnOn(section);
    const copy = section.getByRole('button', { name: 'Copy link' });
    await copy.click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText as string)).toMatch(/#token=/);
    const before = await page.evaluate(() => (window as any).__copiedText as string);

    // Rotated from outside this section (another window): the event is redacted but bumps tokenGeneration.
    const rotated = await page.evaluate(() => import('/src/bridge.ts' as string).then(b => b.call('web_server_rotate_token'))) as { tokenUrl: string; tokenGeneration: number };
    expect(rotated.tokenUrl).not.toBe(before);
    expect(rotated.tokenGeneration).toBeGreaterThan(1);
    await expect(copy).toBeEnabled();
    await page.evaluate(() => { (window as any).__copiedText = ''; });
    await copy.click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedText as string)).toBe(rotated.tokenUrl);
  });

  test('desktop with connected browsers confirms before stopping', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => (window as any).__webServerClients(2));
    await expect(section).toContainText('2 browsers connected');

    await toggleOf(section).click();
    const confirm = section.getByRole('group', { name: 'Stop the web server?' });
    await expect(confirm).toContainText('2 browsers are currently connected and will be disconnected.');
    await expect(toggleOf(section)).toBeChecked();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
    await expect(toggleOf(section)).toBeChecked();

    await toggleOf(section).click();
    await confirm.getByRole('button', { name: 'Stop server' }).click();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await expect(toggleOf(section)).not.toBeChecked();
  });

  test('desktop with a connected browser confirms before changing port', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => (window as any).__webServerClients(1));
    await expect(section).toContainText('1 browser connected');
    await portOf(section).fill('9300');
    await portOf(section).press('Enter');
    const confirm = section.getByRole('group', { name: 'Move web server to port 9300?' });
    await expect(confirm).toContainText('1 connected browser will disconnect and need the new link.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(portOf(section)).toBeFocused();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();

    await section.getByRole('button', { name: 'Apply' }).click();
    await confirm.getByRole('button', { name: 'Change port' }).click();
    await expect(section.getByText('Listening on 127.0.0.1:9300')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__webServerLastRedirect)).toBeUndefined();
  });

  test('rotating the token asks first when browsers are connected', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    const tokenUrl = () => page.evaluate(() => import('/src/bridge.ts' as string).then(b => b.call<{ tokenUrl: string }>('web_server_status')).then(s => s.tokenUrl));
    const before = await tokenUrl();
    await page.evaluate(() => (window as any).__webServerClients(2));
    await expect(section).toContainText('2 browsers connected');

    const rotate = section.locator('[data-web-rotate]');
    await rotate.click();
    const confirm = section.getByRole('group', { name: 'Generate a new access token?' });
    await expect(confirm).toContainText('2 connected browsers will disconnect and need the new link.');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(rotate).toBeFocused();
    expect(await tokenUrl()).toBe(before);

    await rotate.click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(rotate).toBeFocused();
    expect(await tokenUrl()).toBe(before);

    await rotate.click();
    await expect(confirm.locator('[data-web-confirm-rotate] [data-state-tone="danger"]')).toHaveCount(1);
    await confirm.locator('[data-web-confirm-rotate]').click();
    await expect(page.getByText('Access token rotated')).toBeVisible();
    await expect.poll(tokenUrl).not.toBe(before);
    await expect(confirm).toHaveCount(0);
  });

  test('in a browser tab, a new token with only this tab connected rotates at once', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; (window as any).__webServerClients(1); });
    await expect(section).toContainText('1 browser connected');
    await section.locator('[data-web-rotate]').click();
    await expect(page.getByText('Access token rotated')).toBeVisible();
    await expect(section.getByRole('group', { name: 'Generate a new access token?' })).toHaveCount(0);

    await page.evaluate(() => (window as any).__webServerClients(3));
    await section.locator('[data-web-rotate]').click();
    await expect(section.getByRole('group', { name: 'Generate a new access token?' })).toContainText('2 other connected browsers will disconnect and need the new link. This tab stays signed in.');
  });

  test('web-bridge modal respects increased contrast over global dialog styles', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    const result = await page.evaluate(async () => {
      await import('/src/web-bridge.css' as string);
      const dialog = document.createElement('dialog');
      dialog.className = 'web-modal web-auth-gate';
      dialog.innerHTML = '<form class="web-modal-card"><h2>Sign in</h2><input class="web-modal-input" aria-label="Token"></form>';
      document.body.append(dialog);
      dialog.showModal();
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
      const card = dialog.querySelector<HTMLElement>('.web-modal-card')!, input = dialog.querySelector<HTMLElement>('.web-modal-input')!;
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bg)';
      document.body.append(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const cardStyle = getComputedStyle(card) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
      const out = { padding: getComputedStyle(dialog).paddingTop, backdrop: cardStyle.backdropFilter || cardStyle.webkitBackdropFilter || 'none', input: getComputedStyle(input).backgroundColor, bg };
      dialog.close(); dialog.remove();
      return out;
    });
    expect(result.padding).toBe('24px');
    expect(result.backdrop).toBe('none');
    expect(result.input).toBe(result.bg);
  });

  test('a port error is tied to the port field and clears once valid', async ({ page }) => {
    const section = await openWebAccess(page);
    const port = portOf(section);
    await port.fill('70000');
    await section.getByRole('button', { name: 'Apply' }).click();
    const alert = section.getByRole('alert');
    await expect(alert).toContainText('between 0 and 65535');
    await expect(alert).toHaveAttribute('id', 'web-server-port-error');
    await expect(port).toHaveAttribute('aria-invalid', 'true');
    await expect(port).toHaveAttribute('aria-describedby', 'web-server-port-error');
    await expect(port).toHaveAccessibleDescription(/between 0 and 65535/);
    const border = await port.evaluate(el => getComputedStyle(el).borderTopColor);
    await port.fill('8080');
    await expect(alert).toHaveCount(0);
    await expect(port).not.toHaveAttribute('aria-invalid', /.*/);
    await expect(port).not.toHaveAttribute('aria-describedby', /.*/);
    expect(await port.evaluate(el => getComputedStyle(el).borderTopColor)).not.toBe(border);

    await port.fill('abc');
    await section.getByRole('button', { name: 'Apply' }).click();
    await expect(port).toHaveAttribute('aria-invalid', 'true');
    await section.getByRole('button', { name: 'Dismiss error' }).click();
    await expect(port).not.toHaveAttribute('aria-invalid', /.*/);
    await expect(port).not.toHaveAttribute('aria-describedby', /.*/);
  });

  test('the plain-HTTP warning puts the warn tone on its icon, not its text', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__webServerCliStart(8080, '0.0.0.0'));
    const warn = section.locator('.web-server-note-warn');
    await expect(warn).toBeVisible();
    const icon = warn.locator('.web-server-note-icon[data-state-tone="warn"][aria-hidden="true"] svg');
    await expect(icon).toHaveCount(1);
    const colors = await warn.evaluate(el => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ds-warn)';
      el.append(probe);
      const warnInk = getComputedStyle(probe).color;
      probe.style.color = 'var(--text)';
      const textInk = getComputedStyle(probe).color;
      probe.remove();
      return { text: getComputedStyle(el.querySelector(':scope > span:last-child')!).color, icon: getComputedStyle(el.querySelector('.web-server-note-icon')!).color, warnInk, textInk };
    });
    expect(colors.icon).toBe(colors.warnInk);
    expect(colors.text).toBe(colors.textInk);
    expect(colors.text).not.toBe(colors.warnInk);
  });

  test('the running subtitle keeps calm ink; the dot carries the tone', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    const state = section.locator('.web-server-state');
    await expect(state.locator('.ds-success')).toHaveCount(0);
    await expect(state.getByRole('img', { name: 'Running' })).toHaveAttribute('data-online', 'true');
  });

  test('in a browser tab, Stop and port confirmations count the other browsers', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webServerTestInWebMode = true; (window as any).__webServerClients(3); });
    await expect(section).toContainText('3 browsers connected');

    await toggleOf(section).click();
    const stop = section.getByRole('group', { name: 'Stop the web server?' });
    await expect(stop).toContainText('This browser tab will disconnect, along with 2 other connected browsers. You can turn it back on in the PandaCode desktop app or by restarting pandacode serve.');
    await stop.getByRole('button', { name: 'Cancel' }).click();

    await portOf(section).fill('9400');
    await portOf(section).press('Enter');
    const move = section.getByRole('group', { name: 'Move web server to port 9400?' });
    await expect(move).toContainText('This browser tab will move to the new port. 2 other connected browsers will disconnect and need the new link.');
    const change = move.getByRole('button', { name: 'Change port', exact: true });
    await expect(change.locator('.web-server-confirm-icon[data-state-tone="danger"][aria-hidden="true"] svg')).toHaveCount(1);
    // The label keeps --text ink (polled: colours may still be settling after the row appears); the icon carries the tone.
    const inks = () => change.evaluate(button => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text)';
      button.append(probe);
      const text = getComputedStyle(probe).color;
      probe.remove();
      return { label: getComputedStyle(button).color, text, icon: getComputedStyle(button.querySelector('[data-state-tone]')!).color, display: getComputedStyle(button).display, align: getComputedStyle(button).alignItems };
    });
    await expect.poll(async () => { const c = await inks(); return c.label === c.text; }).toBe(true);
    const colors = await inks();
    expect(colors.icon).not.toBe(colors.label);
    // inline-flex in the CSS; as a flex item of the actions row it computes to (blockified) flex.
    expect(['flex', 'inline-flex']).toContain(colors.display);
    expect(colors.align).toBe('center');
    await move.getByRole('button', { name: 'Cancel' }).click();

    await page.evaluate(() => (window as any).__webServerClients(2));
    await toggleOf(section).click();
    await expect(stop).toContainText('along with 1 other connected browser.');
    await stop.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => (window as any).__webServerClients(1));
    await toggleOf(section).click();
    await expect(stop).toContainText('This browser tab will disconnect. You can turn it back on');
  });

  test('the confirmation row keeps its inset surface and hairline', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => (window as any).__webServerClients(2));
    await toggleOf(section).click();
    const confirm = section.locator('.web-server-confirm');
    await expect(confirm).toHaveCount(1);
    const look = await confirm.evaluate(el => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--ds-card-inset)';
      el.append(probe);
      const inset = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, inset, borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle };
    });
    expect(look.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.background).toBe(look.inset);
    expect(look.borderWidth).toBe('1px');
    expect(look.borderStyle).toBe('solid');
  });

  test('only one confirmation is open at a time', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => (window as any).__webServerClients(2));
    await toggleOf(section).click();
    await expect(section.getByRole('group', { name: 'Stop the web server?' })).toBeVisible();
    await section.locator('[data-web-rotate]').click();
    await expect(section.getByRole('group', { name: 'Generate a new access token?' })).toBeVisible();
    await expect(section.getByRole('group', { name: 'Stop the web server?' })).toHaveCount(0);
    await expect(section.locator('.web-server-confirm')).toHaveCount(1);

    await portOf(section).fill('9500');
    await portOf(section).press('Enter');
    await expect(section.getByRole('group', { name: 'Move web server to port 9500?' })).toBeVisible();
    await expect(section.locator('.web-server-confirm')).toHaveCount(1);

    // Escape cancels it even with focus outside the section, and leaves Settings open.
    await page.getByRole('tab', { name: 'Remote access' }).focus();
    await page.keyboard.press('Escape');
    await expect(section.locator('.web-server-confirm')).toHaveCount(0);
    await expect(page.getByRole('tabpanel', { name: 'Remote access' })).toBeVisible();
    await expect(section.getByText('Listening on 127.0.0.1:47322')).toBeVisible();
  });

  test('a start failure puts the danger tone on a leading icon, the message in normal ink', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__previewEmit('web-server-changed', { enabled: true, running: false, host: '127.0.0.1', port: 0, configuredPort: 47322, url: null, tokenUrl: null, clients: 0, error: 'Port 47322 is already in use.', tokenGeneration: 0 }));
    const state = section.locator('.web-server-state');
    await expect(state).toContainText('Port 47322 is already in use.');
    await expect(state.locator('.ds-danger')).toHaveCount(0);
    await expect(state.locator('.web-server-state-icon[data-state-tone="danger"][aria-hidden="true"] svg')).toHaveCount(1);
    const inks = await state.evaluate(el => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ds-danger)';
      el.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { text: getComputedStyle(el.querySelector('.web-server-state-icon + span')!).color, icon: getComputedStyle(el.querySelector('.web-server-state-icon')!).color, danger };
    });
    expect(inks.icon).toBe(inks.danger);
    expect(inks.text).not.toBe(inks.danger);
  });

  test('a failed one-off CLI launch shows its error even with the saved setting off', async ({ page }) => {
    const section = await openWebAccess(page);
    await page.evaluate(() => (window as any).__previewEmit('web-server-changed', { enabled: false, running: false, host: '127.0.0.1', port: 0, configuredPort: 47322, url: null, tokenUrl: null, clients: 0, error: 'Port 8080 is already in use.', tokenGeneration: 0 }));
    const state = section.locator('.web-server-state');
    await expect(state).toContainText('Port 8080 is already in use.');
    await expect(state.locator('.web-server-state-icon[data-state-tone="danger"]')).toHaveCount(1);
    await expect(state).not.toContainText('Off · binds only to');
    await expect(toggleOf(section)).not.toBeChecked();
  });

  test('row headings stay short; the long tips live on the info marks', async ({ page }) => {
    const section = await openWebAccess(page);
    for (const [heading, mark, tip] of [
      ['Serve in browser', 'About serving in a browser', /secret access token/],
      ['Port', 'About the web server port', /A browser tab that applies the change moves to the new port; other connected browsers disconnect and need the new link\./],
    ] as const) {
      const strong = section.locator('.web-server-row strong', { hasText: new RegExp(`^${heading}$`) });
      await expect(strong).toHaveCount(1);
      await expect(strong.locator('.sr-only')).toHaveCount(0);
      const info = section.getByRole('img', { name: mark });
      await expect(info).toHaveAttribute('aria-description', tip);
      await expect(info).toHaveAttribute('data-tip', tip);
    }
  });

  test('stopping from a browser tab tells the web bridge the server is gone', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => {
      (window as any).__webServerTestInWebMode = true;
      (window as any).__webStopped = [];
      window.addEventListener('pandacode:web-stopped', event => (window as any).__webStopped.push((event as CustomEvent).detail));
    });
    await toggleOf(section).click();
    const confirm = section.getByRole('group', { name: 'Stop the web server?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => (window as any).__webStopped)).toEqual([]);

    await toggleOf(section).click();
    await confirm.getByRole('button', { name: 'Stop server' }).click();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await expect.poll(() => page.evaluate(() => (window as any).__webStopped)).toEqual(['You can turn it back on in the PandaCode desktop app or by restarting pandacode serve.']);
  });

  test('stopping from the desktop app does not signal the web bridge', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => { (window as any).__webStopped = []; window.addEventListener('pandacode:web-stopped', event => (window as any).__webStopped.push((event as CustomEvent).detail)); });
    await toggleOf(section).click();
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    expect(await page.evaluate(() => (window as any).__webStopped)).toEqual([]);
  });

  test('a load error keeps its icon compact beside the message', async ({ page }) => {
    const section = await openWebAccess(page);
    const look = await section.evaluate(async el => {
      const { mountWebServerSettings } = await import('/src/web-server-settings.ts' as string);
      const slot = document.createElement('div');
      el.parentElement!.append(slot);
      mountWebServerSettings(slot, { call: () => Promise.reject(new Error('Web access is unavailable.')), listen: async () => () => {}, notify: () => {}, openUrl: async () => {} });
      for (let i = 0; i < 50 && !slot.querySelector('.remote-load-error'); i++) await new Promise(resolve => setTimeout(resolve, 20));
      const icon = slot.querySelector<HTMLElement>('.remote-load-error>.web-server-state-icon')!;
      const text = icon.nextElementSibling as HTMLElement;
      const out = { grow: getComputedStyle(icon).flexGrow, width: icon.getBoundingClientRect().width, textWidth: text.getBoundingClientRect().width, tone: icon.dataset.stateTone, message: slot.querySelector('.remote-load-error')!.textContent };
      slot.remove();
      return out;
    });
    expect(look.grow).toBe('0');
    expect(look.width).toBeLessThanOrEqual(24);
    expect(look.textWidth).toBeGreaterThan(look.width * 3);
    expect(look.tone).toBe('danger');
    expect(look.message).toContain('Web access is unavailable.');
  });

  test('a confirmation dropped by an external stop no longer swallows Escape', async ({ page }) => {
    const section = await openWebAccess(page);
    await turnOn(section);
    await page.evaluate(() => (window as any).__webServerClients(2));
    await toggleOf(section).click();
    await expect(section.locator('.web-server-confirm')).toHaveCount(1);
    await page.evaluate(() => (window as any).__previewEmit('web-server-changed', { enabled: false, running: false, host: '127.0.0.1', port: 0, configuredPort: 47322, url: null, tokenUrl: null, clients: 0, error: null, tokenGeneration: 0 }));
    await expect(section.locator('.web-server-confirm')).toHaveCount(0);
    await expect(section).toContainText('Off · binds only to 127.0.0.1');
    await page.getByRole('tab', { name: 'Remote access' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tabpanel', { name: 'Remote access' })).toBeHidden();
  });
});

/* The web bridge's real prompts (src/web-bridge.ts openPrompt), opened over a Settings dialog. */
test.describe('web access prompts', () => {
  test.describe.configure({ timeout: 40_000 });
  async function openSettingsDialog(page: Page): Promise<Locator> {
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const settingsDialog = page.locator('dialog#dialog[open]');
    await expect(settingsDialog.getByRole('heading', { name: 'Tools & integrations' })).toBeVisible();
    return settingsDialog;
  }
  /** Focuses a control inside the Settings dialog (the prompt's trigger) and returns its marker. */
  /** Focuses a stable control in the Settings dialog (the prompt's trigger). The dialog first shows a
   *  loading body, then integrations.ts swaps in its own heading once and only re-renders the body below
   *  it, so the trigger is that final heading's Close button, tagged after the content has loaded. */
  async function focusTrigger(page: Page): Promise<void> {
    const dialog = page.locator('dialog#dialog[open]');
    await expect(dialog.locator('.dialog-loading')).toHaveCount(0);
    await expect(dialog.getByText('Browser preview · integration status is sample data.')).toBeVisible();
    const trigger = dialog.locator('.dialog-heading button[data-action="close-dialog"][aria-label="Close"]');
    await expect(trigger).toHaveCount(1);
    await trigger.evaluate(el => { (el as HTMLElement).dataset.promptTrigger = 'yes'; (el as HTMLElement).focus(); });
    await expect(page.locator('[data-prompt-trigger="yes"]')).toBeFocused();
  }

  test('webChoosePath stacks above Settings, validates, ignores IME Escape and returns focus', async ({ page }) => {
    const settingsDialog = await openSettingsDialog(page);
    await focusTrigger(page);
    await page.evaluate(() => { (window as any).__promptResult = import('/src/web-bridge.ts' as string).then(b => b.webChoosePath('Choose a file')); });

    const prompt = page.locator('dialog.web-modal.web-path-prompt[open]');
    await expect(prompt).toBeVisible();
    const input = prompt.locator('.web-modal-input');
    await expect(input).toBeFocused();
    const layering = await prompt.evaluate(el => {
      const card = el.querySelector('.web-modal-card')!.getBoundingClientRect();
      const top = document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2);
      return { modal: el.matches(':modal'), settingsModal: document.querySelector('dialog#dialog')!.matches(':modal'), onTop: Boolean(top && el.contains(top)) };
    });
    expect(layering).toEqual({ modal: true, settingsModal: true, onTop: true });

    await prompt.getByRole('button', { name: 'Choose' }).click();
    const alert = prompt.locator('.web-modal-error[role="alert"]');
    await expect(alert).toHaveText('Enter a path.');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const notice = prompt.locator('.web-modal-notice[role="status"]');
    await expect(notice).toBeHidden();
    await expect(notice).toHaveText('');
    expect(await alert.evaluate((el, other) => el !== other, await notice.elementHandle())).toBe(true);

    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
    await expect(prompt).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.web-modal')).toHaveCount(0);
    await expect(settingsDialog).toBeVisible();
    await expect(page.locator('[data-prompt-trigger="yes"]')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__promptResult)).toBeNull();
  });

  test('webChoosePaths: Enter adds a line, Ctrl+Enter submits the parsed paths', async ({ page }) => {
    const settingsDialog = await openSettingsDialog(page);
    await focusTrigger(page);
    await page.evaluate(() => { (window as any).__promptResult = import('/src/web-bridge.ts' as string).then(b => b.webChoosePaths('Attach files', true)); });
    const prompt = page.locator('dialog.web-modal.web-path-prompt[open]');
    const box = prompt.locator('textarea.web-modal-input');
    await expect(box).toBeFocused();
    await box.pressSequentially('/tmp/a.png');
    await box.press('Enter');
    await expect(prompt).toBeVisible();
    await box.pressSequentially('  /tmp/b.md  ');
    await expect(box).toHaveValue('/tmp/a.png\n  /tmp/b.md  ');
    await box.press('Control+Enter');
    await expect(page.locator('dialog.web-modal')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__promptResult)).toEqual(['/tmp/a.png', '/tmp/b.md']);
    await expect(settingsDialog).toBeVisible();
    await expect(page.locator('[data-prompt-trigger="yes"]')).toBeFocused();
  });

  test('the token gate cannot be dismissed with Escape', async ({ page }) => {
    await openSettingsDialog(page);
    await page.evaluate(() => {
      sessionStorage.removeItem('pandacode.web.token');
      void import('/src/web-bridge.ts' as string).then(b => b.ensureAuth());
    });
    const gate = page.locator('dialog.web-modal.web-auth-gate[open]');
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('heading', { name: 'Connect to PandaCode' })).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(gate.locator('.web-modal-input')).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
    await expect(gate).toBeVisible();
    await expect(page.locator('dialog#dialog[open]')).toBeVisible();
  });
});
