import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
const selection = { provider: 'sample.fake-harness/recorded', model: 'recorded-model', reasoningEffort: 'medium' };
const config = { workers: [{ id: 'recorded', name: 'Recorded worker', ...selection }], maxParallel: 1, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072 };

test('extensions teams: opted-in provider keeps identity and user pause/resume/stop coordination', async ({ page }) => {
  await page.addInitScript(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }])), manifest);
  await page.goto('/?extension-harness');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
  await expect(page.getByRole('tab', { name: 'Recorded harness', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const result = await page.evaluate(async ({ selection, config }) => {
    const api = (window as any).__extensionHarness;
    const source = api.task();
    const task = await api.call('create_session', { projectId: source.projectId, provider: selection.provider, model: selection.model, mode: 'ask' });
    const ready = await api.call('architect_configure', { sessionId: task.id, config, architect: selection });
    await api.call('architect_start', { sessionId: task.id, text: 'Coordinate the recorded workers.' });
    const paused = await api.call('architect_control', { sessionId: task.id, action: 'pause' });
    const resumed = await api.call('architect_control', { sessionId: task.id, action: 'resume' });
    const stopped = await api.call('architect_control', { sessionId: task.id, action: 'stop' });
    const sessions = await api.call('list_sessions', {});
    return { ready, paused, resumed, stopped, task: sessions.find((value: { id: string }) => value.id === task.id) };
  }, { selection, config });
  expect(result.ready.config.maxParallel).toBe(1);
  expect(result.paused.status).toBe('paused');
  expect(result.resumed.status).toBe('running');
  expect(result.stopped.workers).toHaveLength(1);
  expect(result.stopped.workers[0]).toMatchObject({ provider: selection.provider, model: selection.model, status: 'stopped' });
  expect(result.task).toMatchObject({ provider: selection.provider, model: selection.model });
});

for (const teams of [false, undefined]) test(`extensions teams: ${teams === false ? 'disabled' : 'unadvertised'} capability refuses without changing provider`, async ({ page }) => {
  const unsupported = structuredClone(manifest);
  if (teams === undefined) delete unsupported.contributes.providers[0].metadata.teams;
  else unsupported.contributes.providers[0].metadata.teams = teams;
  await page.addInitScript(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }])), unsupported);
  await page.goto('/?extension-harness'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#model-picker-trigger').click();
  await expect(page.getByRole('tab', { name: 'Recorded harness', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const result = await page.evaluate(async ({ selection, config }) => {
    const api = (window as any).__extensionHarness;
    const original = api.task();
    let error = '';
    try { await api.call('architect_configure', { sessionId: original.id, config, architect: selection }); }
    catch (reason) { error = String(reason); }
    return { error, original, current: api.task(), team: await api.call('architect_get', { sessionId: original.id }) };
  }, { selection, config });
  expect(result.error).toContain('UnsupportedCapability');
  expect(result.current.provider).toBe(result.original.provider);
  expect(result.team).toBeNull();
});
