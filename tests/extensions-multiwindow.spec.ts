import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createPreviewContextBroker } from '../src/extensions/context-preview';
import type { ExtensionSnapshot } from '../src/extensions/manager';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/project-context/extension.json', 'utf8'));
const panel = (page: Page) => page.getByRole('region', { name: 'Project context inspector', exact: true });
for (const closeMain of [false, true]) {
  test(`extensions multiwindow: main and pinned eligible views share one extension task, close main=${closeMain}`, async ({ context }) => {
    const job = { id: 'workspace-job', title: 'Extension workspace job', projectName: 'Workspace', provider: 'sample.fake-harness/recorded', model: 'recorded', status: 'running', elapsedSeconds: 1 };
    let snapshot = { agents: [job] };
    await context.exposeBinding('__extensionSharedDockSnapshot', () => snapshot);
    await context.addInitScript(() => localStorage.setItem('pandacode.preview.agents-dock', JSON.stringify({ enabled: true, keepOnScreen: true, pinned: true })));
    const main = await context.newPage(), pinned = await context.newPage();
    await main.goto('/?extension-multiwindow'); await expect(main.locator('#prompt')).toBeEnabled();
    await pinned.goto('/agents-dock.html?extension-multiwindow');
    await main.locator('.agents-dock-trigger').focus();
    await pinned.locator('.agents-dock-orb').focus(); await pinned.keyboard.press('Enter');
    for (const page of [main, pinned]) {
      await expect(page.locator('[data-agent-id="workspace-job"]')).toBeVisible();
      await expect(page.locator('[data-agent-id="workspace-job"]')).toContainText('sample.fake-harness/recorded');
    }
    // Presentation expansion/focus is local, not shared with the workspace task or the other window.
    await pinned.keyboard.press('Escape');
    await expect(pinned.getByRole('dialog', { name: 'Running agents' })).toBeHidden();
    await expect(main.getByRole('dialog', { name: 'Running agents' })).toBeVisible();
    await (closeMain ? main : pinned).close();
    expect(snapshot.agents).toHaveLength(1); expect(job.status).toBe('running');
    const surviving = closeMain ? pinned : main;
    if (closeMain) { await pinned.locator('.agents-dock-orb').focus(); await pinned.keyboard.press('Enter'); }
    job.status = 'waiting-for-input';
    await surviving.evaluate(snapshot => (window as any).__extensionSharedDockPush(snapshot), snapshot);
    await expect(surviving.locator('[data-agent-id="workspace-job"]')).toHaveAttribute('aria-label', /Waiting for input/);
    snapshot = { agents: [] };
    await surviving.evaluate(snapshot => (window as any).__extensionSharedDockPush(snapshot), snapshot);
    await expect(surviving.locator('[data-agent-id="workspace-job"]')).toHaveCount(0);
  });
}
for (const closeFirst of [0, 1]) {
  test(`extensions multiwindow: E27 shared workspace job survives closing observer ${closeFirst + 1}`, async ({ context }) => {
    // One synthetic workspace host, not one copied job per page. Native policy has separate coverage.
    const broker = createPreviewContextBroker();
    const snapshot = { safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] } as ExtensionSnapshot;
    const data = { projects: [{ id: 'project-1', name: 'Workspace' }], tasks: [{ id: 'session-1', projectId: 'project-1', status: 'running' }] };
    await context.exposeBinding('__extensionSharedContext', (_source, request) => broker(request, snapshot, data));
    await context.addInitScript(manifest => {
      localStorage.setItem('pandacode.wallpapers', 'false');
      localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
    }, manifest);
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.goto('/?extension-multiwindow'); await expect(page.locator('#prompt')).toBeEnabled();
      await page.locator('[data-extension-contribution="sample.project-context/header"]').click();
      await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click();
      await expect(panel(page).locator('.extension-context-output')).toContainText('session-1 · running');
    }
    expect(broker.subscriptionCount()).toBe(2);
    await pages[0].locator('#prompt').fill('Window one draft'); await pages[1].locator('#prompt').fill('Window two draft');
    const closing = pages[closeFirst], surviving = pages[1 - closeFirst];
    // Deliver the real pagehide event deterministically before destroying the test transport.
    await closing.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => broker.subscriptionCount()).toBe(1); await closing.close();
    expect(data.tasks).toHaveLength(1); expect(data.tasks[0].status).toBe('running');
    data.tasks[0].status = 'completed'; broker.record('session-1', 'terminal', 'completed');
    await expect(panel(surviving).locator('.extension-context-output')).toContainText('session-1 · completed');
    await expect(surviving.locator('#prompt')).toHaveValue(closeFirst === 0 ? 'Window two draft' : 'Window one draft');
    await panel(surviving).getByRole('button', { name: 'Close project context', exact: true }).click();
    await expect.poll(() => broker.subscriptionCount()).toBe(0); expect(data.tasks[0].status).toBe('completed');
  });
}
test('extensions multiwindow: forged identities, stale handles and duplicate stream retries fail closed', async () => {
  const broker = createPreviewContextBroker();
  const snapshot = { safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] } as ExtensionSnapshot;
  const data = { projects: [{ id: 'project-1', name: 'Workspace' }], tasks: [{ id: 'session-1', projectId: 'project-1', status: 'running' }] };
  const captured = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', projectId: 'project-1', sessionId: 'session-1', revision: 1 };
  const capture = (extra = {}) => broker({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: { ...captured, ...extra } }, snapshot, data);
  for (const windowId of ['tray', 'main-forged', 'extension-view-forged']) expect(capture({ windowId }).ok).toBe(false);
  expect(capture({ sessionId: 'deleted-session' }).ok).toBe(false);
  const reply = capture(); if (!reply.ok) throw new Error(reply.error.code);
  const handle = (reply.value as { handle: string }).handle;
  const call = (request: Record<string, unknown>) => broker({ handle, ...request }, snapshot, data);
  expect(call({ op: 'consent', capability: 'jobs.summary', allow: true }).ok).toBe(true);
  const request = { op: 'subscribe', resource: 'jobs', limit: 10, requestId: 'same-request' };
  const first = call(request), retry = call(request);
  expect(first.ok && retry.ok && (first.value as { subscription: string }).subscription === (retry.value as { subscription: string }).subscription).toBe(true);
  expect(broker.subscriptionCount()).toBe(1);
  expect(call({ ...request, limit: 11 }).ok).toBe(false);
  call({ op: 'release' }); expect(broker.subscriptionCount()).toBe(0);
  expect(call({ op: 'query', resource: 'jobs', limit: 10 }).ok).toBe(false);
});
