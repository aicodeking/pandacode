import { expect, test, type Page } from '@playwright/test';

const draft = (page: Page) => page.locator('#slash-fixture');
const menu = (page: Page) => page.locator('.slash-menu:not([aria-hidden="true"])');
const commands = [
  { id: 'review', name: '/review', description: 'Review changes in this project', argumentHint: '[instructions]', kind: 'prompt', source: 'Project' },
  { id: 'clear', name: '/clear', description: 'Start a fresh conversation', kind: 'action', source: 'PandaCode' },
  { id: 'login', name: '/login', description: 'Sign in', kind: 'unsupported', source: 'Claude Code', reason: 'Sign in from the terminal.' },
];

async function setup(page: Page, held = false, cached = false): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.evaluate(async ({ commands, held, cached }) => {
    const host = document.createElement('div');
    host.className = 'composer'; host.id = 'slash-fixture-host';
    host.style.cssText = 'position:fixed;bottom:45px;left:310px;width:650px;z-index:70;margin:0';
    host.innerHTML = '<textarea id="slash-fixture" aria-label="Command draft"></textarea>';
    document.body.append(host);
    const textarea = host.querySelector('textarea')!;
    const fixture = (window as any).__slash = { commands, held, context: 'first', calls: [], selected: [], submissions: 0, pending: [], warnings: [] };
    const moduleUrl = '/src/slash-commands.ts';
    const { mountSlashCommands } = await import(moduleUrl);
    fixture.controller = mountSlashCommands(textarea, {
      contextKey: () => fixture.context,
      provider: () => 'claude',
      snapshot: cached ? async () => ({ commands, warnings: [] }) : undefined,
      load: async (force: boolean) => {
        fixture.calls.push({ context: fixture.context, force });
        if (fixture.held) return await new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
        if (fixture.error) throw new Error(fixture.error);
        return { commands: fixture.commands, warnings: fixture.warnings };
      },
      select: (command: unknown) => fixture.selected.push(command),
    });
    document.addEventListener('keydown', event => {
      if (event.target === textarea && event.key === 'Enter' && !event.defaultPrevented) fixture.submissions++;
    });
    textarea.focus();
  }, { commands, held, cached });
}

async function snapshot(page: Page) {
  return await page.evaluate(() => {
    const fixture = (window as any).__slash;
    return { calls: fixture.calls, selected: fixture.selected, submissions: fixture.submissions };
  });
}

test('slash commands complete with keyboard without submitting and preserve typed DOM', async ({ page }) => {
  await setup(page);
  await draft(page).fill('/');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option')).toHaveCount(3);
  const originalDraft = await draft(page).elementHandle();
  const originalReview = await menu(page).locator('[data-command-id="review"]').elementHandle();
  await draft(page).fill('/rev');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  expect(await originalReview!.evaluate(node => node === document.querySelector('.slash-menu [data-command-id="review"]'))).toBe(true);
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('/review ');
  await expect(menu(page)).toHaveCount(0);
  await expect(draft(page)).toBeFocused();
  expect(await originalDraft!.evaluate(node => node === document.querySelector('#slash-fixture'))).toBe(true);
  expect((await snapshot(page)).submissions).toBe(0);
  await draft(page).fill('/');
  await draft(page).press('ArrowDown');
  await expect(menu(page).locator('[data-command-id="clear"]')).toHaveAttribute('aria-selected', 'true');
  await draft(page).press('Tab');
  await expect(draft(page)).toHaveValue('/clear ');
  expect((await snapshot(page)).calls).toHaveLength(1);
  expect((await snapshot(page)).selected.map((entry: any) => entry.id)).toEqual(['review', 'clear']);
});

test('slash commands respect command position, escape, composition and modified keys', async ({ page }) => {
  await setup(page);
  await draft(page).fill('Please /review');
  await expect(menu(page)).toHaveCount(0);
  expect((await snapshot(page)).calls).toHaveLength(0);
  await draft(page).fill('  /rev existing instructions');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).evaluate((node: HTMLTextAreaElement) => { node.setSelectionRange(6, 6); node.dispatchEvent(new Event('click')); });
  await expect(menu(page)).toBeVisible();
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('  /review existing instructions');
  await draft(page).fill('/');
  await draft(page).press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).press('ArrowLeft');
  await draft(page).press('ArrowRight');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).fill('/c');
  await expect(menu(page)).toBeVisible();
  await draft(page).dispatchEvent('keydown', { key: 'Enter', ctrlKey: true });
  expect((await snapshot(page)).selected).toHaveLength(1);
  await draft(page).dispatchEvent('compositionstart');
  await expect(menu(page)).toHaveCount(0);
  await draft(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect((await snapshot(page)).selected).toHaveLength(1);
  await draft(page).dispatchEvent('compositionend');
  await expect(menu(page)).toBeVisible();
});

