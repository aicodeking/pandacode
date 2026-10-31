import { showHarness } from './model-picker-helper';
import { expect, test, type Page } from '@playwright/test';

// Settings is a full page (a region over the workspace) with a vertical list of groups.
const dialog = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name, exact: true });
const panel = (page: Page, name: string) => dialog(page).getByRole('tabpanel', { name, exact: true });
const back = (page: Page) => dialog(page).getByRole('button', { name: 'Back to the workspace', exact: true });
const GROUPS = ['General', 'Appearance', 'Agents', 'Providers', 'Agent teams', 'Schedules', 'Tools & add-ons', 'Skills & rules', 'Cloud sandboxes', 'Remote access', 'GitHub', 'About & updates'];
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const providerCalls = (page: Page) => page.evaluate(() => (window as any).__settingsProviders.calls);

test('settings organization keeps long default model names clear of labels', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.defaultProvider', 'claude');
    localStorage.setItem('pandacode.defaultModel.claude', 'custom-provider/model-' + 'x'.repeat(160));
  });
  await open(page);
  await settings(page);
  await tab(page, 'Agents').click();
  const model = page.getByRole('button', { name: 'Default model for new tasks', exact: true });
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 940 });
    const label = (await model.locator('..').locator('strong').boundingBox())!;
    const button = (await model.boundingBox())!;
    expect(label.width).toBeGreaterThan(60);
    expect(label.x + label.width + 8).toBeLessThanOrEqual(button.x);
    expect(button.x + button.width).toBeLessThanOrEqual(width);
  }
});

test('settings organization selects the default provider and model without changing the current task', async ({ page }) => {
  await open(page);
  const selected = await page.locator('.task-item.selected').getAttribute('data-id');
  const currentModel = await page.locator('#model-picker-trigger').textContent();
  await prompt(page).fill('Keep this draft while selecting defaults.');
  await settings(page);
  await tab(page, 'Agents').click();
  await page.getByRole('button', { name: 'Default agent for new tasks', exact: true }).click();
  await page.getByRole('dialog', { name: 'Default agent', exact: true }).getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click();
  const model = page.getByRole('button', { name: 'Default model for new tasks', exact: true });
  await model.click();
  await page.locator('.model-menu-option[data-provider="claude"][data-model="opus"]').click();
  await expect(model).toContainText('Opus');
  await back(page).click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', selected!);
  await expect(page.locator('#model-picker-trigger')).toHaveText(currentModel!);
  await expect(prompt(page)).toHaveValue('Keep this draft while selecting defaults.');
  await page.locator('.new-task-button').click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Opus');
  await expect(page.locator('#model-picker-trigger .provider-logo[data-provider="claude"]')).toBeVisible();
  await page.locator('#model-picker-trigger').click();
  await showHarness(page, 'codex');
  await page.locator('.model-menu-option[data-provider="codex"][data-model="default"]').click();
  await page.locator('.new-task-button').click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Opus');
  await expect(page.locator('#model-picker-trigger .provider-logo[data-provider="claude"]')).toBeVisible();
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await settings(page);
  await tab(page, 'Agents').click();
  await expect(model).toContainText('Opus');
  await page.getByRole('button', { name: 'Default agent for new tasks', exact: true }).click();
  await page.getByRole('dialog', { name: 'Default agent', exact: true }).getByRole('menuitemradio', { name: 'Kimi Code', exact: true }).click();
  await expect(model).not.toContainText('Opus');
});

