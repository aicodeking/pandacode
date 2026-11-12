import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/thread-laboratory/extension.json', import.meta.url), 'utf8'));
const prompt = (page: Page) => page.locator('#prompt');
const contributed = (page: Page, id: string) => page.locator(`[data-extension-contribution="sample.thread-laboratory/${id}"]`).first();
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((entry: any) => entry.command === command), command);
async function setup(page: Page, mode = 'active', packageManifest = manifest) {
  await page.addInitScript(({ mode, manifest }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(mode === 'zero' ? [] : [{ manifest, enabled: true, icons: {} }]));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, { mode, manifest: packageManifest });
  await page.goto('/?extensions-baseline');
  await expect(prompt(page)).toBeEnabled();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
  if (mode === 'disabled') await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); });
}
async function emit(page: Page, kind: string, text = '', extra = {}) {
  await page.evaluate(event => (window as any).__extensionsBaseline.emitAgent(event), { sessionId: 'session-1', kind, text, ...extra });
}
async function showTeam(page: Page) {
  await page.evaluate(() => {
    const time = Date.now(), profile = { id: 'builder', name: 'Builder', provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
    (window as any).__previewEmit('architect-event', {
      sessionId: 'session-1', status: 'running', round: 1, revision: 1, updatedAt: time,
      config: { workers: [profile], maxParallel: 1, maxRounds: 4, maxAssignments: 8, workspace: 'shared', summaryLimit: 1800 },
      workers: [{ ...profile, id: 'worker-1', profileId: 'builder', sessionId: 'worker-session', status: 'running', assignment: 'Synthetic verification', summary: '', dependsOn: [], files: [], attempt: 1, createdAt: time, updatedAt: time }],
    });
  });
  await expect(page.locator('.team-progress')).toBeVisible();
}

for (const menu of manifest.contributes.menus) test(`extensions thread actions: installable ${menu.location} renders declared presentation and captures only IDs`, async ({ page }) => {
  await setup(page);
  if (menu.id.endsWith('/team')) await showTeam(page);
  if (menu.id.endsWith('/agents')) {
    await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'child', name: 'Child', status: 'running' }));
    await page.locator('#agents-toggle').click();
  }
  const trigger = page.locator(`[data-extension-contribution="${menu.id}"]`).first();
  if (menu.id.endsWith('/message')) await trigger.locator('..').hover();
  await expect(trigger).toBeVisible(); await expect(trigger.locator('svg rect')).toHaveCount(1);
  if (menu.presentation === 'status' || menu.presentation === 'badge') {
    await expect(trigger).toHaveText(menu.text); expect(await trigger.evaluate(node => node.tagName)).toBe('SPAN');
    expect(await trigger.evaluate(node => (node as HTMLElement).tabIndex)).toBe(-1);
  } else if (menu.items) {
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Choose action tags', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Action tags', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
    const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
    expect(recorded[0].context).toMatchObject({ surfaceId: menu.location, projectId: 'project-1', sessionId: 'session-1' });
    if (menu.id.endsWith('/message')) expect(recorded[0].context.selection).toMatchObject({ kind: 'message' });
    if (menu.id.endsWith('/team')) expect(recorded[0].context.selection).toEqual({ kind: 'team', ids: ['session-1'] });
    expect(JSON.stringify(recorded[0].context)).not.toMatch(/content|draft|secret|Synthetic verification/);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
  } else {
    await expect(trigger.locator('.extension-action-badge')).toHaveText('3');
    await trigger.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#toast')).toHaveText('Extension note only — no task control');
  }
  expect(await calls(page, 'send_message')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
});

