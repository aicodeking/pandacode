import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview transport and the recorded fake harness. No real harness runs. The native side of
// "no package process before the first send" is warm_launch::tests::a_package_harness_is_never_started_ahead_and_its_first_send_starts_it_once.
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
const mark = readFileSync('tests/fixtures/extensions/fake-harness/assets/mark.svg', 'utf8');
/** Two contributed model picker actions: every one must be a keyboard stop, not only the first. */
const modelActions = {
  manifestVersion: 1, id: 'sample.model-actions', version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui', permissions: ['ui.contribute'],
  contributes: {
    commands: [
      { id: 'sample.model-actions/notes', title: 'Model notes', action: { kind: 'showMessage', message: 'Notes for the captured model.' } },
      { id: 'sample.model-actions/tips', title: 'Model tips', action: { kind: 'showMessage', message: 'Tips for the captured model.' } },
    ],
    menus: [
      // Contribution ids are unique across commands and menus (contracts.ts DuplicateId), so the rows get their own.
      { id: 'sample.model-actions/notes-row', command: 'sample.model-actions/notes', location: 'panda.composer.model.actions', presentation: 'button', text: 'Model notes' },
      { id: 'sample.model-actions/tips-row', command: 'sample.model-actions/tips', location: 'panda.composer.model.actions', presentation: 'button', text: 'Model tips' },
    ],
  },
};
const harness = (value = manifest) => ({ manifest: value, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } });
async function seed(page: Page, packages: unknown[], defaultProvider?: string) {
  await page.addInitScript(({ packages, defaultProvider }) => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    if (defaultProvider) localStorage.setItem('pandacode.defaultProvider', defaultProvider);
  }, { packages, defaultProvider });
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
}
const pickerOf = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const task = (page: Page) => page.evaluate(() => (window as any).__extensionHarness.task());
const starts = (page: Page) => page.evaluate(() => (window as any).__extensionHarness.starts());
/** A model row by its accessible name, or by its identity where a harness's Default row carries the same label. */
type Row = string | { provider: string; model: string };
const rowOf = (page: Page, option: Row) => typeof option === 'string'
  ? pickerOf(page).getByRole('option', { name: option, exact: true })
  : pickerOf(page).locator(`[role="option"][data-provider="${option.provider}"][data-model="${option.model}"]`);