test('slash commands expose unsupported and unknown commands without dispatching', async ({ page }) => {
  await setup(page);
  await draft(page).fill('/log');
  const unsupported = menu(page).getByRole('option');
  await expect(unsupported).toBeDisabled();
  await expect(unsupported).toContainText('Sign in from the terminal.');
  await draft(page).press('Enter');
  expect((await snapshot(page)).submissions).toBe(0);
  expect((await snapshot(page)).selected).toHaveLength(0);
  await draft(page).fill('/not-a-command');
  await expect(menu(page).getByRole('status')).toContainText('Unknown command /not-a-command');
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('/not-a-command');
  expect((await snapshot(page)).submissions).toBe(0);
  expect((await snapshot(page)).selected).toHaveLength(0);
});

test('slash commands ignore stale loads after agent switches and disposal', async ({ page }) => {
  await setup(page, true);
  await draft(page).fill('/');
  await expect(menu(page).getByRole('status')).toContainText('Loading');
  await draft(page).press('Enter');
  expect((await snapshot(page)).submissions).toBe(0);
  await page.evaluate(() => { const fixture = (window as any).__slash; fixture.context = 'second'; fixture.controller.refresh(); });
  expect((await snapshot(page)).calls.map((entry: any) => entry.context)).toEqual(['first', 'second']);
  await page.evaluate(() => { const fixture = (window as any).__slash; fixture.pending[1].resolve({ commands: [fixture.commands[1]], warnings: [] }); });
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(menu(page).getByRole('option')).toContainText('/clear');
  await page.evaluate(() => { const fixture = (window as any).__slash; fixture.pending[0].resolve({ commands: [fixture.commands[0]], warnings: [] }); });
  await expect(menu(page).getByRole('option')).toContainText('/clear');
  await page.evaluate(() => { const fixture = (window as any).__slash; fixture.context = 'third'; fixture.controller.refresh(); fixture.controller.dispose(); fixture.pending[2].resolve({ commands: fixture.commands, warnings: [] }); });
  await expect(menu(page)).toHaveCount(0);
  await expect(draft(page)).not.toHaveAttribute('role', 'combobox');
  await draft(page).fill('/review');
  await expect(menu(page)).toHaveCount(0);
  expect((await snapshot(page)).calls).toHaveLength(3);
});

test('slash commands keep cached entries usable while harness discovery is still starting', async ({ page }) => {
  await setup(page, true, true);
  await draft(page).fill('/c');
  await expect(menu(page).getByRole('option')).toContainText('/clear');
  await expect(menu(page).getByRole('status')).toContainText('Loading');
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('/clear ');
  expect((await snapshot(page)).selected.map((entry: any) => entry.id)).toEqual(['clear']);
  expect((await snapshot(page)).submissions).toBe(0);
});

test('slash commands explain slow discovery, time out, and retry without losing cached commands', async ({ page }) => {
  await setup(page, true, true);
  await page.clock.install();
  await draft(page).fill('/');
  await expect(menu(page).getByRole('option')).toHaveCount(3);
  await page.clock.fastForward(5_000);
  await expect(menu(page).getByRole('status')).toContainText('Waiting for the harness to start');
  await page.clock.fastForward(75_000);
  await expect(menu(page).getByRole('status')).toContainText('took too long');
  await menu(page).getByRole('button', { name: 'Retry commands' }).click();
  expect((await snapshot(page)).calls.map((entry: any) => entry.force)).toEqual([false, true]);
  await page.evaluate(() => {
    const fixture = (window as any).__slash;
    fixture.pending[1].resolve({ commands: [fixture.commands[1]], warnings: [] });
    fixture.pending[0].resolve({ commands: [fixture.commands[0]], warnings: [] });
  });
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  await expect(menu(page).getByRole('option')).toContainText('/clear');
});

