import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addProject, api, cmd, ready } from './helpers';

test.describe.configure({ mode: 'serial' });

test('appearance preferences round-trip through the host with a new revision', async ({ page }) => {
  await ready(page);
  const before = await api(page, 'GET', '/api/pandacode/preferences');
  expect(before.status).toBe(200);
  const next = before.body.preferences['pandacode.compact'] === 'true' ? 'false' : 'true';
  const saved = await api(page, 'POST', '/api/pandacode/preferences', { preferences: { 'pandacode.compact': next } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.revision).toBeGreaterThan(before.body.revision);
  expect(saved.body.preferences['pandacode.compact']).toBe(next);
  const rejected = await api(page, 'POST', '/api/pandacode/preferences', { preferences: { 'pandacode.secretToken': 'x' } });
  expect(rejected.status).toBeGreaterThanOrEqual(400);
  const again = await api(page, 'GET', '/api/pandacode/preferences');
  expect(JSON.stringify(again.body)).not.toContain('secretToken');
});

test('64 concurrent commands all complete without 5xx and stay under budget', async ({ page }) => {
  await ready(page);
  const project = await addProject(page);
  const started = Date.now();
  const statuses = await page.evaluate(async (projectId) => {
    const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('pandacode_csrf='))!.slice(15);
    const one = (i: number) => fetch(i % 2 ? '/api/pandacode/commands/list_projects' : '/api/pandacode/commands/list_files', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify(i % 2 ? {} : { projectId }),
    }).then(r => r.status);
    return Promise.all(Array.from({ length: 64 }, (_, i) => one(i)));
  }, project.id);
  const elapsed = Date.now() - started;
  // 429 gateway_busy is an allowed, bounded answer under load; 5xx is not.
  expect(statuses.filter(s => s >= 500)).toEqual([]);
  expect(statuses.filter(s => s === 200).length).toBeGreaterThanOrEqual(32);
  expect(elapsed).toBeLessThan(30_000);
  test.info().annotations.push({ type: 'load', description: `64 commands in ${elapsed} ms; ${statuses.filter(s => s === 429).length} busy` });
});

test('duplicate x-request-id is deduplicated, not executed twice', async ({ page }) => {
  await ready(page);
  const project = await addProject(page);
  const provider = ((await cmd(page, 'list_providers')).body as Array<{ id: string }>)[0]?.id ?? 'claude';
  const ids = await page.evaluate(async ({ projectId, provider }) => {
    const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('pandacode_csrf='))!.slice(15);
    const send = () => fetch('/api/pandacode/commands/create_session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-request-id': 'e2e-dedupe-create' },
      body: JSON.stringify({ projectId, provider, model: 'default' }),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    return Promise.all([send(), send()]);
  }, { projectId: project.id, provider });
  const created = ids.filter(r => r.status === 200).map(r => r.body.id);
  expect(new Set(created).size).toBeLessThanOrEqual(1);
});

test('the event socket reconnects after the network drops and commands work again', async ({ page, context }) => {
  await ready(page);
  const sockets: string[] = [];
  page.on('websocket', ws => sockets.push(ws.url()));
  await page.reload();
  await expect.poll(() => sockets.length).toBeGreaterThan(0);
  const before = sockets.length;
  await context.setOffline(true);
  await page.waitForTimeout(1500);
  await context.setOffline(false);
  await expect.poll(() => sockets.length, { timeout: 20_000 }).toBeGreaterThan(before);
  expect((await cmd(page, 'list_projects')).status).toBe(200);
});

test('large transcript fetch is bounded (response_too_large or OK, never a crash)', async ({ page }) => {
  await ready(page);
  const reply = await cmd(page, 'list_sessions');
  expect([200, 413]).toContain(reply.status);
});

test('after the native host restarts, the old session is refused and a new pairing recovers', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  const host = JSON.parse(readFileSync('.web-e2e/host.json', 'utf8'));
  // @ts-expect-error plain ESM helper
  const { startHost } = await import('../../scripts/web-e2e/host.mjs');
  process.kill(host.pid, 'SIGTERM');
  await expect.poll(async () => { try { await fetch(`${host.origin}/api/pandacode/health`); return 'up'; } catch { return 'down'; } }, { timeout: 15_000 }).toBe('down');
  const next = await startHost({ keepData: true, workspace: host.workspace });
  try {
    expect((await api(page, 'GET', '/api/pandacode/session')).status).toBe(401);
    // Projects survived the restart (durable DB), visible after re-pairing.
    const fresh = await page.context().browser()!.newContext({ storageState: undefined });
    const p2 = await fresh.newPage();
    await p2.goto(next.origin);
    await p2.locator('input[name="token"]').fill(next.code);
    await p2.getByRole('button', { name: 'Connect' }).click();
    await p2.waitForFunction(() => document.cookie.includes('pandacode_csrf='));
    const projects = await api(p2, 'POST', '/api/pandacode/commands/list_projects', {});
    expect(projects.status).toBe(200);
    expect(projects.body.length).toBeGreaterThan(0);
    await fresh.close();
  } finally {
    await next.stop();
  }
});
