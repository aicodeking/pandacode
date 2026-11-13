import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/transcript/extension.json', import.meta.url), 'utf8'));
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const frame = (page: Page, event: Record<string, unknown>) => page.evaluate(event => (window as any).__previewTranscriptFrame({ sessionId: 'session-1', text: '', ...event }), event);
async function open(page: Page, alternate = true, permissions = manifest.permissions) {
  await page.addInitScript(({ manifest, alternate, permissions }) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    const copy = structuredClone(manifest); copy.permissions = permissions;
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest: copy, enabled: true, icons: {} }]));
    if (alternate) localStorage.setItem('pandacode.components.v1', JSON.stringify({ schemaVersion: 1, selected: { 'panda.transcript': 'sample.transcript/timeline' } }));
  }, { manifest, alternate, permissions });
  await page.goto('/?extensions-baseline&replacement&transcript-conformance');
  await expect(page.locator('#prompt')).toBeEnabled();
  if (alternate && permissions.length === 3) await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', 'sample.transcript/timeline');
}
async function start(page: Page) {
  await page.locator('#prompt').fill('Recorded transcript run'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
}
for (const alternate of [false, true]) test(`extensions transcript: ${alternate ? 'alternate' : 'built-in'} normalized streaming tools questions approve/reject usage stop/resume and completion`, async ({ page }) => {
  await open(page, alternate); await start(page);
  await frame(page, { kind: 'text', text: 'Recorded streaming answer. ' });
  await expect(page.locator('#transcript')).toContainText('Recorded streaming answer.');
  await frame(page, { kind: 'tool', tool: { id: 'recorded-tool', name: 'Bash', status: 'completed', input: '{"command":"npm test"}', output: 'RECORDED OUTPUT: 12 passed' } });
  const trace = page.locator('#stream-region details.turn-activity');
  await trace.evaluate((node: HTMLDetailsElement) => { node.open = true; });
  await expect(page.locator('#stream-region')).toContainText('npm test');
  const tool = page.locator('#stream-region details[data-tool-key]');
  await expect(tool).toHaveCount(1);
  await tool.evaluate((node: HTMLDetailsElement) => { node.open = false; });
  await tool.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  await expect(tool.locator('.tool-activity-body')).toBeVisible();
  await expect(tool.locator('.tool-activity-body')).toContainText('RECORDED OUTPUT: 12 passed');
  await frame(page, { kind: 'input_request', requestId: 'recorded-question', data: { kind: 'questions', questions: [{ id: 'theme', header: 'Theme', question: 'Which theme?', options: [{ label: 'Sky', description: 'Calm' }], isOther: true }] } });
  await page.locator('.agent-input').getByRole('radio', { name: 'Sky Calm' }).check();
  await page.locator('.agent-input').getByRole('button', { name: 'Submit answers' }).click();
  expect((await calls(page, 'respond_user_input')).map((call: any) => call.args)).toEqual([{ sessionId: 'session-1', requestId: 'recorded-question', response: { answers: { theme: ['Sky'] } } }]);
  for (const approved of [true, false]) {
    await frame(page, { kind: 'approval', requestId: `recorded-${approved}`, text: 'Run recorded command?' });
    await page.locator('#approval-bar').getByRole('button', { name: approved ? 'Approve' : 'Deny', exact: true }).click();
    await expect(page.locator('#approval-bar .approval-bar')).toHaveCount(0);
  }
  expect((await calls(page, 'respond_approval')).map((call: any) => call.args.approved)).toEqual([true, false]);
  await frame(page, { kind: 'usage', data: { usedTokens: 12345, contextWindow: 200000 } });
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'stop_session')).length).toBe(1);
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#prompt').fill('Resume recorded task'); await page.locator('#prompt').press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(2);
  await frame(page, { kind: 'text', text: 'Final recorded reply.' });
  await frame(page, { kind: 'done' });
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  await expect(page.locator('#transcript')).toContainText('Final recorded reply.');
  const saved = await page.evaluate(() => (window as any).__previewTranscriptState());
  expect(saved.task.resumeId).toBe('preview-session');
  expect(saved.messages.filter((row: any) => row.role === 'assistant' && row.content.includes('Final recorded reply.'))).toHaveLength(1);
  expect((await calls(page, 'send_message')).length).toBe(2);
  await page.locator('#prompt').fill('/status');
  await page.getByRole('option', { name: /\/status/ }).click();
  await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('dialog')).toContainText('12,345 of 200,000 context tokens');
  await page.keyboard.press('Escape');
});
test('extensions transcript: alternate retains normalized team progress and host worker actions', async ({ page }) => {
  await open(page); await start(page);
  await page.evaluate(() => {
    const worker = { id: 'recorded-worker', name: 'Recorded reviewer', provider: 'claude', model: 'sonnet', sessionId: 'recorded-worker-session', profileId: 'recorded-worker', status: 'running', assignment: 'Review transcript', summary: '', dependsOn: [], files: [], attempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    (window as any).__previewEmit('architect-event', { sessionId: 'session-1', status: 'running', round: 1, revision: 1, workers: [worker], config: { workers: [worker], maxParallel: 1, maxRounds: 1, maxAssignments: 1, workspace: 'shared', summaryLimit: 1000 }, updatedAt: Date.now() });
  });
  await expect(page.getByRole('region', { name: 'Team progress' })).toBeVisible();
  await page.locator('.team-progress-toggle').click();
  await expect(page.locator('.team-progress')).toContainText('Recorded reviewer');
  await page.locator('.team-progress').getByRole('button', { name: 'Open team', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#agents-flyout')).toBeVisible();
  expect(await calls(page, 'send_message')).toHaveLength(1);
});
for (const recovery of ['built-in', 'failure', 'disable', 'safe-mode', 'uninstall', 'revoke-transcript', 'revoke-tools']) test(`extensions transcript: ${recovery} mid-stream retains nodes IDs scroll selection resume and single completion`, async ({ page }) => {
  await open(page); await start(page);
  await frame(page, { kind: 'text', text: 'Selection continuity probe' });
  await expect(page.locator('#stream-region .live-text')).toContainText('Selection continuity probe');
  const savedBefore = await page.evaluate(() => (window as any).__previewTranscriptState());
  const retained = await page.locator('#stream-region .live-text').elementHandle();
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#transcript')!;
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); host.scrollTop = (host.scrollHeight - host.clientHeight) / 2;
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#stream-region .live-text')!);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  const before = await page.locator('#transcript').evaluate(host => ({ top: host.scrollTop, selection: getSelection()?.toString() }));
  expect(before.top).toBeGreaterThan(0); expect(before.selection).toContain('Selection continuity probe');
  await page.evaluate(async recovery => {
    const api = await (window as any).__previewReplacementModules();
    const manager = await (window as any).__previewTranscriptModules();
    if (recovery === 'failure') api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('controlled transcript failure'); });
    else if (recovery === 'disable') await manager.enableExtension('sample.transcript', false);
    else if (recovery === 'safe-mode') await manager.enterExtensionsSafeMode();
    else if (recovery === 'uninstall') await manager.uninstallExtension('sample.transcript');
    else if (recovery.startsWith('revoke-')) {
      const packages = JSON.parse(localStorage.getItem('pandacode.preview.extensions.v1')!);
      packages[0].manifest.permissions = packages[0].manifest.permissions.filter((permission: string) => permission !== (recovery === 'revoke-transcript' ? 'tasks.transcript.read' : 'tasks.tools.read'));
      localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages)); await manager.loadExtensions();
    }
    else api.selectComponent('panda.transcript');
  }, recovery);
  await expect(page.locator('#transcript')).not.toHaveAttribute('data-component-provider');
  expect(await retained!.evaluate(node => node === document.querySelector('#stream-region .live-text'))).toBe(true);
  expect(await page.locator('#transcript').evaluate(host => ({ top: host.scrollTop, selection: getSelection()?.toString() }))).toEqual(before);
  expect(await page.evaluate(() => (window as any).__previewTranscriptState())).toEqual(savedBefore);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await frame(page, { kind: 'text', text: ' Continued after recovery.' });
  await frame(page, { kind: 'done' });
  await expect(page.locator('#transcript')).toContainText('Continued after recovery.');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  const after = await page.evaluate(() => (window as any).__previewTranscriptState());
  expect(after.task.resumeId).toBe(savedBefore.task.resumeId);
  expect(after.messages.slice(0, savedBefore.messages.length).map((row: any) => row.id)).toEqual(savedBefore.messages.map((row: any) => row.id));
  expect(after.messages.filter((row: any) => row.role === 'assistant' && row.content.includes('Continued after recovery.'))).toHaveLength(1);
  expect((await calls(page, 'send_message')).length).toBe(1); expect(await calls(page, 'stop_session')).toEqual([]);
});
for (const missing of ['tasks.transcript.read', 'tasks.tools.read']) test(`extensions transcript: registration without ${missing} is explicit redacted fallback, required actions survive`, async ({ page }) => {
  await open(page, true, manifest.permissions.filter((permission: string) => permission !== missing));
  await expect(page.locator('#transcript')).not.toHaveAttribute('data-component-provider');
  await expect(page.locator('[data-transcript-presentation-status]')).toContainText(`content redacted (${missing} not granted)`);
  await start(page);
  await frame(page, { kind: 'approval', requestId: 'fallback-approval', text: 'Required host approval' });
  await expect(page.locator('#approval-bar').getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  expect(await calls(page, 'extensions_execute')).toEqual([]);
});
test('extensions transcript: explicit selector, version/capability rejection and no list action protocol', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true }; });
  await page.goto('/?extensions-baseline&replacement&transcript-conformance'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.transcript', exact: true }).click();
  await page.getByLabel('Transcript presentation', { exact: true }).selectOption('sample.transcript/timeline');
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', 'sample.transcript/timeline');
  const result = await page.evaluate(async manifest => {
    const api = await (window as any).__previewTranscriptModules(); const provider = manifest.contributes.components[0];
    return { valid: api.validateContract('packages', [manifest]).ok,
      reasons: [{ ...provider, contractVersion: 2 }, { ...provider, capabilities: [] }, { ...provider, capabilities: [...provider.capabilities, 'approve'] }].map(provider => api.componentIncompatibility(provider)),
      malformedSlotAccepted: api.validSlotProps({ slot: { toString() { throw Error('Must not coerce untrusted values'); } } }),
      listAccepted: api.validSlotProps({ contractVersion: 1, slot: 'panda.transcript', context: '', revision: 0, objects: [], state: { selected: '', focused: '', visible: true, offline: false, loading: false } }) };
  }, manifest);
  expect(result).toEqual({ valid: true, reasons: ['Incompatible slot version', 'Missing required transcript capabilities', 'Unsupported transcript capability'], listAccepted: false, malformedSlotAccepted: false });
  expect(await calls(page, 'respond_approval')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
});
