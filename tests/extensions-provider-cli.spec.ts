import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
const provider = 'sample.fake-harness/recorded';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }])), manifest);
});

test('extensions CLI: package slash controls retain literal arguments; console/native commands refuse explicitly', async ({ page }) => {
  await page.goto('/?extension-harness');
  await expect(page.locator('#prompt')).toBeEnabled();
  const result = await page.evaluate(async provider => {
    const api = (window as any).__extensionHarness;
    const task = await api.call('create_session', { projectId: api.task().projectId, provider, model: 'recorded-model', mode: 'ask' });
    const errors: string[] = [];
    for (const [command, args] of [
      ['resolve_slash_command', { sessionId: task.id, text: '/console /exit' }],
      ['resolve_slash_command', { sessionId: task.id, text: '/compact' }],
      ['start_harness_terminal', { sessionId: task.id, cols: 80, rows: 24 }],
    ] as const) { try { await api.call(command, args); } catch (reason) { errors.push(String(reason)); } }
    return { errors, catalog: await api.call('list_slash_commands', { sessionId: task.id }), rename: await api.call('resolve_slash_command', { sessionId: task.id, text: '/rename literal; $(no-shell)  spacing' }), task };
  }, provider);
  expect(result.errors).toHaveLength(3);
  expect(result.errors.every(reason => reason.includes('UnsupportedCapability'))).toBe(true);
  expect(result.catalog.commands.find((value: { name: string }) => value.name === '/console')).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('core-managed') });
  expect(result.catalog.warnings[0]).toContain('extension-native');
  expect(result.rename).toEqual({ action: 'rename', arguments: 'literal; $(no-shell)  spacing' });
  expect(result.task.provider).toBe(provider);
});

test('extensions CLI: launcher package selection persists and disable keeps selection/history with recovery', async ({ page }) => {
  await page.goto('/?view=launcher&extension-harness');
  await expect(page.locator('textarea')).toBeVisible();
  await page.getByRole('button', { name: 'Choose harness and model' }).click();
  await expect(page.getByRole('tab', { name: 'Recorded harness', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const selected = await page.evaluate(async provider => {
    const overlayCall = (window as any).__extensionLauncher;
    await overlayCall('overlay_sync_context', { context: { projectId: 'preview-project', provider, model: 'recorded-model', mode: 'ask' } });
    await overlayCall('overlay_select_model', { provider, model: 'recorded-model', reasoningEffort: 'medium' });
    const id = await overlayCall('overlay_launch', { prompt: 'literal; $(no-shell)\nkeep spacing', projectId: 'preview-project' });
    return { id, snapshot: await overlayCall('overlay_snapshot') };
  }, provider);
  expect(selected.snapshot.context).toMatchObject({ provider, model: 'recorded-model', mode: 'ask' });
  expect(selected.snapshot.tasks.find((task: { id: string }) => task.id === selected.id)).toMatchObject({ provider, title: 'literal; $(no-shell)\nkeep spacing' });
  await page.reload();
  await expect(page.locator('textarea')).toBeVisible();
  const disabled = await page.evaluate(async () => {
    const overlayCall = (window as any).__extensionLauncher;
    const packages = JSON.parse(localStorage.getItem('pandacode.preview.extensions.v1')!); packages[0].enabled = false;
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    let error = ''; try { await overlayCall('overlay_launch', { prompt: 'Do not fall back' }); } catch (reason) { error = String(reason); }
    return { error, preferences: await overlayCall('overlay_preferences') };
  });
  expect(disabled.error).toContain('History is preserved');
  expect(disabled.preferences.modelSelection.provider).toBe(provider);
});
