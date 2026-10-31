import { expect, test, type Page } from '@playwright/test';

const popup = (page: Page) => page.getByRole('region', { name: 'Agent updates', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Agent updates', exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__agentUpdates.calls.filter((entry: any) => entry.command === command), command);
async function open(page: Page): Promise<void> {
  await page.clock.install();
  await page.addInitScript(() => {
    const update = (provider: string, name: string, providers = [provider]) => ({ provider, name, providers, installedVersion: '1.0.0', latestVersion: '1.1.0', status: 'available', method: 'Native updater', canUpdate: true, message: null, checkedAt: Date.now(), docsUrl: null });
    (window as any).__agentUpdates = { calls: [], hold: false, failure: '', checkFailure: false, results: [
      update('claude', 'Claude Code', ['claude', 'glm', 'mimo']), update('codex', 'Codex'),
      { ...update('kimi', 'Kimi Code'), status: 'current', latestVersion: '1.0.0' },
      { ...update('opencode', 'OpenCode'), status: 'unsupported', canUpdate: false, latestVersion: null, method: null, message: 'Update this custom installation using its package manager.', docsUrl: 'https://opencode.ai/docs/cli/' },
      { ...update('kilo', 'Kilo Code'), status: 'unsupported', canUpdate: false, latestVersion: null, method: null, message: 'PandaCode cannot update this agent. Use its own updater or package manager.' },
    ] };
  });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      const fixture = window.__agentUpdates;
      if (['check_agent_updates', 'update_agent', 'list_providers'].includes(command)) fixture.calls.push({command, args: structuredClone(args)});
      if (command === 'check_agent_updates') {
        if (fixture.checkFailure) throw new Error('Update service unavailable.');
        return structuredClone(fixture.results);
      }
      if (command === 'update_agent') {
        emit('agent-update-progress', {provider: args.provider, phase:'updating'});
        if (fixture.hold) await new Promise(resolve => fixture.release = resolve);
        if (fixture.failure) throw new Error(fixture.failure);
        const result = fixture.results.find(item => item.provider === args.provider);
        result.status = 'current'; result.installedVersion = result.latestVersion;
        emit('agent-update-progress', {provider: args.provider, phase:'completed'});
        return structuredClone(result);
      }
      switch (command) {`) });
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}
async function automatic(page: Page): Promise<void> {
  await page.clock.fastForward(9000);
  await expect(popup(page)).toBeVisible();
}
async function manual(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Check updates', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

test.describe('Agent updates', () => {
  test('checks after startup without stealing prompt focus and groups shared Claude installations', async ({ page }) => {
    await open(page);
    const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
    await prompt.fill('Keep writing while the check runs');
    expect(await calls(page, 'check_agent_updates')).toEqual([]);
    await automatic(page);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue('Keep writing while the check runs');
    await expect(popup(page).locator('.agent-update-row')).toHaveCount(2);
    await expect(popup(page)).toContainText('1.0.0');
    await expect(popup(page)).toContainText('1.1.0');
    await expect(popup(page).getByRole('button', { name: 'Update Claude Code', exact: true })).toHaveCount(1);
    await expect(popup(page).getByRole('button', { name: 'Update Codex', exact: true })).toBeEnabled();
    expect(await calls(page, 'update_agent')).toEqual([]);
    await page.clock.fastForward(60_000);
    expect(await calls(page, 'check_agent_updates')).toHaveLength(1);
  });

  test('Later remembers these versions across app reopen while manual checks remain available', async ({ page }) => {
    await open(page); await automatic(page);
    await popup(page).getByRole('button', { name: 'Later', exact: true }).click();
    await expect(popup(page)).toBeHidden();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
    await page.clock.fastForward(9000);
    await expect(popup(page)).toBeHidden();
    await manual(page);
    await expect(dialog(page).getByRole('button', { name: 'Update Codex', exact: true })).toBeEnabled();
    expect(await calls(page, 'update_agent')).toEqual([]);
  });

  test('updates only after a click and shows progress while blocking duplicate installs', async ({ page }) => {
    await open(page); await automatic(page);
    await page.evaluate(() => { (window as any).__agentUpdates.hold = true; });
    const button = popup(page).getByRole('button', { name: 'Update Codex', exact: true });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(popup(page)).toContainText(/Updating/);
    await expect.poll(() => calls(page, 'update_agent')).toHaveLength(1);
    expect((await calls(page, 'update_agent'))[0].args).toEqual({provider:'codex'});
    await page.evaluate(() => (window as any).__agentUpdates.release());
    await expect(popup(page).locator('.agent-update-row[data-provider="codex"]')).toContainText(/Up to date|Updated/);
    await expect(popup(page).getByRole('button', { name: 'Update Claude Code', exact: true })).toBeEnabled();
    await expect.poll(async () => (await calls(page, 'list_providers')).length).toBeGreaterThan(1);
  });

  test('keeps a failed update actionable and displays the native busy reason', async ({ page }) => {
    await open(page); await automatic(page);
    await page.evaluate(() => { (window as any).__agentUpdates.failure = 'Finish running agents and close terminals before installing an update.'; });
    await popup(page).getByRole('button', { name: 'Update Codex', exact: true }).click();
    await expect(popup(page)).toContainText('Finish running agents and close terminals');
    await expect(popup(page).getByRole('button', { name: 'Update Codex', exact: true })).toBeEnabled();
    await page.evaluate(() => { (window as any).__agentUpdates.failure = ''; });
    await popup(page).getByRole('button', { name: 'Update Codex', exact: true }).click();
    await expect(popup(page).locator('.agent-update-row[data-provider="codex"]')).toContainText(/Up to date|Updated/);
  });

  test('does not interrupt an existing dialog and shows the popup after it closes', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Meta+,');
    await page.getByRole('region', {name:'Settings', exact:true}).getByRole('tab', {name:'Tools & add-ons', exact:true}).click();
    await page.getByRole('button', {name:'Manage', exact:true}).click();
    const tools = page.getByRole('dialog', {name:'Tools & integrations', exact:true});
    await expect(tools).toBeVisible();
    await page.clock.fastForward(9000);
    await expect(popup(page)).toBeHidden();
    await expect(tools).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeVisible();
  });

  test('manual checks distinguish current versions and installations requiring a manual update', async ({ page }) => {
    await open(page); await manual(page);
    await expect(dialog(page).locator('.agent-update-row[data-provider="kimi"]')).toContainText(/Up to date/);
    const custom = dialog(page).locator('.agent-update-row[data-provider="opencode"]');
    await expect(custom).toContainText('Update this custom installation');
    await expect(custom.getByRole('button', { name: 'Update OpenCode', exact: true })).toHaveCount(0);
    // Harnesses without an update route (Kilo, omp, Pi…) still get a manual row.
    const kilo = dialog(page).locator('.agent-update-row[data-provider="kilo"]');
    await expect(kilo).toContainText('Manual update');
    await expect(kilo).toContainText('Use its own updater');
    expect((await calls(page, 'check_agent_updates')).at(-1).args.force).toBe(true);
  });

  test('notifies about a known newer release even when its installation needs a manual update', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const custom = (window as any).__agentUpdates.results.find((item: any) => item.provider === 'opencode');
      custom.status = 'available'; custom.latestVersion = '1.1.0';
    });
    await automatic(page);
    const custom = popup(page).locator('.agent-update-row[data-provider="opencode"]');
    await expect(custom).toContainText('Manual update');
    await expect(custom).toContainText('1.1.0');
    await expect(custom.getByRole('button', {name:'OpenCode update guide',exact:true})).toBeVisible();
    await expect(custom.getByRole('button', {name:'Update OpenCode',exact:true})).toHaveCount(0);
    expect(await calls(page, 'update_agent')).toEqual([]);
  });

  test('check failures stay quiet in the background and recover manually', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__agentUpdates.checkFailure = true; });
    await page.clock.fastForward(9000);
    await expect(popup(page)).toBeHidden();
    await manual(page);
    await expect(dialog(page)).toContainText(/unavailable|Could not|Couldn’t/i);
    await page.evaluate(() => { (window as any).__agentUpdates.checkFailure = false; });
    await dialog(page).locator('.agent-updates-check').click();
    await expect(dialog(page).getByRole('button', { name:'Update Codex', exact:true })).toBeEnabled();
  });

  test('glass popup and dialog fit a narrow window at 140 percent text size', async ({ page }, testInfo) => {
    await page.setViewportSize({width:460,height:740});
    await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.4'));
    await open(page); await automatic(page);
    const check = async (surface: ReturnType<typeof popup>) => {
      const bounds = (await surface.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(461); expect(bounds.y + bounds.height).toBeLessThanOrEqual(741);
      expect(await surface.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    };
    await check(popup(page));
    await page.screenshot({path:`/private/tmp/pandacode-agent-updates-${testInfo.project.name || testInfo.project.use.browserName || 'chrome'}.png`, animations:'disabled'});
    await popup(page).getByRole('button', {name:'Later',exact:true}).click();
    await manual(page); await check(dialog(page));
  });
});
