import { pickModel, showHarness } from './model-picker-helper';
import { expect, test, type Page } from '@playwright/test';

test('global and per-provider environment variables are added, toggled, removed, and never echoed', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();

  // The global set applies to every harness and its values are never shown again.
  const global = page.locator('#global-environment');
  await global.getByLabel('Variable name').fill('HTTPS_PROXY');
  await global.getByLabel('Variable value').fill('http://127.0.0.1:7890');
  await global.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(global.locator('.connection-env-var code')).toHaveText('HTTPS_PROXY');
  await expect(global).not.toContainText('127.0.0.1:7890');
  await expect(global.getByLabel('Variable name')).toHaveValue('');

  // A second variable on the same set; an invalid name is refused with the reason.
  await global.getByLabel('Variable name').fill('NO_PROXY');
  await global.getByLabel('Variable value').fill('localhost,127.0.0.1');
  await global.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(global.locator('.connection-env-var')).toHaveCount(2);
  await global.getByLabel('Variable name').fill('BAD-NAME');
  await global.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.connection-feedback')).toContainText('letters, digits and underscores');

  // A provider card carries its own variables and the global toggle (on by default).
  const claude = page.locator('#claude-connection');
  await claude.locator('details.connection-env > summary').click();
  await expect(claude.getByRole('checkbox', { name: 'Use global environment variables' })).toBeChecked();
  await claude.getByLabel('Variable name').fill('CLAUDE_CODE_EXTRA');
  await claude.getByLabel('Variable value').fill('1');
  await claude.locator('form[data-env-provider="claude"]').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(claude.locator('.connection-env-var')).toHaveCount(1);
  await expect(claude.locator('.connection-env-var code')).toHaveText('CLAUDE_CODE_EXTRA');

  // Toggling the global set off for one provider leaves the others alone.
  await claude.getByRole('checkbox', { name: 'Use global environment variables' }).uncheck();
  await expect(claude.getByRole('checkbox', { name: 'Use global environment variables' })).not.toBeChecked();
  const glm = page.locator('#claude-connection + .connection-card');
  await glm.locator('details.connection-env > summary').click();
  await expect(glm.getByRole('checkbox', { name: 'Use global environment variables' })).toBeChecked();

  // Removing a variable takes it off the list again.
  await claude.getByRole('button', { name: 'Remove CLAUDE_CODE_EXTRA' }).click();
  await expect(claude.locator('.connection-env-var')).toHaveCount(0);
  await global.getByRole('button', { name: 'Remove HTTPS_PROXY' }).click();
  await expect(global.locator('.connection-env-var')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('provider connections expose Kilo models, approval modes and executable settings', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.new-task-button').click();
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await showHarness(page, 'kilo');
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
  await expect(card.locator('h3 .provider-logo[data-provider="kilo"]')).toBeVisible();
  const ompCard = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Oh My Pi', exact: false }) });
  await expect(ompCard.locator('h3 .provider-logo[data-provider="omp"]')).toBeVisible();
  await expect(card).toContainText('kilo auth login');
  await expect(card.getByRole('link', { name: 'Kilo CLI docs' })).toHaveAttribute('href', 'https://kilo.ai/docs/code-with-ai/platforms/cli');
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('Kilo executable', { exact: true })).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('kilo-provider-settings.png') });
});