for (const mode of ['zero', 'active', 'disabled']) test(`extensions thread actions: ${mode} packages preserve queue, stream, approval/question and authorized stop`, async ({ page }) => {
  await setup(page, mode);
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await emit(page, 'text', 'A live synthetic reply.'); await emit(page, 'tool', 'Read README');
  await expect(page.locator('#stream-region')).toContainText('A live synthetic reply.');
  if (mode === 'active') {
    const liveAction = page.locator('#stream-region [data-extension-contribution="sample.thread-laboratory/message"]');
    await expect(liveAction).toHaveCount(1); const node = await liveAction.elementHandle();
    await emit(page, 'text', ' More tokens.');
    expect(await node!.evaluate(node => node === document.querySelector('#stream-region [data-extension-contribution="sample.thread-laboratory/message"]'))).toBe(true);
  }
  await prompt(page).fill('Queue this follow-up'); await prompt(page).press('Enter');
  await expect(page.locator('.queue-row .queue-text')).toHaveText('Queue this follow-up');
  await emit(page, 'approval', 'Run fixture verification?', { requestId: 'fixture-approval' });
  await expect(page.locator('.approval-bar')).toBeVisible();
  if (mode === 'active') { await contributed(page, 'composer').click(); await expect(page.locator('#toast')).toContainText('no task control'); }
  else await expect(contributed(page, 'composer')).toHaveCount(0);
  expect(await calls(page, 'respond_approval')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
  await page.locator('.approval-bar .approval-allow').click();
  await expect.poll(() => calls(page, 'respond_approval')).toHaveLength(1);
  await emit(page, 'input_request', '', { requestId: 'fixture-question', data: { kind: 'questions', questions: [{ id: 'decision', header: 'Decision', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue the fixture' }], isOther: true }] } });
  await expect(page.locator('.agent-input')).toBeVisible();
  if (mode === 'active') await contributed(page, 'composer').click();
  expect(await calls(page, 'respond_user_input')).toEqual([]);
  await page.locator('.agent-input').getByRole('radio', { name: 'Yes Continue the fixture' }).check();
  await page.getByRole('button', { name: 'Submit answers', exact: true }).click();
  expect((await calls(page, 'respond_user_input'))[0].args).toMatchObject({ sessionId: 'session-1', requestId: 'fixture-question', response: { answers: { decision: ['Yes'] } } });
  if (mode === 'active') {
    await prompt(page).fill('Draft during unload'); await prompt(page).focus();
    await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); });
    await expect(prompt(page)).toHaveValue('Draft during unload'); await expect(prompt(page)).toBeFocused();
    await expect(contributed(page, 'composer')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect.poll(() => calls(page, 'stop_session')).toHaveLength(1);
  await expect(page.locator('.queue-row .queue-text')).toHaveText('Queue this follow-up');
  expect((await calls(page, 'send_message')).length).toBe(1);
});

test('extensions thread actions: activation and disable preserve prompt focus, caret, undo, attachments and IME submit guards', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  await page.getByRole('menuitem', { name: /Attach files…/ }).click();
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
  await prompt(page).pressSequentially('Draft kept'); const original = await prompt(page).elementHandle();
  await prompt(page).evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 5));
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); });
  await expect(prompt(page)).toBeFocused(); await expect(prompt(page)).toHaveValue('Draft kept');
  expect(await original!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await prompt(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 5]);
  await prompt(page).press('ControlOrMeta+z'); await expect(prompt(page)).toHaveValue('');
  await prompt(page).press('ControlOrMeta+Shift+z'); await expect(prompt(page)).toHaveValue('Draft kept');
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
  await prompt(page).evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
  });
  expect(await calls(page, 'send_message')).toEqual([]);
  await prompt(page).press('Enter'); await expect.poll(() => calls(page, 'send_message')).toHaveLength(1);
});

test('extensions thread actions: source removal aborts pending select without retargeting navigation', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await contributed(page, 'tray').click(); await page.getByRole('menuitem', { name: 'Choose action tags', exact: true }).click();
  await page.getByRole('button', { name: 'Action tags', exact: true }).click();
  await expect(page.getByText('Loading options…', { exact: true })).toBeVisible();
  await page.locator('.task-item[data-id="session-2"]').evaluate((node: HTMLElement) => node.click());
  await expect(page.locator('#dialog')).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__extensionDialogTransport.calls[0].context.sessionId)).toBe('session-1');
  expect(await page.evaluate(() => (window as any).__extensionDialogTransport.calls[0].aborted)).toBe(true);
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body && !(document.activeElement as HTMLElement).dataset.extensionContribution)).toBe(true);
});

test('extensions thread actions: disable aborts pending options and restores surviving prompt focus', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await contributed(page, 'tray').click(); await page.getByRole('menuitem', { name: 'Choose action tags', exact: true }).click();
  await page.getByRole('button', { name: 'Action tags', exact: true }).click();
  await expect(page.getByText('Loading options…', { exact: true })).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.locator('#dialog')).not.toBeVisible(); await expect(prompt(page)).toBeFocused();
  expect(await page.evaluate(() => (window as any).__extensionDialogTransport.calls[0].aborted)).toBe(true);
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toHaveCount(0);
});

test('extensions thread actions: conflicting packages and denied task commands fail closed without disabling the host', async ({ page }) => {
  const invalid = structuredClone(manifest); invalid.contributes.commands[0].action = { kind: 'stop_session', sessionId: 'session-1' };
  await setup(page, 'active', invalid);
  await expect(contributed(page, 'composer')).toHaveCount(0);
  await prompt(page).fill('Host remains available'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  expect(await calls(page, 'stop_session')).toEqual([]);
  await page.evaluate(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }, { manifest, enabled: true, icons: {} }])); }, manifest);
  await page.reload(); await expect(prompt(page)).toBeEnabled();
  await expect(contributed(page, 'composer')).toHaveCount(0);
  expect(await calls(page, 'stop_session')).toEqual([]);
});

test('extensions thread actions: UI installation and enable use the actual fixture and disable recovers built-ins', async ({ page }) => {
  await setup(page, 'zero');
  await page.goto('/?extensions-baseline&thread-laboratory');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: /Install local/ }).click();
  await page.getByRole('button', { name: 'Enable sample.thread-laboratory', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(contributed(page, 'composer')).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.thread-laboratory'); });
  await expect(contributed(page, 'composer')).toHaveCount(0); await expect(prompt(page)).toBeEnabled();
});

test('extensions thread actions: a live BTW message action uses the side task, never the selected main task', async ({ page }) => {
  await setup(page);
  await prompt(page).fill('/btw Side action fixture'); await prompt(page).press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sideId = (await calls(page, 'send_message'))[0].args.sessionId;
  expect(sideId).not.toBe('session-1');
  await emit(page, 'text', 'Side stream response', { sessionId: sideId });
  const action = page.locator('.btw-panel [data-extension-contribution="sample.thread-laboratory/message"]').last();
  await expect(action).toHaveCount(1); await action.locator('..').hover(); await action.click();
  await page.getByRole('menuitem', { name: 'Choose action tags', exact: true }).click();
  await page.getByRole('button', { name: 'Action tags', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__extensionDialogTransport.calls[0].context.sessionId)).toBe(sideId);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
});
