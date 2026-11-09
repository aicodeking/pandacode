import { test, expect } from '@playwright/test';
import { addProject, api, cmd, grant, ready, rootId, workspace } from './helpers';

test('traversal, absolute and symlink escapes are refused by the real gateway', async ({ page }) => {
  await ready(page);
  const root = await rootId(page);
  for (const path of ['../outside', '../outside/secret.txt', 'repo/../../outside', '/etc']) {
    const listing = await api(page, 'GET', `/api/pandacode/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    expect(listing.status, path).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(listing.body)).not.toContain('outside-the-root');
    const selected = await grant(page, path, 'file', 'attachment');
    expect(selected.status, path).toBeGreaterThanOrEqual(400);
  }
  const escape = await grant(page, 'repo/escape.txt', 'file', 'attachment');
  expect(escape.status).toBeGreaterThanOrEqual(400);

  const project = await addProject(page);
  for (const path of ['../outside/secret.txt', '/etc/hosts', 'escape.txt']) {
    const read = await cmd(page, 'read_file', { projectId: project.id, path });
    expect(read.status, path).not.toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('outside-the-root');
  }
});

test('grants are single-use and raw host paths are rejected for path commands', async ({ page }) => {
  await ready(page);
  const ws = workspace();
  const first = await grant(page, 'repo', 'folder', 'project');
  expect((await cmd(page, 'add_project', { path: first.body.grant })).status).toBe(200);
  expect((await cmd(page, 'add_project', { path: first.body.grant })).status).not.toBe(200);
  expect((await cmd(page, 'add_project', { path: ws.repo })).status).not.toBe(200);
  expect((await cmd(page, 'describe_folder', { path: ws.outside })).status).not.toBe(200);
  // Wrong purpose: an attachment grant cannot add a project.
  const attachment = await grant(page, 'repo', 'folder', 'attachment');
  expect((await cmd(page, 'add_project', { path: attachment.body.grant })).status).not.toBe(200);
});

test('CSRF, origin and unknown/blocked commands are enforced on the real host', async ({ page }) => {
  await ready(page);
  const noCsrf = await page.evaluate(async () => (await fetch('/api/pandacode/commands/list_projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  expect(noCsrf).toBe(403);
  const wrongCsrf = await api(page, 'POST', '/api/pandacode/commands/list_projects', {}, { 'x-csrf-token': 'nope' });
  expect(wrongCsrf.status).toBe(403);
  expect((await api(page, 'POST', '/api/pandacode/commands/definitely_not_a_command', {})).status).toBe(404);
  for (const blocked of ['reveal_path', 'open_external_url', 'overlay_toggle', 'read_clipboard_image']) {
    expect((await api(page, 'POST', `/api/pandacode/commands/${blocked}`, {})).status, blocked).toBe(501);
  }
  expect((await api(page, 'POST', '/api/pandacode/commands/list_projects', [] as unknown as object)).status).toBe(400);
  // Cross-origin request from Node (no browser Origin) is refused.
  const origin = new URL(page.url()).origin;
  const foreign = await fetch(`${origin}/api/pandacode/commands/list_projects`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  expect(foreign.status).toBe(403);
  const unauth = await fetch(`${origin}/api/pandacode/runtime-snapshot`);
  expect(unauth.status).toBe(401);
});