test('settings organization disables a harness whose default model catalog failed and recovers', async ({ page }) => {
  await open(page);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      if (command === 'list_provider_models' && args.provider === 'claude' && !window.__allowDefaultModels) throw new Error('Catalog unavailable');
      switch (command) {
    `) });
  });
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await settings(page);
  await tab(page, 'Agents').click();
  const model = page.getByRole('button', { name: 'Default model for new tasks', exact: true });
  await model.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.locator('[data-tip="Catalog unavailable"]').first()).toBeAttached();
  await expect(picker.locator('.model-menu-option[data-provider="claude"]').first()).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__allowDefaultModels = true; });
  await model.click();
  await expect(picker.locator('.model-menu-option[data-provider="claude"][data-model="opus"]')).toBeEnabled();
  await expect(picker.locator('[data-tip]')).toHaveCount(0);
});

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      window.__settingsProviders ??= { calls: 0, hold: false, pending: false };
      window.__settingsSupport ??= { calls: 0, fail: false };
      if (command === 'support_details') {
        window.__settingsSupport.calls++;
        if (window.__settingsSupport.fail) throw new Error('Support details unavailable');
      }
      if (command === 'list_providers') {
        const request = window.__settingsProviders;
        request.calls++;
        if (request.hold) {
          request.pending = true;
          await new Promise(resolve => request.release = resolve);
          request.pending = false;
        }
      }
      switch (command) {
    `) });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}

test('support details are loaded on demand and copied only by the customer', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__supportCopies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__supportCopies.push(text); } }, configurable: true });
  });
  await open(page);
  await settings(page);
  await tab(page, 'About & updates').click();
  expect(await page.evaluate(() => (window as any).__settingsSupport.calls)).toBe(0);
  const details = page.locator('.support-details');
  await expect(details.getByRole('textbox')).toBeHidden();
  await details.locator('summary').click();
  const expected = 'PandaCode: Preview\nPlatform: Browser preview\nArchitecture: Not reported';
  await expect(details.getByRole('textbox')).toHaveValue(expected);
  expect(await page.evaluate(() => (window as any).__supportCopies)).toEqual([]);
  await details.getByRole('button', { name: 'Copy app details' }).click();
  await expect(details.getByRole('status')).toContainText('App details copied');
  expect(await page.evaluate(() => (window as any).__supportCopies)).toEqual([expected]);
  await details.locator('summary').click();
  await details.locator('summary').click();
  expect(await page.evaluate(() => (window as any).__settingsSupport.calls)).toBe(1);
});

test('support details recover from a fetch error and offer manual copying when clipboard access fails', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Clipboard denied'); } }, configurable: true }));
  await open(page);
  await settings(page);
  await tab(page, 'About & updates').click();
  await page.evaluate(() => { (window as any).__settingsSupport.fail = true; });
  const details = page.locator('.support-details');
  await details.locator('summary').click();
  await expect(details.getByRole('status')).toHaveText('Could not load app details.');
  await expect(details.getByRole('button', { name: 'Copy app details' })).toBeDisabled();
  await page.evaluate(() => { (window as any).__settingsSupport.fail = false; });
  await details.getByRole('button', { name: 'Try again' }).click();
  await details.getByRole('button', { name: 'Copy app details' }).click();
  await expect(details.getByRole('status')).toHaveText('Copy the selected app details using your keyboard.');
  await expect(details.getByRole('textbox')).toBeFocused();
  expect(await details.getByRole('textbox').evaluate((node: HTMLTextAreaElement) => node.selectionStart === 0 && node.selectionEnd === node.value.length)).toBe(true);
});

async function settings(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await expect(dialog(page).getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'General')).toBeFocused();
}

