import { expect, test, type Page } from '@playwright/test';

// Cold page loads take several seconds on a busy machine.
test.describe.configure({ timeout: 60_000 });

/* Inline error banners (remote settings, rules import, bots) can be dismissed; each module is mounted
 * on the preview page with a call that fails. */
/* One banner everywhere: the card carries the border, the alert icon leads, the text alone is the alert,
 * and the dismiss button sits inside the card, vertically centred on it. */
async function expectBanner(host: ReturnType<Page['locator']>): Promise<void> {
  const card = host.locator('.error-row');
  await expect(card.locator('.error-row-head > .error-row-icon[data-state-tone="danger"] > .icon')).toBeVisible();
  const [iconColor, danger] = await Promise.all([
    card.locator('.error-row-icon').evaluate(el => getComputedStyle(el).color),
    card.evaluate(el => { const probe = document.createElement('i'); probe.style.color = 'var(--ds-danger)'; el.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }),
  ]);
  expect(iconColor).toBe(danger);
  await expect(card.getByRole('alert')).toHaveCount(1);
  expect(await card.getByRole('alert').evaluate(el => el.closest('button') === null && !el.querySelector('button'))).toBe(true);
  const [box, button] = await Promise.all([card.boundingBox(), card.getByRole('button', { name: 'Dismiss error', exact: true }).boundingBox()]);
  expect(button!.x + button!.width).toBeLessThanOrEqual(box!.x + box!.width);
  expect(Math.abs(button!.y + button!.height / 2 - (box!.y + box!.height / 2))).toBeLessThan(3);
  expect(await card.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
}

test.describe('error banners', () => {

test('remote settings error can be dismissed', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'eb-host';
    document.body.append(host);
    const mod = await import(/* @vite-ignore */ '/src/remote-settings.ts');
    const status = { configured: true, signedIn: false, connected: false, hostEnabled: false, notifyEnabled: false, remoteFullAccess: false, account: null, device: { fingerprint: 'aabbccdd' } };
    mod.mountRemoteSettings(host, {
      call: async (command: string) => { if (command === 'remote_status') return status; throw new Error('Sign-in failed'); },
      listen: async () => () => undefined, notify: () => undefined, openUrl: async () => undefined,
    });
  });
  const host = page.locator('#eb-host');
  await host.getByRole('button', { name: /Sign in with GitHub/ }).click();
  await expect(host.getByRole('alert')).toHaveText('Sign-in failed');
  await expectBanner(host);
  // The banner sits directly under the row of the action that failed, and Dismiss returns focus to that control.
  const signIn = host.getByRole('button', { name: /Sign in with GitHub/ });
  const [rowBox, bannerBox] = await Promise.all([signIn.locator('xpath=ancestor::*[contains(@class,"setting-row")][1]').boundingBox(), host.locator('.error-row').boundingBox()]);
  expect(bannerBox!.y).toBeGreaterThanOrEqual(rowBox!.y + rowBox!.height - 1);
  expect(bannerBox!.y - (rowBox!.y + rowBox!.height)).toBeLessThan(24);
  expect(await host.locator('.error-row').evaluate(el => el.previousElementSibling?.contains(document.querySelector('[data-sign-in]')))).toBe(true);
  await host.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(host.getByRole('alert')).toHaveCount(0);
  await expect(signIn).toBeFocused();
});

test('rules import error can be dismissed', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'eb-host';
    document.body.append(host);
    const [{ mountSkillsLibrary }, { createPreviewSkills }] = await Promise.all([import(/* @vite-ignore */ '/src/skills-library.ts'), import(/* @vite-ignore */ '/src/preview-skills.ts')]);
    const skills = createPreviewSkills();
    mountSkillsLibrary(host, { call: (c: string, a: Record<string, unknown> = {}) => skills.call(c, a), projects: () => [] });
  });
  const host = page.locator('#eb-host');
  await host.getByRole('button', { name: 'Import' }).click();
  await expect(host.getByRole('alert')).toHaveText('Enter the rule file’s path.');
  await expectBanner(host);
  await host.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(host.getByRole('alert')).toBeHidden();
  await expect(host.getByRole('button', { name: 'Import' })).toBeFocused();
});

test('bots error and model-load failure can be dismissed or retried', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'eb-host';
    document.body.append(host);
    const { mountBots } = await import(/* @vite-ignore */ '/src/bots.ts');
    (window as any).__modelCalls = 0;
    mountBots(host, {
      call: async () => { throw new Error('Bots unavailable'); },
      providers: [{ id: 'claude', name: 'Claude', installed: true, path: '', version: '', models: [] }],
      defaultModel: () => 'default',
      loadModels: async () => { (window as any).__modelCalls++; throw new Error('offline'); },
      running: () => false, openTask: () => undefined, openChat: () => undefined, notify: () => undefined,
    } as any);
  });
  const host = page.locator('#eb-host');
  await expect(host.locator('.error-row').getByRole('alert')).toContainText('Bots unavailable');
  await expectBanner(host);
  const note = host.locator('.bots-model-note');
  await expect(note.getByRole('alert')).toHaveText('Models could not load: offline');
  await expect(note.locator('.error-row-icon[data-state-tone="danger"]')).toBeVisible();
  const selects = await host.locator('select[name=provider], select[name=model]').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, left: r.left, right: r.right }; }));
  const noteBox = (await note.boundingBox())!;
  expect(noteBox.y).toBeGreaterThanOrEqual(Math.max(...selects.map(r => r.bottom)));
  expect(noteBox.x).toBeLessThanOrEqual(Math.min(...selects.map(r => r.left)) + 1);
  expect(noteBox.x + noteBox.width).toBeGreaterThanOrEqual(Math.max(...selects.map(r => r.right)) - 1);
  const before = await page.evaluate(() => (window as any).__modelCalls);
  await host.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__modelCalls)).toBeGreaterThan(before);
  await host.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(host.locator('.error-row')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test('error banner icons are red in dark and light', async ({ page }) => {
  await boot(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.evaluate(async () => {
      document.getElementById('eb-host')?.remove();
      const host = document.createElement('div');
      host.id = 'eb-host';
      document.body.append(host);
      const mod = await import(/* @vite-ignore */ '/src/remote-settings.ts');
      mod.mountRemoteSettings(host, {
        call: async (c: string) => { if (c === 'remote_status') return { configured: true, signedIn: false, connected: false, hostEnabled: false, notifyEnabled: false, remoteFullAccess: false, account: null, device: { fingerprint: 'aabbccdd' } }; throw new Error('Sign-in failed'); },
        listen: async () => () => undefined, notify: () => undefined, openUrl: async () => undefined,
      });
    });
    const host = page.locator('#eb-host');
    await host.getByRole('button', { name: /Sign in with GitHub/ }).click();
    await expectBanner(host);
    await host.locator('.error-row').screenshot({ path: `/tmp/error-banner-${theme}.png` });
  }
});

});
