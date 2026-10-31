import { showHarness } from './model-picker-helper';
import { expect, test, type Page } from '@playwright/test';

const selectedKey = 'pandacode.preview.opencode-models';
// OpenCode models are embedded in Settings → Agents.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const dialog = (page: Page) => settings(page).locator('#settings-panel-agents [data-embed="openCodeModels"]');
const modelCheckbox = (page: Page, name: string) => dialog(page).getByRole('checkbox', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const savedIds = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as string[], selectedKey);

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  // Use an unsent task so choosing a harness exercises the real composer flow.
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}

async function openModels(page: Page, firstModel = 'Big Pickle'): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings(page).getByRole('heading', { name: 'OpenCode models', exact: true })).toBeVisible();
  await expect(modelCheckbox(page, firstModel)).toBeVisible();
}

async function saveModels(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: 'Save models', exact: true }).click();
  await expect(dialog(page).getByText('Models saved. Available in every model selector.', { exact: true })).toBeVisible();
}

async function openPicker(page: Page): Promise<void> {
  if (await settings(page).isVisible()) await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  await picker(page).getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill('OpenCode');
  await expect(picker(page).getByRole('option', { name: 'OpenCode · Default', exact: true })).toBeVisible();
}

async function failuresAndDelay(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      window.__openCodeModels ??= { errors: {}, delaySave: false, calls: [] };
      const fixture = window.__openCodeModels;
      fixture.calls.push({ command, args: structuredClone(args) });
      if (fixture.errors[command]) throw new Error(fixture.errors[command]);
      if (command === 'save_opencode_models' && fixture.delaySave) {
        await new Promise(resolve => { fixture.releaseSave = resolve; });
        fixture.delaySave = false;
        delete fixture.releaseSave;
      }
    `) });
  });
}

test('selected OpenCode models survive reload and appear in the composer without unselected models', async ({ page }) => {
  await boot(page);
  await openPicker(page);
  // Nothing selected yet: searching reaches the whole catalog, as OpenCode itself does.
  await expect(picker(page).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(8);
  await page.keyboard.press('Escape');
  await openModels(page);
  await modelCheckbox(page, 'Big Pickle').check();
  const search = dialog(page).getByRole('searchbox', { name: 'Search OpenCode models', exact: true });
  await search.fill('anthropic/');
  await expect(modelCheckbox(page, 'Big Pickle')).toHaveCount(0);
  await modelCheckbox(page, 'Claude Sonnet 4.6').check();
  await search.fill('no-such-model-926');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
  await search.fill('');
  await expect(modelCheckbox(page, 'Big Pickle')).toBeChecked();
  await expect(modelCheckbox(page, 'Claude Sonnet 4.6')).toBeChecked();
  await expect(modelCheckbox(page, 'GPT-5.4')).not.toBeChecked();
  await saveModels(page);
  expect((await savedIds(page)).sort()).toEqual(['anthropic/claude-sonnet-4-6', 'opencode/big-pickle']);
  await openPicker(page);
  await expect(picker(page).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(3);
  await expect(picker(page).getByRole('option', { name: 'OpenCode · Big Pickle', exact: true })).toBeVisible();
  await expect(picker(page).getByRole('option', { name: 'OpenCode · Claude Sonnet 4.6', exact: true })).toBeVisible();
  await expect(picker(page).getByRole('option', { name: 'OpenCode · GPT-5.4', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await openModels(page);
  await expect(modelCheckbox(page, 'Big Pickle')).toBeChecked();
  await expect(modelCheckbox(page, 'Claude Sonnet 4.6')).toBeChecked();
  await expect(modelCheckbox(page, 'GPT-5.4')).not.toBeChecked();
  await openPicker(page);
  await expect(picker(page).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(3);
});

test('without a saved selection the picker lists Default plus the five most recent OpenCode models', async ({ page }) => {
  await boot(page);
  await openPicker(page);
  const search = picker(page).getByRole('combobox', { name: 'Search harnesses and models', exact: true });
  await search.fill('');
  await showHarness(page, 'opencode');
  const openCode = picker(page).getByRole('option', { name: /^OpenCode ·/ });
  await expect(openCode).toHaveCount(6);
  await expect(picker(page).getByRole('option', { name: 'OpenCode · Grok 4', exact: true })).toHaveCount(0);
  // Search still reaches models beyond the short list.
  await search.fill('grok-4');
  await picker(page).getByRole('option', { name: 'OpenCode · Grok 4', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toContainText('Grok 4');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  await expect(openCode).toHaveCount(6);
  await expect(openCode.nth(1)).toHaveAccessibleName('OpenCode · Grok 4');
});

test('deselecting a model does not change an existing task using it', async ({ page }) => {
  await boot(page);
  await openModels(page);
  await modelCheckbox(page, 'Big Pickle').check();
  await saveModels(page);
  await openPicker(page);
  await picker(page).getByRole('option', { name: 'OpenCode · Big Pickle', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toContainText('Big Pickle');
  await page.keyboard.press('Escape');
  await openModels(page);
  await modelCheckbox(page, 'Big Pickle').uncheck();
  await saveModels(page);
  expect(await savedIds(page)).toEqual([]);
  await openPicker(page);
  const current = picker(page).locator('[data-provider="opencode"][data-model="opencode/big-pickle"]');
  await expect(current).toHaveAttribute('aria-current', 'true');
  await picker(page).getByRole('option', { name: 'OpenCode · Default', exact: true }).click();
  await page.keyboard.press('Escape');
  await openPicker(page);
  // Clearing the selection makes the whole catalog searchable again.
  await expect(picker(page).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(8);
});

test('refresh and save failures keep draft choices available for retry', async ({ page }) => {
  await failuresAndDelay(page);
  await boot(page);
  await openModels(page);
  await modelCheckbox(page, 'Big Pickle').check();
  await page.evaluate(() => { (window as any).__openCodeModels.errors.list_opencode_models = 'OpenCode catalog temporarily unavailable'; });
  await dialog(page).getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(dialog(page)).toContainText('OpenCode catalog temporarily unavailable');
  await expect(modelCheckbox(page, 'Big Pickle')).toBeChecked();
  await page.evaluate(() => { delete (window as any).__openCodeModels.errors.list_opencode_models; });
  await dialog(page).getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(dialog(page)).not.toContainText('OpenCode catalog temporarily unavailable');
  await expect(modelCheckbox(page, 'Big Pickle')).toBeChecked();
  await modelCheckbox(page, 'GPT-5.4').check();
  await page.evaluate(() => { (window as any).__openCodeModels.errors.save_opencode_models = 'Model preferences could not be saved'; });
  await dialog(page).getByRole('button', { name: 'Save models', exact: true }).click();
  await expect(dialog(page)).toContainText('Model preferences could not be saved');
  await expect(modelCheckbox(page, 'Big Pickle')).toBeChecked();
  await expect(modelCheckbox(page, 'GPT-5.4')).toBeChecked();
  expect(await savedIds(page)).toEqual([]);
  await page.evaluate(() => { delete (window as any).__openCodeModels.errors.save_opencode_models; });
  await saveModels(page);
  expect((await savedIds(page)).sort()).toEqual(['opencode/big-pickle', 'openai/gpt-5.4'].sort());
});

test('saving locks selection until persistence finishes and does not replace the search input', async ({ page }) => {
  await failuresAndDelay(page);
  await boot(page);
  await openModels(page);
  await modelCheckbox(page, 'Big Pickle').check();
  const search = dialog(page).getByRole('searchbox', { name: 'Search OpenCode models', exact: true });
  await search.evaluate(input => { (window as any).__openCodeSearch = input; });
  await page.evaluate(() => { (window as any).__openCodeModels.delaySave = true; });
  const save = dialog(page).locator('[data-save]');
  await save.click();
  await expect(save).toBeDisabled();
  await expect(modelCheckbox(page, 'Big Pickle')).toBeDisabled();
  await page.waitForFunction(() => typeof (window as any).__openCodeModels.releaseSave === 'function');
  await page.evaluate(() => (window as any).__openCodeModels.releaseSave());
  await expect(save).toHaveText('Save models');
  await expect(save).toBeDisabled();
  await expect(modelCheckbox(page, 'Big Pickle')).toBeEnabled();
  expect(await search.evaluate(input => input === (window as any).__openCodeSearch)).toBe(true);
  expect(await savedIds(page)).toEqual(['opencode/big-pickle']);
  await modelCheckbox(page, 'GPT-5.4').check();
  await saveModels(page);
  expect((await savedIds(page)).sort()).toEqual(['opencode/big-pickle', 'openai/gpt-5.4'].sort());
});

test('a full OpenCode catalog stays bounded while every model remains searchable and selectable', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      if (command === 'list_opencode_models') return {
        models: Array.from({length:2012}, (_, index) => {
          const suffix = String(index).padStart(4, '0');
          return {id:'opencode/catalog-' + suffix, name:'Catalog model ' + suffix, description:''};
        }),
        selectedModelIds: [], error: null,
      };
    `) });
  });
  await boot(page);
  await openModels(page, 'Catalog model 0000');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(80);
  await modelCheckbox(page, 'Catalog model 0000').check();
  await dialog(page).getByRole('button', { name: /^Show more models/ }).click();
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(160);
  await modelCheckbox(page, 'Catalog model 0150').check();
  const search = dialog(page).getByRole('searchbox', { name: 'Search OpenCode models', exact: true });
  await search.fill('2011');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(1);
  await modelCheckbox(page, 'Catalog model 2011').check();
  await search.fill('0150');
  await expect(modelCheckbox(page, 'Catalog model 0150')).toBeChecked();
  await search.fill('');
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(80);
  await expect(modelCheckbox(page, 'Catalog model 0000')).toBeChecked();
  await expect(dialog(page).getByText('3 selected', { exact: true })).toBeVisible();
  await saveModels(page);
  expect((await savedIds(page)).sort()).toEqual(['opencode/catalog-0000', 'opencode/catalog-0150', 'opencode/catalog-2011']);
});

