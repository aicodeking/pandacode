import { expect, test, type Page } from '@playwright/test';

test('provider connections expose Kilo models, approval modes and executable settings', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.new-task-button').click();
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.locator('.model-menu-option[data-provider="kilo"][data-model="default"]')).toBeVisible();
  const model = picker.locator('.model-menu-option[data-provider="kilo"][data-model="kilo/anthropic/claude-sonnet-4.6"]');
  await expect(model).toContainText('Kilo Gateway/Anthropic: Claude Sonnet 4.6');
  await model.click();
  await expect(trigger).toContainText('Kilo');
  await page.locator('#mode-picker-trigger').click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(permissions.getByRole('menuitemradio')).toHaveCount(4);
  await permissions.getByRole('menuitemradio', { name: /Plan mode/ }).click();
  await expect(page.locator('#mode-picker-trigger')).toContainText('Plan mode');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Kilo Code', exact: false }) });
  await expect(card).toContainText('kilo auth login');
  await expect(card.getByRole('link', { name: 'Kilo CLI docs' })).toHaveAttribute('href', 'https://kilo.ai/docs/code-with-ai/platforms/cli');
  await card.locator('summary').click();
  await expect(card.getByLabel('Kilo executable', { exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('kilo-provider-settings.png') });
});

test('provider connections show Claude credential conflicts and let users prefer the saved login', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__claudeMode ??= 'inherit';
      if (command === 'provider_claude_status') return {
        mode:window.__claudeMode, source:window.__claudeMode === 'inherit' ? 'Environment API key' : 'Saved Claude login',
        environmentVariables:['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL'], endpoint:window.__claudeMode === 'inherit' ? 'https://gateway.example' : null,
        savedLogin:'signedIn', conflict:window.__claudeMode === 'inherit'
      };
      if (command === 'provider_set_claude_connection_mode') { window.__claudeMode=args.mode; return {...await invoke('provider_configuration'),claudeConnectionMode:args.mode}; }
      switch(command) {`) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('#claude-connection');
  await expect(card.getByRole('status')).toContainText('Environment API key');
  await expect(card).toContainText('https://gateway.example');
  await expect(card).toContainText('can override your saved Claude login');
  const mode = card.getByLabel('Claude connection', { exact: true });
  await expect(mode).toHaveValue('inherit');
  await mode.selectOption('subscription');
  await expect(card.getByRole('status')).toContainText('Saved Claude login');
  await expect(card.locator('.claude-auth-conflict')).toBeHidden();
  await expect(card.locator('.claude-auth-endpoint')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__claudeMode)).toBe('subscription');
  await mode.selectOption('inherit');
  await expect(card.getByRole('status')).toContainText('Environment API key');
});

async function delayedConnections(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      if (command === 'provider_configuration') return new Promise(resolve => {
        window.releaseProviderConfiguration = () => resolve({ executablePaths: { opencode: '/installed/opencode', antigravity: '/installed/agy_acp_server.par' }, glmKeySaved: false, glmKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: 'token-plan-ams', mimoEndpoints: [{ id: 'token-plan-ams', url: 'https://token-plan-ams.xiaomimimo.com/anthropic', label: 'Token Plan · Europe cluster' }], secureStorageAvailable: false });
      });
      if (command === 'provider_set_executable') return new Promise(resolve => {
        window.releaseProviderSave = () => { delete window.releaseProviderSave; resolve({ executablePaths: { opencode: args.path.replaceAll('//', '/'), antigravity: '/installed/agy_acp_server.par' }, glmKeySaved: false, glmKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: 'token-plan-ams', mimoEndpoints: [{ id: 'token-plan-ams', url: 'https://token-plan-ams.xiaomimimo.com/anthropic', label: 'Token Plan · Europe cluster' }], secureStorageAvailable: false }); };
      });
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.getByLabel('OpenCode executable', { exact: true })).toHaveCount(1);
  for (const summary of await page.locator('#settings-panel-providers details summary').all()) await summary.click();
}

test('provider connections preserve other drafts and edits made during a save', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await delayedConnections(page);
  const opencode = page.getByLabel('OpenCode executable', { exact: true });
  const antigravity = page.getByLabel('Antigravity ACP executable', { exact: true });
  await antigravity.fill('/draft/agy_acp_server.par');
  await page.evaluate(() => (window as any).releaseProviderConfiguration());
  await expect(opencode).toHaveValue('/installed/opencode');
  await expect(antigravity).toHaveValue('/draft/agy_acp_server.par');
  await opencode.fill('/opt//bin/opencode');
  const apply = page.locator('form[data-provider="opencode"]').getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
  await opencode.fill('/next//opencode');
  await page.waitForFunction(() => typeof (window as any).releaseProviderSave === 'function');
  await page.evaluate(() => (window as any).releaseProviderSave());
  await expect(apply).toBeEnabled();
  await expect(opencode).toHaveValue('/next//opencode');
  await expect(antigravity).toHaveValue('/draft/agy_acp_server.par');
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.waitForFunction(() => typeof (window as any).releaseProviderSave === 'function');
  await page.evaluate(() => (window as any).releaseProviderSave());
  await expect(opencode).toHaveValue('/next/opencode');
  await expect(antigravity).toHaveValue('/draft/agy_acp_server.par');
  expect(errors).toEqual([]);
});

test('provider connections ignore a late initial configuration after a successful save', async ({ page }) => {
  await delayedConnections(page);
  const opencode = page.getByLabel('OpenCode executable', { exact: true });
  await opencode.fill('/new/opencode');
  const apply = page.locator('form[data-provider="opencode"]').getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await expect(apply).toBeDisabled();
  await page.waitForFunction(() => typeof (window as any).releaseProviderSave === 'function');
  await page.evaluate(() => (window as any).releaseProviderSave());
  await expect(apply).toBeEnabled();
  await page.evaluate(() => (window as any).releaseProviderConfiguration());
  await expect(opencode).toHaveValue('/new/opencode');
});

test('provider connections are grouped in Providers and never accept secrets in browser preview', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const dialog = settings.getByRole('tabpanel', { name: 'Providers', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Z.ai API key', { exact: true })).toBeDisabled();
  await expect(dialog.locator('#glm-key-form').getByRole('button', { name: 'Save key', exact: true })).toBeDisabled();
  await expect(dialog.getByText('opencode auth login', { exact: true })).toBeVisible();
  await expect(dialog.getByText('agy', { exact: true })).toBeVisible();
  await expect(dialog.getByText('grok login', { exact: true })).toBeVisible();
  const paths = dialog.locator('details').filter({ has: page.getByLabel('Grok executable', { exact: true }) });
  await paths.last().locator('summary').click();
  await dialog.getByLabel('Grok executable', { exact: true }).fill('/tmp/my-grok');
  await paths.last().getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByRole('status').last()).toContainText('desktop app');
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the MiMo Token Plan card offers the documented clusters and keeps the key native-only', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card', { hasText: 'MiMo Token Plan' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: /Token Plan/ })).toHaveAttribute('href', 'https://platform.xiaomimimo.com/token-plan');
  const endpoint = card.getByLabel('Endpoint', { exact: true });
  await expect(endpoint.locator('option')).toHaveText(['Choose your cluster…', 'Token Plan · China cluster', 'Token Plan · Singapore cluster', 'Token Plan · Europe cluster', 'Pay-as-you-go API']);
  await expect(endpoint).toHaveValue('');
  await expect(card.locator('#mimo-endpoint-hint')).toContainText('Required before MiMo tasks can start');
  // The key lives in the platform store only; the preview never accepts one.
  await expect(card.getByLabel('MiMo API key', { exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Save key', exact: true })).toBeDisabled();
  await expect(card.locator('#mimo-key-status')).toContainText('MIMO_API_KEY');
  await endpoint.selectOption('token-plan-sgp');
  await expect(page.locator('#settings-page .connection-feedback')).toContainText('desktop app');
  expect(errors).toEqual([]);
});

test('a delayed configuration fills the saved MiMo cluster and its URL', async ({ page }) => {
  await delayedConnections(page);
  await page.evaluate(() => (window as any).releaseProviderConfiguration());
  const card = page.locator('.connection-card', { hasText: 'MiMo Token Plan' });
  await expect(card.getByLabel('Endpoint', { exact: true })).toHaveValue('token-plan-ams');
  await expect(card.locator('#mimo-endpoint-hint')).toHaveText('https://token-plan-ams.xiaomimimo.com/anthropic');
});

test('provider connections expose all harnesses and real GLM model names', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  await expect(page.getByText('OpenCode', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('GLM Coding Plan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Antigravity', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Grok Build', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('MiMo Token Plan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('GitHub Copilot CLI', { exact: true }).first()).toBeVisible();
  await page.getByText('GLM Coding Plan', { exact: true }).first().click();
  await expect(page.getByText('GLM-5.3', { exact: true }).first()).toBeVisible();
});

for (const providerId of ['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse']) {
  test(`provider connections start ${providerId} tasks with Full access and retain explicit restrictions when switching`, async ({ page }) => {
    await page.addInitScript(provider => localStorage.setItem('pandacode.provider', provider), providerId);
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({response, body: source.replace(/switch\s*\(command\)\s*\{/, `
        window.__approvalPreview = invoke;
        if (command === 'list_providers') return structuredClone(providers.map(provider => ({...provider, installed:true})));
        switch (command) {`)});
    });
    await page.goto('/');
    const permissions = page.locator('#mode-picker-trigger');
    // An already saved task retains its approval setting.
    await expect(permissions).toHaveText('Standard');
    await page.locator('.new-task-button').click();
    await expect(permissions).toHaveText('Full access');
    const readTask = () => page.evaluate(async () => {
      const sessionId = (document.querySelector('#prompt') as HTMLElement).dataset.sessionId;
      return (window as any).__approvalPreview('get_task', {sessionId});
    });
    await expect.poll(readTask).toMatchObject({provider:providerId, mode:'full'});
    await permissions.click();
    await page.getByRole('dialog', {name:'Permissions',exact:true}).getByRole('menuitemradio', {name:providerId === 'codex' ? 'Read only' : 'Plan mode',exact:true}).click();
    await expect.poll(readTask).toMatchObject({mode:'plan'});
    await page.getByRole('button', {name:'Choose harness and model',exact:true}).click();
    const next = providerId === 'codex' ? 'claude' : 'codex';
    await page.getByRole('dialog', {name:'Harness and model',exact:true}).locator(`button[data-provider="${next}"][data-model="${next === 'codex' ? 'gpt-6-astra' : 'sonnet'}"]`).click();
    await expect.poll(readTask).toMatchObject({provider:next, mode:'plan'});
    await expect(permissions).toHaveText(next === 'codex' ? 'Read only' : 'Plan mode');
    await page.locator('.new-task-button').click();
    await expect(permissions).toHaveText('Full access');
    await expect.poll(readTask).toMatchObject({provider:next, mode:'full'});
  });
}

test('GitHub Copilot CLI has CLI sign-in guidance, a path override, Default model, and advertised modes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'github-copilot'));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.locator('.new-task-button').click();
  await expect(page.locator('.conversation-pane')).toHaveClass(/new-task-page/);
  await expect(page.locator('#model-picker-trigger .provider-logo[data-provider="github-copilot"]')).toBeVisible();
  await page.locator('#mode-picker-trigger').click();
  const modes = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(modes).toHaveCount(3);
  await expect(modes.filter({ hasText: 'Accept edits' })).toHaveCount(0);
  await expect(modes.filter({ hasText: 'Plan mode' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  const model = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await model.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const copilot = picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="default"]');
  await expect(copilot).toContainText('Default');
  await page.getByRole('searchbox', { name: 'Search harnesses and models' }).fill('custom-copilot-model');
  await expect(picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="custom-copilot-model"]')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search harnesses and models' }).fill('');
  await expect(copilot).toBeVisible();
  await copilot.click();
  await expect(model.locator('.provider-logo[data-provider="github-copilot"]')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'GitHub Copilot CLI', exact: false }) });
  await expect(card).toContainText('copilot login');
  await expect(card.getByRole('link', { name: 'Install and sign in' })).toHaveAttribute('href', 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli');
  await card.locator('summary').click();
  await expect(card.getByLabel('GitHub Copilot CLI executable', { exact: true })).toBeVisible();
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.locator('.provider-diagnostic[data-provider="github-copilot"]')).toContainText('GitHub Copilot CLI 1.0.82');
  await settings.getByRole('button', { name: 'Default agent for new tasks', exact: true }).click();
  const defaultMenu = page.getByRole('dialog', { name: 'Default agent', exact: true });
  await defaultMenu.getByRole('menuitemradio', { name: 'GitHub Copilot CLI', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Default agent for new tasks', exact: true })).toContainText('GitHub Copilot CLI');
});

test('GitHub Copilot model discovery does not crash the picker in an existing chat', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker).toBeVisible();
  const copilot = picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="default"]');
  await expect(copilot).toContainText('Default');
  await expect.poll(() => errors).toEqual([]);
});

test('Pi offers four approval modes with Accept edits', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'pi'));
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: 'Accept edits' })).toHaveCount(1);
});

test('settings organization supports Pi models and executable settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await page.locator('.new-task-button').click();
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const pi = picker.locator('.model-menu-option').filter({ has: page.locator('[data-provider="pi"]') });
  await pi.first().click();
  await expect(trigger.locator('[data-provider="pi"]')).toBeVisible();
  await trigger.click();
  await expect(picker.locator('.model-menu-option').filter({ has: page.locator('[data-provider="pi"]') }).filter({ hasText: 'Claude Sonnet 4.5' })).toContainText('200K context');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Pi', exact: true }) });
  await expect(card.getByRole('link', { name: 'Install Pi' })).toHaveAttribute('href', 'https://github.com/earendil-works/pi');
  await card.locator('summary').click();
  await expect(card.getByLabel('Pi executable', { exact: true })).toBeVisible();
});

test('DeepSeek has a key card, four approval modes and effort levels', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'deepseek'));
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: 'Accept edits' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'DeepSeek', exact: false }) });
  await expect(card.getByRole('link', { name: 'Get an API key' })).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys');
  await expect(card.getByLabel('DeepSeek API key', { exact: true })).toHaveAttribute('type', 'password');
  await card.locator('summary').click();
  await expect(card.getByLabel('DeepSeek executable', { exact: true })).toBeVisible();
});

test('Command Code has a key card, four approval modes and its own model list', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'commandcode'));
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: 'Accept edits' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Command Code', exact: false }) });
  await expect(card.getByRole('link', { name: 'Command Code docs' })).toHaveAttribute('href', 'https://commandcode.ai/docs/acp');
  await expect(card.getByLabel('Command Code API key', { exact: true })).toHaveAttribute('type', 'password');
  await card.locator('summary').click();
  await expect(card.getByLabel('Command Code executable', { exact: true })).toBeVisible();
});

test('Cline has a sign-in card, four approval modes and thinking levels', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'cline'));
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await expect(page.locator('#model-picker-trigger .provider-logo[data-provider="cline"]')).toBeVisible();
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: 'Accept edits' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Plan mode' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Cline', exact: false }) });
  await expect(card).toContainText('cline auth');
  await expect(card.getByRole('link', { name: 'Cline CLI docs' })).toHaveAttribute('href', 'https://docs.cline.bot/cline-cli/overview');
  await card.locator('summary').click();
  await expect(card.getByLabel('Cline executable', { exact: true })).toBeVisible();
});