test('provider connections show the ZCode sign-in card', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'ZCode', exact: false }) });
  await expect(card).toContainText('Run zcode in a terminal and sign in');
  await expect(card.getByRole('link', { name: 'ZCode docs' })).toHaveAttribute('href', 'https://github.com/zai-org/ZCode');
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
        window.releaseProviderConfiguration = () => resolve({ executablePaths: { opencode: '/installed/opencode', antigravity: '/installed/agy_acp_server.par', claude: '/installed/claude', codex: '/installed/codex', kimi: '/installed/kimi' }, glmKeySaved: false, glmKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: 'token-plan-ams', mimoEndpoints: [{ id: 'token-plan-ams', url: 'https://token-plan-ams.xiaomimimo.com/anthropic', label: 'Token Plan · Europe cluster' }], secureStorageAvailable: false });
      });
      if (command === 'provider_set_executable') return new Promise(resolve => {
        window.releaseProviderSave = () => { delete window.releaseProviderSave; resolve({ executablePaths: { opencode: args.path.replaceAll('//', '/'), antigravity: '/installed/agy_acp_server.par', claude: '/installed/claude', codex: '/installed/codex', kimi: '/installed/kimi' }, glmKeySaved: false, glmKeyFromEnvironment: false, mimoKeySaved: false, mimoKeyFromEnvironment: false, mimoEndpoint: 'token-plan-ams', mimoEndpoints: [{ id: 'token-plan-ams', url: 'https://token-plan-ams.xiaomimimo.com/anthropic', label: 'Token Plan · Europe cluster' }], secureStorageAvailable: false }); };
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
  const codex = page.getByLabel('Codex executable', { exact: true });
  await antigravity.fill('/draft/agy_acp_server.par');
  await page.evaluate(() => (window as any).releaseProviderConfiguration());
  await expect(opencode).toHaveValue('/installed/opencode');
  await expect(antigravity).toHaveValue('/draft/agy_acp_server.par');
  await expect(codex).toHaveValue('/installed/codex');
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
  await expect(codex).toHaveValue('/installed/codex');
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
  await expect(dialog.getByText('Each sign-in, key or plan here is used only by the agent it belongs to.')).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'How providers relate to agents', exact: true })).toHaveAttribute('data-tip', /the global environment variables are the one thing every harness gets/);
  // OpenCode models are chosen once, in Settings → Agents.
  await expect(dialog.getByRole('button', { name: 'Choose models', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('agy', { exact: true })).toBeVisible();
  await expect(dialog.getByText('grok login', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Codex executable', { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel('Kimi executable', { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel('Claude Code executable', { exact: true })).toHaveCount(1);
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
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).not.toContainText('Antigravity'); // not installed in the preview
  await expect(page.getByText('Grok Build', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('MiMo Token Plan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('GitHub Copilot CLI', { exact: true }).first()).toBeVisible();
  await page.getByText('GLM Coding Plan', { exact: true }).first().click();
  await expect(page.getByText('GLM-5.3', { exact: true }).first()).toBeVisible();
});

for (const providerId of ['claude', 'codex', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes']) {
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
    await pickModel(page, next, next === 'codex' ? 'gpt-6-astra' : 'sonnet');
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
  await showHarness(page, 'github-copilot');
  const copilot = picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="default"]');
  await expect(copilot).toContainText('Default');
  await page.getByRole('combobox', { name: 'Search harnesses and models' }).fill('custom-copilot-model');
  await expect(picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="custom-copilot-model"]')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search harnesses and models' }).fill('');
  await showHarness(page, 'github-copilot');
  await expect(copilot).toBeVisible();
  await copilot.click();
  await expect(model.locator('.provider-logo[data-provider="github-copilot"]')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'GitHub Copilot CLI', exact: false }) });
  await expect(card).toContainText('copilot login');
  await expect(card.getByRole('link', { name: 'Install and sign in' })).toHaveAttribute('href', 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli');
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('GitHub Copilot CLI executable', { exact: true })).toBeVisible();
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.locator('.provider-diagnostic[data-provider="github-copilot"]')).toContainText('GitHub Copilot CLI 1.0.82');
  await settings.getByRole('button', { name: 'Default agent for new tasks', exact: true }).click();
  const defaultMenu = page.getByRole('dialog', { name: 'Default agent', exact: true });
  await defaultMenu.getByRole('menuitemradio', { name: 'GitHub Copilot CLI', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Default agent for new tasks', exact: true })).toContainText('GitHub Copilot CLI');
});

