import { test, expect } from '@playwright/test';

for (const lifecycle of ['disabled', 'uninstalled', 'safe-mode']) test(`extensions provider history: ${lifecycle} retains readable history, identifiers and keyboard recovery`, async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    // Installation metadata only: no executable/provider registration is fabricated.
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest: { manifestVersion: 1, id: 'sample.harness', version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui', permissions: [], contributes: {} }, enabled: true, icons: {} }]));
  });
  await page.goto('/?extensions-baseline&provider-history');
  const notice = page.locator('[data-provider-recovery]');
  await expect(notice).toBeVisible();
  const before = await page.evaluate(() => (window as any).__providerHistory.state());
  const transcript = page.locator('#transcript');
  await expect(transcript).toContainText(before.messages.find((row: any) => row.role === 'user').content);
  await page.evaluate(async lifecycle => {
    const api = (window as any).__providerHistory;
    if (lifecycle === 'safe-mode') await api.call('extensions_safe_mode', {});
    else if (lifecycle === 'disabled') await api.call('extensions_enable', { id: 'sample.harness', enabled: false });
    else await api.call('extensions_uninstall', { id: 'sample.harness' });
  }, lifecycle);
  expect(await page.evaluate(() => (window as any).__providerHistory.state())).toEqual(before);
  await notice.getByRole('button', { name: 'Reinstall or enable extension' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Extensions', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await notice.getByRole('button', { name: 'Change provider', exact: true }).focus(); await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker).toBeVisible(); await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).__providerHistory.state())).toEqual(before);
  // Failed sends neither append a prompt nor consume the saved native resume identifier.
  const error = await page.evaluate(async () => { try { await (window as any).__providerHistory.call('send_message', { sessionId: 'session-1', text: 'Do not lose this draft' }); } catch (error) { return String(error); } });
  expect(error).toContain('History is preserved');
  expect(await page.evaluate(() => (window as any).__providerHistory.state())).toEqual(before);
  await notice.getByRole('button', { name: 'Change provider', exact: true }).click();
  await picker.getByRole('tab', { name: 'Codex', exact: true }).click();
  await picker.getByRole('option', { name: 'Codex · Default', exact: true }).click();
  await expect(notice).toBeHidden();
  const after = await page.evaluate(() => (window as any).__providerHistory.state());
  expect(after.task.id).toBe(before.task.id); expect(after.task.projectId).toBe(before.task.projectId);
  expect(after.task.provider).toBe('codex'); expect(after.task.resumeId).toBeNull();
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages.at(-1).role).toBe('handoff');
  const newTask = await page.evaluate(() => (window as any).__providerHistory.call('create_session', { projectId: 'project-1', provider: 'claude', model: 'sonnet', mode: 'full' }));
  expect(newTask.provider).toBe('claude');
});