for (const pending of [false, true]) {
  test(`settings organization refreshes models for an unchanged executable with ${pending ? 'an older request still pending' : 'a cached catalog'}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pandacode.provider', 'antigravity');
      localStorage.setItem('pandacode.model.antigravity', 'model-a');
    });
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /switch\s*\(command\)\s*\{/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, `
        window.__refreshModels ??= { calls: 0, discoveries: [], firstFinished: false };
        const refreshModels = window.__refreshModels;
        if (command === 'list_providers') {
          refreshModels.discoveries.push(Boolean(args.force));
          return structuredClone(providers.map(provider => provider.id === 'antigravity'
            ? {...provider, installed:true, path:'/sample/bin/agy_acp_server.par', version:'ACP', models:[]}
            : provider));
        }
        if (command === 'list_provider_models' && args.provider === 'antigravity') {
          const first = ++refreshModels.calls === 1;
          const models = [{id:'model-a', name:first ? 'Old model name' : 'Fresh model name', description:''}];
          if (first && ${pending}) await new Promise(resolve => refreshModels.releaseFirst = resolve);
          if (first) refreshModels.firstFinished = true;
          return models;
        }
        switch (command) {
      `) });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(prompt(page)).toBeEnabled();
    await page.locator('.new-task-button').click();
    const calls = () => page.evaluate(() => (window as any).__refreshModels.calls);
    await expect.poll(calls).toBe(1);
    const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
    if (!pending) await expect(trigger).toContainText('Old model name');
    await settings(page);
    await tab(page, 'Agents').click();
    const refresh = page.getByRole('button', { name: 'Refresh agents', exact: true });
    await expect(refresh).toBeEnabled();
    const before = await page.evaluate(() => (window as any).__refreshModels.discoveries.length);
    await refresh.click();
    await expect.poll(() => page.evaluate(() => (window as any).__refreshModels.discoveries.length)).toBe(before + 1);
    await expect(refresh).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__refreshModels.discoveries.at(-1))).toBe(true);
    await back(page).click();
    await expect(dialog(page)).toBeHidden();
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    await expect.poll(calls).toBe(2);
    await expect(picker.getByRole('option', { name: 'Antigravity · Fresh model name', exact: true })).toBeVisible();
    if (pending) {
      await page.evaluate(() => (window as any).__refreshModels.releaseFirst());
      await expect.poll(() => page.evaluate(() => (window as any).__refreshModels.firstFinished)).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
    await expect(trigger).toContainText('Fresh model name');
    await page.keyboard.press('Escape');
    await trigger.click();
    await expect(picker.getByRole('option', { name: 'Antigravity · Fresh model name', exact: true })).toBeVisible();
    await expect(picker.getByRole('option', { name: 'Antigravity · Old model name', exact: true })).toHaveCount(0);
    expect(await calls()).toBe(2);
  });
}

test('settings organization opens General immediately and supports keyboard groups during agent discovery', async ({ page }) => {
  await open(page);
  const startupCalls = await providerCalls(page);
  await page.evaluate(() => { (window as any).__settingsProviders.hold = true; });
  await settings(page);
  await expect(page.getByRole('group', { name: 'Interface size', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Compact conversation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Default agent for new tasks', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Refresh agents', exact: true })).toBeHidden();
  expect(await providerCalls(page)).toBe(startupCalls);
  const retainedGeneral = await panel(page, 'General').elementHandle();
  await tab(page, 'General').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Appearance')).toBeFocused();
  expect(await providerCalls(page)).toBe(startupCalls);
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Agents')).toBeFocused();
  await expect(tab(page, 'Agents')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page, 'Agents')).toBeVisible();
  await expect.poll(() => providerCalls(page)).toBe(startupCalls + 1);
  await expect(page.getByRole('button', { name: 'Refresh agents', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'General')).toBeFocused();
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page, 'General')).toBeVisible();
  await page.evaluate(() => { const request = (window as any).__settingsProviders; request.hold = false; request.release(); });
  await expect.poll(() => page.evaluate(() => (window as any).__settingsProviders.pending)).toBe(false);
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true');
  expect(await retainedGeneral!.evaluate(node => node.isConnected)).toBe(true);
  await page.keyboard.press('End');
  await expect(tab(page, 'About & updates')).toBeFocused();
  await expect(tab(page, 'About & updates')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tab(page, 'General')).toBeFocused();
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true');
  expect(await providerCalls(page)).toBe(startupCalls + 1);
});

test('settings organization keeps agent diagnostics collapsed and retains the default agent across reopening', async ({ page }) => {
  await open(page);
  await settings(page);
  await tab(page, 'Agents').click();
  await expect(page.getByRole('button', { name: 'Refresh agents', exact: true })).toBeEnabled();
  for (const [id, name] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['kimi', 'Kimi Code']]) {
    const row = dialog(page).locator('.provider-diagnostic').filter({ has: page.locator(`.provider-logo[data-provider="${id}"]`) });
    await expect(row).toBeVisible();
    await expect(row.locator('summary')).toContainText(name);
    await expect(row.locator('code')).toBeHidden();
    await row.locator('summary').click();
    await expect(row.locator('code')).toContainText(`/sample/bin/${id}`);
    await expect(row.locator('code')).toBeVisible();
    await row.locator('summary').click();
    await expect(row.locator('code')).toBeHidden();
  }
  // Key-based plans are set up under Providers, not listed as agents.
  await expect(dialog(page).locator('.provider-diagnostic[data-provider="kilo"]')).toBeVisible();
  await expect(dialog(page).locator('.provider-diagnostic[data-provider="glm"], .provider-diagnostic[data-provider="mimo"]')).toHaveCount(0);
  const defaultAgent = page.getByRole('button', { name: 'Default agent for new tasks', exact: true });
  await defaultAgent.click();
  await page.getByRole('dialog', { name: 'Default agent', exact: true }).getByRole('menuitemradio', { name: 'Kimi Code', exact: true }).click();
  await expect(defaultAgent).toHaveText('Kimi Code');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pandacode.provider'))).toBe('kimi');
  await back(page).click();
  await expect(dialog(page)).toBeHidden();
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await settings(page);
  await tab(page, 'Agents').click();
  await expect(defaultAgent).toHaveText('Kimi Code');
});

test('settings organization does not let a late provider refresh replace wallpaper controls or the draft', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Keep my task draft through settings refresh.');
  const retainedPrompt = await prompt(page).elementHandle();
  await settings(page);
  await tab(page, 'Agents').click();
  const refresh = page.getByRole('button', { name: 'Refresh agents', exact: true });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => { (window as any).__settingsProviders.hold = true; });
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).__settingsProviders.pending)).toBe(true);
  await expect(refresh).toBeDisabled();
  await tab(page, 'Appearance').click();
  const blur = page.getByRole('slider', { name: 'Wallpaper blur', exact: true });
  await expect(blur).toBeVisible();
  await blur.focus();
  await page.keyboard.press('End');
  const retainedBlur = await blur.elementHandle();
  await page.evaluate(() => { const request = (window as any).__settingsProviders; request.hold = false; request.release(); });
  await expect.poll(() => page.evaluate(() => (window as any).__settingsProviders.pending)).toBe(false);
  await expect(dialog(page).getByRole('heading', { name: 'Wallpapers', exact: true })).toBeVisible();
  await expect(blur).toHaveValue('24');
  expect(await retainedBlur!.evaluate(node => node.isConnected)).toBe(true);
  await expect(tab(page, 'Appearance')).toHaveAttribute('aria-selected', 'true');
  await back(page).click();
  await expect(dialog(page)).toBeHidden();
  await expect(prompt(page)).toHaveValue('Keep my task draft through settings refresh.');
  expect(await retainedPrompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
});

test('settings organization lists groups in order, moves between them by keyboard, embeds Appearance and closes with Escape', async ({ page }) => {
  await open(page);
  await expect(page.locator('.sidebar')).toBeVisible();
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  const list = dialog(page).getByRole('tablist', { name: 'Settings', exact: true });
  await expect(list).toHaveAttribute('aria-orientation', 'vertical');
  await expect(list.getByRole('tab')).toHaveText(GROUPS);
  await expect(tab(page, 'General')).toBeFocused();
  await expect(panel(page, 'General').getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('tabpanel')).toHaveCount(1);
  // Arrow keys move through the groups in order and wrap around.
  for (const name of GROUPS.slice(1)) {
    await page.keyboard.press('ArrowDown');
    await expect(tab(page, name)).toBeFocused();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, name)).toBeVisible();
  }
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'General')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'About & updates')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Appearance')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'false');
  // Colors and wallpapers live inline in Appearance instead of separate dialogs.
  const appearance = panel(page, 'Appearance');
  await expect(appearance.getByRole('heading', { name: /^Colors/ })).toBeVisible();
  await expect(appearance.getByRole('radio', { name: 'Classic', exact: true })).toBeVisible();
  await expect(appearance.getByRole('heading', { name: 'Wallpapers', exact: true })).toBeVisible();
  await expect(appearance.getByRole('slider', { name: 'Wallpaper visibility', exact: true })).toBeVisible();
  await expect(appearance.getByRole('checkbox', { name: 'Daily wallpapers', exact: true })).toBeVisible();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(prompt(page)).toBeEnabled();
});

for (const layout of [{ width: 860, scale: 1.4 }, { width: 540, scale: 1.6 }]) {
  test(`settings organization fits a ${layout.width}px window at ${layout.scale * 100}% text size without crowded controls`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: layout.width, height: 740 });
    await page.addInitScript(scale => { localStorage.setItem('pandacode.uiScale', String(scale)); }, layout.scale);
    await open(page);
    await settings(page);
    const size = (await dialog(page).boundingBox())!;
    expect(size.x).toBeGreaterThanOrEqual(0);
    expect(size.x + size.width).toBeLessThanOrEqual(layout.width);
    expect(await dialog(page).locator('.settings-content').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const rows = panel(page, 'General').locator('.setting-row');
    const bounds = await rows.evaluateAll(nodes => nodes.map(node => {
      const row = node.getBoundingClientRect();
      const children = Array.from(node.children).map(child => {
        const rect = child.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return { left: row.left, right: row.right, top: row.top, bottom: row.bottom, children };
    }));
    expect(bounds.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < bounds.length; index++) {
      const row = bounds[index];
      // Sub-pixel layout units may report a hairline overlap between stacked rows.
      if (index) expect(row.top).toBeGreaterThanOrEqual(bounds[index - 1].bottom - 0.5);
      for (const child of row.children) {
        expect(child.left).toBeGreaterThanOrEqual(row.left - 1);
        expect(child.right).toBeLessThanOrEqual(row.right + 1);
      }
      for (let child = 1; child < row.children.length; child++) {
        const before = row.children[child - 1], current = row.children[child];
        const horizontalOverlap = Math.min(before.right, current.right) - Math.max(before.left, current.left);
        const verticalOverlap = Math.min(before.bottom, current.bottom) - Math.max(before.top, current.top);
        expect(horizontalOverlap <= 1 || verticalOverlap <= 1).toBe(true);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`settings-${layout.width}-${layout.scale}.png`), animations: 'disabled' });
    await tab(page, 'Appearance').click();
    await expect(page.getByRole('slider', { name: 'Wallpaper blur', exact: true })).toBeVisible();
    expect(await dialog(page).locator('.settings-content').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await back(page).click();
    await expect(dialog(page)).not.toBeVisible();
  });
}

test('Antigravity installation and connection readiness are distinct with explicit retry', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()).replace(/switch\s*\(command\)\s*\{/, `
      window.__readinessChecks ??= 0;
      if (command === 'provider_check_connection') {
        window.__readinessChecks++;
        return window.__readinessChecks === 1
          ? {installed:true,acpReady:true,sessionReady:false,state:'authenticationRequired',message:'Sign in to the ACP server, then check again.'}
          : {installed:true,acpReady:true,sessionReady:true,state:'ready',message:'ACP session is ready. No prompt was sent.'};
      }
      switch(command) {
    `)});
  });
  await page.goto('/');
  await page.getByRole('button', {name:'Settings',exact:true}).click();
  await tab(page, 'Agents').click();
  const row = page.locator('.provider-diagnostic[data-provider="antigravity"]');
  await row.locator('summary').click();
  const check = row.locator('.provider-readiness');
  await expect(check.getByRole('status')).toHaveText('Connection not checked');
  expect(await page.evaluate(() => (window as any).__readinessChecks)).toBe(0);
  await check.getByRole('button', {name:'Check connection',exact:true}).click();
  await expect(check.getByRole('status')).toHaveText('Sign-in required');
  await expect(check).toContainText('Sign in to the ACP server');
  await check.getByRole('button', {name:'Check again',exact:true}).click();
  await expect(check.getByRole('status')).toHaveText('Connection ready');
  await expect(check).toContainText('No prompt was sent');
});

test('resource usage lives in Settings → About, not in a bottom status bar', async ({ page }) => {
  await open(page);
  await expect(page.locator('.statusbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resource usage', exact: true })).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await tab(page, 'About & updates').click();
  const usage = panel(page, 'About & updates').locator('.settings-resources');
  await expect(usage).toContainText('Resource usage');
  await expect(usage.locator('[data-metric="activeAgents"]')).toHaveText('0');
  await expect(usage.locator('[data-metric="coreRssBytes"]')).toHaveText('—');
  await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(usage.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
});