test('Devin CLI lists its models with their own thinking levels, Devin modes, and CLI sign-in guidance', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.provider', 'devin'));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.locator('.new-task-button').click();
  await expect(page.locator('#model-picker-trigger .provider-logo[data-provider="devin"]')).toBeVisible();
  // Devin's Code mode already accepts edits, so Accept edits is not a separate choice.
  await page.locator('#mode-picker-trigger').click();
  const modes = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(modes).toHaveCount(3);
  await expect(modes.filter({ hasText: 'Accept edits' })).toHaveCount(0);
  await expect(modes.filter({ hasText: 'Plan mode' })).toContainText('edits wait until you approve the plan');
  await page.keyboard.press('Escape');

  const model = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  const search = page.getByRole('combobox', { name: 'Search harnesses and models' });
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const group = picker;
  await model.click();
  await showHarness(page, 'devin');
  // A long catalog opens as a short list; search covers every model, and custom IDs are not offered.
  await expect(group.locator('.model-menu-option[data-model="adaptive"]')).toBeVisible();
  await expect(group.locator('.model-menu-option[data-model^="fusion-"]')).toHaveCount(0);
  await search.fill('fusion');
  await expect(group.locator('.model-menu-option[data-model="fusion-claude-opus-5-5-medium-sidekick-swe-2-medium"]')).toBeVisible();
  await search.fill('custom-devin-model');
  await expect(picker.locator('.model-menu-option[data-provider="devin"][data-model="custom-devin-model"]')).toHaveCount(0);
  await search.fill('');
  await showHarness(page, 'devin');
  await group.locator('.model-menu-option[data-model="claude-opus-5-5-medium"]').click();
  await expect(model).toContainText('Claude Opus 5.5');

  // Each model carries its own thinking levels.
  await model.click();
  const effort = picker.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio');
  await expect(effort).toHaveCount(6);
  await search.fill('glm');
  await expect(group.locator('.model-menu-option[data-model="glm-5-2"]')).toHaveAttribute('title', 'Text only');
  await group.locator('.model-menu-option[data-model="glm-5-2"]').click();
  await model.click();
  await expect(effort).toHaveCount(4);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Devin CLI', exact: false }) });
  await expect(card).toContainText('devin auth login');
  await expect(card.getByRole('link', { name: 'Install and sign in' })).toHaveAttribute('href', 'https://docs.devin.ai/cli');
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('Devin executable', { exact: true })).toBeVisible();
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.locator('.provider-diagnostic[data-provider="devin"]')).toContainText('devin 3000.11.216');
});

test('GitHub Copilot model discovery does not crash the picker in an existing chat', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker).toBeVisible();
  await showHarness(page, 'github-copilot');
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
  await showHarness(page, 'pi');
  const pi = picker.locator('.model-menu-option[data-provider="pi"]');
  await pi.first().click();
  await expect(trigger.locator('[data-provider="pi"]')).toBeVisible();
  await trigger.click();
  await expect(picker.locator('.model-menu-option[data-provider="pi"]').filter({ hasText: 'Claude Sonnet 4.5' })).toContainText('200K');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Pi', exact: true }) });
  await expect(card.getByRole('link', { name: 'Install Pi' })).toHaveAttribute('href', 'https://github.com/earendil-works/pi');
  await card.locator('details.connection-path > summary').click();
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
  await card.locator('details.connection-path > summary').click();
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
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('Command Code executable', { exact: true })).toBeVisible();
});

test('Cline has a sign-in card, four approval modes and thinking levels', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.defaultProvider', 'cline');
    localStorage.setItem('pandacode.provider', 'cline');
  });
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
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
  await expect(card.getByRole('link', { name: 'Cline CLI docs' })).toHaveAttribute('href', 'https://docs.cline.bot/usage/cli-overview');
  await expect(card.getByRole('link', { name: 'ACP details' })).toHaveAttribute('href', 'https://docs.cline.bot/usage/acp');
  await expect(card.getByRole('link', { name: 'TUI docs' })).toHaveAttribute('href', 'https://docs.cline.bot/usage/tui');
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('Cline executable', { exact: true })).toBeVisible();
});

test('Hermes Agent has an install card, four approval modes, and executable settings', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.defaultProvider', 'hermes');
    localStorage.setItem('pandacode.provider', 'hermes');
  });
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await page.locator('#mode-picker-trigger').click();
  const items = page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: 'Accept edits' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Plan mode' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Hermes Agent', exact: false }) });
  await expect(card).toContainText('hermes acp');
  await expect(card.getByRole('link', { name: 'Hermes docs' })).toHaveAttribute('href', 'https://hermes-agent.org');
  await expect(card.getByRole('link', { name: 'GitHub repository' })).toHaveAttribute('href', 'https://github.com/NousResearch/hermes-agent');
  await card.locator('details.connection-path > summary').click();
  await expect(card.getByLabel('Hermes Agent executable', { exact: true })).toBeVisible();
});