/** Alibaba's Default row is labelled with its default model, so the explicit row is picked by identity. */
const qwenMax: Row = { provider: 'alibaba', model: 'qwen3.8-max' };
/** Picks a model through search, as a user who knows its name does. */
async function choose(page: Page, query: string, option: Row) {
  await page.locator('#model-picker-trigger').click();
  const picker = pickerOf(page);
  await picker.getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill(query);
  await rowOf(page, option).click();
  await expect(picker).toHaveCount(0);
}
test('extensions provider catalog: model, effort, modes, brand, auth and unsupported limits use package metadata', async ({ page }) => {
  await page.addInitScript(({ manifest, mark }) => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: { 'sample.fake-harness/mark': mark }, executable: { digest: 'synthetic', trusted: true } }])), { manifest, mark });
  await page.goto('/?extension-harness');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Recorded harness', exact: true }).click();
  await expect(picker.getByRole('option', { name: 'Recorded harness · Default', exact: true })).toHaveCount(0);
  await expect(picker.locator('[data-host-icon="sample.fake-harness/mark"] path').first()).toHaveAttribute('d', 'M4 4h16v16H4zM8 8h8v8H8z');
  await picker.getByRole('option', { name: 'Recorded harness · Recorded model', exact: true }).click();
  await page.locator('#model-picker-trigger').click();
  await picker.getByRole('radio', { name: 'medium', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#mode-picker-trigger').click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(permissions).toContainText('Plan mode');
  await expect(permissions).not.toContainText('Full access');
  await page.keyboard.press('Escape');
  const usage = await page.evaluate(() => (window as any).__extensionHarness.call('agent_usage', { provider: 'sample.fake-harness/recorded', refresh: false }));
  expect(usage).toMatchObject({ status: 'unsupported', windows: [], message: manifest.contributes.providers[0].metadata.usage.limitsReason });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  const card = page.locator('[data-extension-provider="sample.fake-harness/recorded"]');
  await expect(card).toContainText('no sign-in or API key required');
  await expect(card).toContainText('Ready offline');
  await expect(card).toContainText('not subscription limits');
  await expect(card.locator('input')).toHaveCount(0);
});
test('extensions provider catalog: unavailable and signed-out metadata gives a reason and refresh recovers', async ({ page }) => {
  const unavailable = structuredClone(manifest);
  unavailable.contributes.providers[0].metadata.readiness = { state: 'signedOut', reason: 'Sign in using the recorded extension, then refresh.' };
  await page.addInitScript(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }])), unavailable);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: /Recorded harness/ }).click();
  const option = picker.getByRole('option', { name: 'Recorded harness · Recorded model', exact: true });
  await expect(option).toBeDisabled(); await expect(option).toHaveAttribute('title', /Sign in using/);
  await page.keyboard.press('Escape');
  await page.evaluate(async manifest => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }]));
    await (window as any).__extensionHarness.call('extensions_enable', { id: 'sample.fake-harness', enabled: true });
  }, manifest);
  await page.locator('#model-picker-trigger').click();
  await picker.getByRole('tab', { name: 'Recorded harness', exact: true }).click();
  await expect(option).toBeEnabled(); await option.click();
  await expect(page.locator('[data-provider-recovery]')).toHaveCount(0);
});
test('extensions provider catalog: a new task uses an advertised model and supported mode', async ({ page }) => {
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }]));
    localStorage.setItem('pandacode.defaultProvider', 'sample.fake-harness/recorded');
  }, manifest);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: /New task/ }).first().click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Recorded model');
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'ask');
  await page.locator('#prompt').fill('Use the advertised defaults'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeVisible();
  const sessions = await page.evaluate(() => (window as any).__extensionHarness.call('list_sessions', {}));
  expect(sessions.some((session: any) => session.provider === 'sample.fake-harness/recorded' && session.model === 'recorded-model' && session.mode === 'ask')).toBe(true);
});
test('extensions provider catalog: no package process starts while the picker opens and switches or a draft is typed; the first send starts one', async ({ page }) => {
  // Three rounds of four picker trips each, then a send: longer than the default budget in WebKit.
  test.setTimeout(60_000);
  await seed(page, [harness()]);
  const picker = pickerOf(page);
  for (let round = 0; round < 3; round++) {
    // To the package harness, an effort, away to a built-in and back: every pick may ask native to warm, none starts it.
    await choose(page, 'recorded model', 'Recorded harness · Recorded model');
    await page.locator('#model-picker-trigger').click();
    await picker.getByRole('radio', { name: round % 2 ? 'low' : 'medium', exact: true }).click();
    await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
    await choose(page, 'qwen3.8-max', qwenMax);
    await choose(page, 'recorded model', 'Recorded harness · Recorded model');
    // The first keystrokes of a draft are the warm_task signal.
    await page.locator('#prompt').fill(`Draft ${round}`); await page.locator('#prompt').fill('');
    expect(await starts(page)).toBe(0);
  }
  await page.locator('#model-picker-trigger').click();
  await picker.getByRole('radio', { name: 'medium', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('The first authorized send'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('region', { name: 'Approval needed', exact: true })).toBeVisible();
  expect(await starts(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).__extensionHarness.starts('session-1'))).toBe(1);
  expect(await task(page)).toMatchObject({ provider: 'sample.fake-harness/recorded', model: 'recorded-model', reasoningEffort: 'medium' });
});
test('extensions provider catalog: upstream speed and effort choices and every contributed action are keyboard reachable and save', async ({ page }) => {
  await seed(page, [harness(), { manifest: modelActions, enabled: true, icons: {} }]);
  const picker = pickerOf(page);
  const search = picker.getByRole('combobox', { name: 'Search harnesses and models', exact: true });
  const effort = picker.getByRole('radiogroup', { name: 'Effort', exact: true }), speed = picker.getByRole('radiogroup', { name: 'Speed', exact: true });
  const notes = picker.getByRole('button', { name: 'Model notes', exact: true }), tips = picker.getByRole('button', { name: 'Model tips', exact: true });
  await choose(page, 'astra', 'Codex · GPT-6-Astra');
  await page.locator('#model-picker-trigger').click();
  await expect(search).toBeFocused();
  await page.keyboard.press('Tab'); await expect(picker.getByRole('tab', { name: 'Codex', exact: true })).toBeFocused();
  // Effort: Tab lands on the saved choice, an arrow saves the next one.
  await page.keyboard.press('Tab'); await expect(effort.getByRole('radio', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(effort.getByRole('radio', { name: 'Low', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('low');
  // Speed: upstream's tiers, the same way, once the effort save has landed (Speed waits for it, model-picker.ts).
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  // A composer repaint after the picker's own effort choice keeps it open (it once closed it, and the action row with it).
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-github-change')));
  await expect(notes).toBeVisible();
  await expect(effort.getByRole('radio', { name: 'Low', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(speed.getByRole('radio', { name: 'Standard', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await task(page)).codexSettings?.serviceTier).toBe('priority');
  await expect(speed.getByRole('radio', { name: 'Fast', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  await expect(speed.getByRole('radio', { name: 'Fast', exact: true })).toBeFocused();
  // Every contributed action is a stop, in order; Tab wraps to search and Shift+Tab walks back.
  await page.keyboard.press('Tab'); await expect(notes).toBeFocused();
  await page.keyboard.press('Tab'); await expect(tips).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.locator('#toast')).toContainText('Tips for the captured model.');
  await page.keyboard.press('Tab'); await expect(search).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(tips).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(notes).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(speed.getByRole('radio', { name: 'Fast', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  // Reopened, the saved choices are checked and are the stops.
  await page.locator('#model-picker-trigger').click();
  await expect(effort.getByRole('radio', { name: 'Low', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(speed.getByRole('radio', { name: 'Fast', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(effort.getByRole('radio', { name: 'Low', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(speed.getByRole('radio', { name: 'Fast', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  // Cursor (new built-in): its per-model efforts are reachable the same way.
  await choose(page, 'gpt-5.5', 'Cursor CLI · GPT-5.5');
  await page.locator('#model-picker-trigger').click();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(effort.getByRole('radio', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('extra-high');
  await expect(speed).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  // A package harness declares no speed tiers: no Speed row; its own efforts and the actions stay reachable.
  await choose(page, 'recorded model', 'Recorded harness · Recorded model');
  await page.locator('#model-picker-trigger').click();
  await expect(speed).toHaveCount(0);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(effort.getByRole('radio', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('low');
  await expect(picker).toHaveAttribute('aria-busy', 'false');
  await page.keyboard.press('Tab'); await expect(notes).toBeFocused();
  await page.keyboard.press('Tab'); await expect(tips).toBeFocused();
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  expect(await starts(page)).toBe(0);
});
test('extensions provider catalog: switching between a package harness and the new built-ins keeps each identity, and an unavailable package recovers by switching', async ({ page }) => {
  // Four picker round trips, three recorded turns and a recovery: longer than the default budget in WebKit.
  test.setTimeout(60_000);
  await seed(page, [harness()]);
  const recovery = page.locator('[data-provider-recovery]');
  for (const [query, option, provider, model] of [
    ['recorded model', 'Recorded harness · Recorded model', 'sample.fake-harness/recorded', 'recorded-model'],
    ['qwen3.8-max', qwenMax, 'alibaba', 'qwen3.8-max'],
    ['composer 2.5', 'Cursor CLI · Composer 2.5', 'cursor', 'composer-2.5'],
    ['recorded model', 'Recorded harness · Recorded model', 'sample.fake-harness/recorded', 'recorded-model'],
  ] as [string, Row, string, string][]) {
    await choose(page, query, option);
    await expect.poll(async () => { const current = await task(page); return `${current.provider}:${current.model}`; }).toBe(`${provider}:${model}`);
    // The roster knows the identity: the reopened picker marks its row current and no recovery is shown.
    await page.locator('#model-picker-trigger').click();
    await expect(rowOf(page, option)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    if (await recovery.count()) await expect(recovery).toBeHidden();
  }
  // Two sends on the package resume its conversation; a built-in round trip hands off (upstream's switch clears the
  // resume ID), so the next send starts the recorded conversation afresh.
  for (let turn = 0; turn < 3; turn++) {
    if (turn === 2) { await choose(page, 'qwen3.8-max', qwenMax);await choose(page, 'recorded model', 'Recorded harness · Recorded model'); }
    if (turn !== 1) {
      await page.locator('#model-picker-trigger').click();
      await pickerOf(page).getByRole('radio', { name: 'medium', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await page.locator('#prompt').fill(`Recorded turn ${turn}`); await page.locator('#prompt').press('Enter');
    const approval = page.getByRole('region', { name: 'Approval needed', exact: true });
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    const input = page.locator('.agent-input'); await expect(input).toContainText('Which recorded result?');
    await input.getByRole('radio', { name: 'Finish Complete this recording', exact: true }).check();
    await input.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect.poll(async () => (await task(page)).status).toBe('idle');
  }
  const history = await page.evaluate(() => (window as any).__extensionHarness.messages());
  const recorded = history.filter((message: any) => message.role === 'assistant' && /^(Started|Resumed) recorded harness/.test(message.content));
  expect(recorded.map((message: any) => message.content.split('. ')[0])).toEqual(['Started recorded harness', 'Resumed recorded harness', 'Started recorded harness']);
  expect(history.some((message: any) => message.role === 'handoff' && JSON.parse(message.content).toProvider === 'sample.fake-harness/recorded')).toBe(true);
  expect(await starts(page)).toBe(3);
  // The package goes away: recovery, never an unknown identity; Change provider moves the task to a new built-in.
  await page.evaluate(() => (window as any).__extensionHarness.call('extensions_enable', { id: 'sample.fake-harness', enabled: false }));
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText('History is preserved');
  await recovery.getByRole('button', { name: 'Change provider', exact: true }).click();
  const picker = pickerOf(page);
  await picker.getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill('composer 2.5');
  await picker.getByRole('option', { name: 'Cursor CLI · Composer 2.5', exact: true }).click();
  await expect.poll(async () => (await task(page)).provider).toBe('cursor');
  await expect(recovery).toBeHidden();
  expect(await starts(page)).toBe(3);
});