test('slash commands refresh on request and retain option order while filtering', async ({ page }) => {
  await setup(page);
  await draft(page).fill('/c');
  await expect(menu(page).getByRole('option')).toHaveCount(1);
  const clear = await menu(page).getByRole('option').elementHandle();
  await draft(page).fill('/');
  await expect(menu(page).getByRole('option')).toHaveCount(3);
  expect(await menu(page).getByRole('option').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.commandId))).toEqual(['review', 'clear', 'login']);
  expect(await clear!.evaluate(node => node === document.querySelector('.slash-menu [data-command-id="clear"]'))).toBe(true);
  await page.evaluate(() => { (window as any).__slash.warnings = ['One project command could not be read.']; });
  await menu(page).getByRole('button', { name: 'Refresh commands' }).click();
  await expect(menu(page).locator('.slash-menu-warning')).toHaveText('One project command could not be read.');
  await expect(draft(page)).toBeFocused();
  expect((await snapshot(page)).calls.map((entry: any) => entry.force)).toEqual([false, true]);
  await page.evaluate(() => { (window as any).__slash.error = 'Command discovery unavailable'; });
  await menu(page).getByRole('button', { name: 'Refresh commands' }).click();
  await expect(menu(page).getByRole('status')).toHaveText('Command discovery unavailable');
  await expect(menu(page).getByRole('option')).toHaveCount(3);
});

test('slash commands remain within resized viewport and keep focus at large text sizes', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 740, height: 540 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--ui-scale', '1.6');
    document.querySelector<HTMLElement>('#slash-fixture-host')!.style.cssText = 'position:fixed;bottom:35px;right:12px;width:310px;z-index:70;margin:0';
    const fixture = (window as any).__slash;
    fixture.commands = Array.from({ length: 35 }, (_, index) => ({ ...fixture.commands[0], id: String(index), name: `/project-command-${index}`, description: 'A longer description to verify readable wrapping at large text sizes' }));
  });
  await draft(page).fill('/');
  await expect(menu(page).getByRole('option')).toHaveCount(35);
  await expect(menu(page)).toBeVisible();
  const before = await menu(page).boundingBox();
  expect(before!.x).toBeGreaterThanOrEqual(12);
  expect(before!.x + before!.width).toBeLessThanOrEqual(729);
  expect(before!.y).toBeGreaterThanOrEqual(12);
  expect(before!.y + before!.height).toBeLessThanOrEqual(529);
  await page.setViewportSize({ width: 420, height: 500 });
  await expect.poll(async () => { const box = await menu(page).boundingBox(); return box!.x + box!.width; }).toBeLessThanOrEqual(409);
  await expect(draft(page)).toBeFocused();
  await draft(page).press('ArrowUp');
  await expect(menu(page).locator('[aria-selected="true"]')).toContainText('/project-command-34');
  const overflow = await menu(page).evaluate(node => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight);
  expect(overflow).toBe(false);
});

async function installAppProbe(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__appSlashCalls ??= [];
      window.__appSlashExtra ??= [];
      window.__appSlashEmit ??= event => agent(event);
      window.__appSlashCalls.push({command,args:structuredClone(args),provider:args.sessionId ? session(args.sessionId).provider : undefined});
      if (command === 'list_slash_commands') {
        const catalog = slashCatalog(session(args.sessionId).provider);
        if (window.__appSlashHoldDiscovery && !args.cachedOnly) await new Promise(resolve => {window.__appSlashFinishDiscovery=resolve;});
        return {...catalog,commands:[...catalog.commands,...window.__appSlashExtra].map(item => ({...item,argumentHint:item.argumentHint ?? null,reason:item.reason ?? null}))};
      }
      if (command === 'resolve_slash_command' && window.__appSlashHold) await new Promise(resolve => {window.__appSlashRelease=resolve;});
      if (command === 'resolve_slash_command' && window.__appSlashNoAttachments) return {...resolveSlash(session(args.sessionId).provider,String(args.text)),acceptsAttachments:false};
      if (command === 'send_message') return;
      switch(command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(page.locator('#prompt')).toBeEnabled();
}
const appCalls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__appSlashCalls ?? []).filter((entry: any) => entry.command === command), command);