test('saving in the workspace invalidates the already-open launcher model cache immediately', async ({ page, context }) => {
  await boot(page);
  const launcher = await context.newPage();
  try {
    await launcher.goto('/?view=launcher');
    await openPicker(launcher);
    await expect(picker(launcher).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(8);
    await picker(launcher).getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill('');
    await showHarness(launcher, 'opencode');
    await expect(picker(launcher).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(6);
    // Wait for its initial catalog request to finish so this really warms the cache.
    await expect(picker(launcher).locator('[data-catalog-loading="opencode"]')).toBeHidden();
    await launcher.keyboard.press('Escape');
    await openModels(page);
    await modelCheckbox(page, 'Big Pickle').check();
    await saveModels(page);
    await openPicker(launcher);
    await expect(picker(launcher).getByRole('option', { name: 'OpenCode · Big Pickle', exact: true })).toBeVisible();
    await expect(picker(launcher).getByRole('option', { name: /^OpenCode ·/ })).toHaveCount(2);
    // The first Escape clears the search, the second closes the picker.
    await launcher.keyboard.press('Escape');
    await launcher.keyboard.press('Escape');
    await modelCheckbox(page, 'Big Pickle').uncheck();
    await modelCheckbox(page, 'GPT-5.4').check();
    await saveModels(page);
    await openPicker(launcher);
    await expect(picker(launcher).getByRole('option', { name: 'OpenCode · GPT-5.4', exact: true })).toBeVisible();
    await expect(picker(launcher).getByRole('option', { name: 'OpenCode · Big Pickle', exact: true })).toHaveCount(0);
    expect(launcher.url()).toContain('view=launcher');
    await expect(launcher.locator('html')).not.toHaveAttribute('data-overlay-hidden', 'true');
  } finally { await launcher.close(); }
});
