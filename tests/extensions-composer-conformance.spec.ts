import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/composer/extension.json', import.meta.url), 'utf8'));
const field = (page: Page) => page.locator('#prompt');
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function open(page: Page, alternate = false) {
  await page.addInitScript(() => { (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true }; });
  await page.goto('/?extensions-baseline&replacement&composer-conformance');
  await expect(field(page)).toBeEnabled();
  if (alternate) {
    await page.keyboard.press('ControlOrMeta+,');
    await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Install local package', exact: true }).click();
    await page.getByRole('button', { name: 'Enable sample.composer', exact: true }).click();
    await page.getByLabel('Composer presentation', { exact: true }).selectOption('sample.composer/toolbar');
    await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', 'sample.composer/toolbar');
  }
}
for (const alternate of [false, true]) {
  test(`extensions composer: ${alternate ? 'installed alternate' : 'built-in'} E19 input, IME, undo, attachments, model/mode, queue, steer, send and stop`, async ({ page }) => {
    await open(page, alternate);
    await field(page).pressSequentially('Undo probe');
    await field(page).press('ControlOrMeta+z'); await expect(field(page)).not.toHaveValue('Undo probe');
    await field(page).press('ControlOrMeta+Shift+z'); await expect(field(page)).toHaveValue('Undo probe');
    await field(page).dispatchEvent('compositionstart');
    await field(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await field(page).dispatchEvent('compositionend', { data: '語' });
    await field(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
    expect(await calls(page, 'send_message')).toEqual([]);
    await page.locator('#model-picker-trigger').click();
    await page.getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
    await expect(page.locator('#model-picker-trigger')).toContainText('Opus');
    await page.locator('#mode-picker-trigger').click();
    await page.getByRole('menuitemradio', { name: 'Plan mode', exact: true }).click();
    await expect(page.locator('#mode-picker-trigger')).toContainText('Plan mode');
    const tray = (await page.locator('#composer > .composer-tray').boundingBox())!;
    const input = (await page.locator('#composer > .composer-input').boundingBox())!;
    expect(tray.y < input.y).toBe(alternate);
    await page.getByRole('button', { name: 'Attach files for context' }).click();
    await page.getByRole('menuitem', { name: /Attach files…/ }).click();
    await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
    await field(page).fill('Start once'); await field(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await expect(page.locator('#attachments .prompt-chip')).toHaveCount(0);
    expect((await calls(page, 'send_message')).length).toBe(1);
    await field(page).fill('Queued follow-up'); await field(page).press('Enter');
    await expect(page.locator('.queue-text')).toHaveText(['Queued follow-up']);
    await field(page).fill('Steer this turn'); await page.getByRole('button', { name: 'Steer the running turn', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'steer_task')).length).toBe(1);
    await expect(page.locator('.queue-text')).toHaveText(['Queued follow-up']);
    await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'approval', requestId: 'composer-approval', text: 'Run npm test?' }));
    await expect(page.locator('#composer-area .approval-bar')).toBeVisible();
    await expect(page.locator('#approval-bar')).toContainText('Run npm test');
    expect(await calls(page, 'respond_approval')).toEqual([]);
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'stop_session')).length).toBe(1);
    expect((await calls(page, 'send_message')).length).toBe(1);
  });
}
for (const running of [false, true]) for (const recovery of ['failure', 'disable', 'safe-mode', 'built-in']) {
  test(`extensions composer: ${recovery} while ${running ? 'streaming' : 'typing'} preserves draft undo attachments queue and input identity`, async ({ page }) => {
    await open(page, true);
    if (running) {
      await field(page).fill('Start once'); await field(page).press('Enter');
      await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
      await field(page).fill('Keep queued'); await field(page).press('Enter');
      await expect(page.locator('.queue-text')).toHaveText(['Keep queued']);
    }
    await page.getByRole('button', { name: 'Attach files for context' }).click();
    await page.getByRole('menuitem', { name: /Attach files…/ }).click();
    await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
    await field(page).pressSequentially('Surviving draft');
    const node = await field(page).elementHandle();
    const ids = await page.locator('#attachments .prompt-chip').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-attachment-id')));
    await page.evaluate(async recovery => {
      const api = await (window as any).__previewReplacementModules();
      if (recovery === 'failure') api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled composer failure'); });
      else if (recovery === 'disable') await (window as any).__previewDisableExtension('sample.composer');
      else if (recovery === 'safe-mode') await (await (window as any).__previewComposerModules()).enterExtensionsSafeMode();
      else api.selectComponent('panda.composer');
    }, recovery);
    await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
    expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
    await expect(field(page)).toHaveValue('Surviving draft');
    await field(page).press('ControlOrMeta+z'); await expect(field(page)).not.toHaveValue('Surviving draft');
    await field(page).press('ControlOrMeta+Shift+z'); await expect(field(page)).toHaveValue('Surviving draft');
    expect(await page.locator('#attachments .prompt-chip').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-attachment-id')))).toEqual(ids);
    if (running) {
      await expect(page.locator('.queue-text')).toHaveText(['Keep queued']);
      await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'text', text: 'Still streaming after recovery' }));
      await expect(page.locator('#transcript')).toContainText('Still streaming after recovery');
      await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    }
    expect((await calls(page, 'send_message')).length).toBe(running ? 1 : 0);
    expect(await calls(page, 'stop_session')).toEqual([]);
  });
}
test('extensions composer: incompatible capabilities/version cannot select; presentation has no task or approval dispatch', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async manifest => {
    const { createComponentSelection, componentIncompatibility } = await (window as any).__previewComposerModules();
    const provider = manifest.contributes.components[0]; const selection = createComponentSelection(localStorage);
    const invalid = [{ ...provider, contractVersion: 2 }, { ...provider, capabilities: [] }, { ...provider, capabilities: [...provider.capabilities, 'approve'] }];
    return invalid.map(provider => { let rejected = false; try { selection.select('panda.composer', provider.id, [provider]); } catch { rejected = true; } return { rejected, reason: componentIncompatibility(provider), resolved: Boolean(selection.resolve('panda.composer', [provider])) }; });
  }, manifest);
  expect(result.every(item => item.rejected && item.reason && !item.resolved)).toBe(true);
  expect(result.map(item => item.reason)).toEqual(['Incompatible slot version', 'Missing required composer capabilities', 'Unsupported composer capability']);
  expect(await calls(page, 'respond_approval')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
});
test('extensions composer: incompatible providers explain disabled selection and retain Built-in', async ({ page }) => {
  await page.addInitScript(manifest => {
    const packages = ['future', 'missing', 'forged'].map(kind => {
      const copy = structuredClone(manifest); copy.id = `sample.${kind}`;
      const provider = copy.contributes.components[0]; provider.id = `${copy.id}/toolbar`;
      if (kind === 'future') provider.contractVersion = 2;
      if (kind === 'missing') provider.capabilities = [];
      if (kind === 'forged') provider.capabilities.push('approve');
      return { manifest: copy, enabled: true, icons: {} };
    });
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    localStorage.setItem('pandacode.components.v1', JSON.stringify({ schemaVersion: 1, selected: { 'panda.composer': 'sample.future/toolbar' } }));
  }, manifest);
  await page.goto('/?extensions-baseline&replacement&composer-conformance');
  await expect(field(page)).toBeEnabled(); await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  const select = page.getByLabel('Composer presentation', { exact: true });
  for (const [id, reason] of [['future', 'Incompatible slot version'], ['missing', 'Missing required composer capabilities'], ['forged', 'Unsupported composer capability']]) {
    const option = select.locator(`option[value="sample.${id}/toolbar"]`);
    await expect(option).toHaveAttribute('disabled', ''); await expect(option).toContainText(reason);
  }
  expect(await calls(page, 'respond_approval')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
});