test.describe('slash commands app integration', () => {
  test.beforeEach(async ({ page }) => { await installAppProbe(page); });

  test('inserts a local command first, then opens its control without a turn or conversation reset', async ({ page }) => {
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach README.md', exact: true }).click();
    await expect(page.locator('#attachments')).toContainText('README.md');
    const prompt = page.locator('#prompt');
    const node = await prompt.elementHandle();
    const messages = await page.locator('.message').count();
    await prompt.fill('/mod');
    await expect(menu(page).getByRole('option')).toContainText('/model');
    await prompt.press('Enter');
    await expect(prompt).toHaveValue('/model ');
    expect(await appCalls(page, 'resolve_slash_command')).toHaveLength(0);
    await expect(page.locator('.model-menu')).toHaveCount(0);
    await prompt.press('Enter');
    await expect(page.locator('.model-menu:not([aria-hidden="true"])')).toBeVisible();
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
    expect(await appCalls(page, 'create_session')).toHaveLength(0);
    expect(await appCalls(page, 'update_session')).toHaveLength(0);
    expect(await page.locator('.message').count()).toBe(messages);
    expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
    await expect(page.locator('#attachments')).toContainText('README.md');
    await expect(prompt).toHaveValue('');
  });

  test('shows local controls before the harness command discovery completes', async ({ page }) => {
    await page.evaluate(() => { (window as any).__appSlashHoldDiscovery = true; });
    const prompt = page.locator('#prompt');
    await prompt.fill('/mod');
    await expect(menu(page).getByRole('option')).toContainText('/model');
    await expect(menu(page).getByRole('status')).toContainText('Loading');
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('/model ');
    await prompt.press('Enter');
    await expect(page.locator('.model-menu:not([aria-hidden="true"])')).toBeVisible();
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
    expect((await appCalls(page, 'list_slash_commands')).map(entry => Boolean(entry.args.cachedOnly))).toEqual([true, false]);
  });

  test('keeps unknown and invalid argument drafts after sending with the picker dismissed', async ({ page }) => {
    const prompt = page.locator('#prompt');
    await prompt.fill('/not-a-real-command');
    await expect(menu(page).getByRole('status')).toContainText('Unknown command');
    await prompt.press('Escape');
    await prompt.press('Enter');
    await expect(page.locator('#toast')).toContainText('Unknown command /not-a-real-command');
    await expect(prompt).toHaveValue('/not-a-real-command');
    await prompt.fill('/model extra arguments');
    await prompt.press('Enter');
    await expect(page.locator('#toast')).toContainText('does not accept arguments');
    await expect(prompt).toHaveValue('/model extra arguments');
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
    await expect(page.locator('.model-menu')).toHaveCount(0);
  });

  test('loads catalogs for the current task and newly selected harness', async ({ page }) => {
    const prompt = page.locator('#prompt');
    await prompt.fill('/');
    await expect(menu(page).locator('.slash-menu-source').filter({ hasText: /^claude$/ }).first()).toBeVisible();
    await page.locator('.task-item[data-id="session-3"]').click();
    await expect(prompt).toBeEnabled();
    await prompt.fill('/skill:');
    await expect(menu(page).getByRole('option')).toContainText('/skill:project-guide');
    await page.locator('.new-task-button').click();
    await expect(prompt).toBeEnabled();
    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    await page.locator('.model-menu').getByRole('tab', { name: 'Codex', exact: true }).click();
    await page.locator('.model-menu').getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toContainText('GPT-6-Astra');
    await prompt.fill('/review');
    await expect(menu(page).getByRole('option')).toContainText('codex');
    const catalogs = (await appCalls(page, 'list_slash_commands')).filter(entry => !entry.args.cachedOnly);
    expect(catalogs.map(entry => entry.provider)).toEqual(['claude', 'kimi', 'codex']);
    expect(catalogs[0].args.sessionId).toBe('session-1');
    expect(catalogs[1].args.sessionId).toBe('session-3');
    expect(catalogs[2].args.sessionId).not.toBe('session-3');
  });

  test('updates advertised commands immediately without remounting the composer or forcing discovery', async ({ page }) => {
    const prompt = page.locator('#prompt');
    await prompt.fill('/');
    await expect(menu(page).getByRole('option').first()).toBeVisible();
    const node = await prompt.elementHandle();
    await page.evaluate(() => {
      (window as any).__appSlashExtra = [{ id: 'runtime', name: '/runtime-info', description: 'Advertised by the running harness', source: 'Harness', kind: 'prompt', argumentHint: null, reason: null }];
      (window as any).__appSlashEmit({ sessionId: 'session-1', kind: 'commands_changed', text: '' });
    });
    await expect(menu(page).getByRole('option').filter({ hasText: '/runtime-info' })).toBeVisible();
    expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue('/');
    expect((await appCalls(page, 'list_slash_commands')).filter(entry => !entry.args.cachedOnly).map(entry => entry.args.force)).toEqual([false, false]);
  });

  test('opens local controls from a board task without starting the agent', async ({ page }) => {
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await page.getByRole('button', { name: 'Open task: Make search feel instant', exact: true }).click();
    const details = page.getByRole('region', { name: 'Task details', exact: true });
    const prompt = details.locator('#prompt');
    await expect(prompt).toBeEnabled();
    await prompt.fill('/mod');
    await expect(menu(page)).toBeVisible();
    await prompt.press('Tab');
    await expect(prompt).toHaveValue('/model ');
    await prompt.press('Enter');
    await expect(page.locator('.model-menu:not([aria-hidden="true"])')).toBeVisible();
    await expect(details).toBeVisible();
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
    expect(await appCalls(page, 'start_task')).toHaveLength(0);
  });

  test('passes rename arguments to the local action and keeps file attachments', async ({ page }) => {
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach README.md', exact: true }).click();
    await page.locator('#prompt').fill('/rename Search improvements');
    await page.locator('#prompt').press('Enter');
    await expect(page.locator('.task-item.selected .task-title')).toHaveText('Search improvements');
    await expect(page.locator('#attachments')).toContainText('README.md');
    await expect(page.locator('#prompt')).toHaveValue('');
    const updates = await appCalls(page, 'update_session');
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toMatchObject({ sessionId: 'session-1', title: 'Search improvements' });
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
  });

  for (const command of ['/model ', '/review focus on tests']) {
    test(`does not run ${command.trim()} after switching tasks during command validation`, async ({ page }) => {
      const prompt = page.locator('#prompt');
      await page.evaluate(() => { (window as any).__appSlashHold = true; });
      await prompt.fill(command);
      await prompt.press('Enter');
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__appSlashRelease))).toBe(true);
      await page.locator('.task-item[data-id="session-2"]').click();
      await expect(prompt).toBeEnabled();
      await prompt.fill('Keep this second task draft');
      await page.evaluate(() => (window as any).__appSlashRelease());
      await expect(page.locator('#toast')).toContainText('task or message changed');
      await expect(prompt).toHaveValue('Keep this second task draft');
      expect(await appCalls(page, 'send_message')).toHaveLength(0);
      await expect(page.locator('.model-menu')).toHaveCount(0);
      await page.locator('.task-item[data-id="session-1"]').click();
      await expect(prompt).toHaveValue(command);
    });
  }

  test('keeps a newer draft when command validation finishes late', async ({ page }) => {
    const prompt = page.locator('#prompt');
    await page.evaluate(() => { (window as any).__appSlashHold = true; });
    await prompt.fill('/review focus on tests');
    await prompt.press('Enter');
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__appSlashRelease))).toBe(true);
    await prompt.fill('Actually, review the documentation first');
    await page.evaluate(() => (window as any).__appSlashRelease());
    await expect(page.locator('#toast')).toContainText('task or message changed');
    await expect(prompt).toHaveValue('Actually, review the documentation first');
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
  });

  test('keeps attachments and draft when a maintenance command cannot accept context', async ({ page }) => {
    await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach README.md', exact: true }).click();
    await page.evaluate(() => { (window as any).__appSlashNoAttachments = true; });
    await page.locator('#prompt').fill('/compact ');
    await page.locator('#prompt').press('Enter');
    await expect(page.locator('#toast')).toContainText('does not accept attachments');
    await expect(page.locator('#prompt')).toHaveValue('/compact ');
    await expect(page.locator('#attachments')).toContainText('README.md');
    expect(await appCalls(page, 'send_message')).toHaveLength(0);
    expect(await appCalls(page, 'read_file')).toHaveLength(0);
  });
});
