import { test, expect } from '@playwright/test';
import { addProject, api, cmd, grant, ready } from './helpers';

test.describe.configure({ mode: 'serial' });

test('pairing produced a hardened session cookie and the workspace UI mounts', async ({ page, context }) => {
  await ready(page);
  const cookies = await context.cookies();
  const session = cookies.find(c => c.name === '__Host-pandacode_session')!;
  expect(session).toBeTruthy();
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.sameSite).toBe('Strict');
  expect(cookies.find(c => c.name === 'pandacode_csrf')?.httpOnly).toBe(false);
  await expect(page.getByText('Browser preview · sample data')).toHaveCount(0);
  await expect(page.locator('input[name="token"]')).toHaveCount(0);
});

test('project lifecycle: add via grant, list, files, read, search, remove', async ({ page }) => {
  await ready(page);
  const project = await addProject(page);
  const projects = await cmd(page, 'list_projects');
  expect(projects.status).toBe(200);
  expect(projects.body.map((p: { id: string }) => p.id)).toContain(project.id);

  const files = await cmd(page, 'list_files', { projectId: project.id });
  expect(files.status).toBe(200);
  expect(JSON.stringify(files.body)).toContain('README.md');

  const read = await cmd(page, 'read_file', { projectId: project.id, path: 'src/main.ts' });
  expect(read.status).toBe(200);
  expect(JSON.stringify(read.body)).toContain('needle-beta');

  const found = await cmd(page, 'search_files', { projectId: project.id, query: 'main' });
  expect(found.status).toBe(200);
  expect(JSON.stringify(found.body)).toContain('main.ts');

  const text = await cmd(page, 'search_text', { projectId: project.id, query: 'needle-alpha', matchCase: false, wholeWord: false, regex: false });
  expect(text.status).toBe(200);
  expect(JSON.stringify(text.body)).toContain('README.md');

  const preview = await cmd(page, 'prepare_file_preview', { projectId: project.id, path: 'pixel.png' });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  // A non-previewable file fails; the native reason is not forwarded (finding F-1).
  const notPreviewable = await cmd(page, 'prepare_file_preview', { projectId: project.id, path: 'README.md' });
  expect(notPreviewable.status).toBe(422);

  const resolved = await cmd(page, 'resolve_workspace_files', { projectId: project.id, paths: ['README.md', 'src/main.ts'] });
  expect(resolved.status).toBe(200);

  // Removing a project is permanent for the host DB; do it on a second, disposable project.
  const spare = await addProject(page, 'dir with spaces ü');
  expect((await cmd(page, 'remove_project', { projectId: spare.id })).status).toBe(200);
  const after = await cmd(page, 'list_projects');
  expect(after.body.map((p: { id: string }) => p.id)).not.toContain(spare.id);
});

test('unicode, spaces and dotfiles are listed and readable inside the root', async ({ page }) => {
  await ready(page);
  const root = (await api(page, 'GET', '/api/pandacode/files/roots')).body;
  const id = (Array.isArray(root) ? root : root.roots).find((r: { label: string }) => r.label === 'E2E').id;
  const listing = await api(page, 'GET', `/api/pandacode/files/list?root=${encodeURIComponent(id)}&path=${encodeURIComponent('dir with spaces ü')}`);
  expect(listing.status).toBe(200);
  expect(JSON.stringify(listing.body)).toContain('naïve file.txt');
  const repo = await api(page, 'GET', `/api/pandacode/files/list?root=${encodeURIComponent(id)}&path=repo`);
  expect(JSON.stringify(repo.body)).toContain('.hidden');
  const doc = await grant(page, 'dir with spaces ü/naïve file.txt', 'file', 'attachment');
  expect(doc.status).toBe(200);
  const read = await cmd(page, 'read_document', { path: doc.body.grant });
  expect(read.status).toBe(200);
  expect(JSON.stringify(read.body)).toContain('unicode ok');
});

test('tasks: create, rename, pin, board stage, details, messages, delete', async ({ page }) => {
  await ready(page);
  const project = await addProject(page);
  const providers = await cmd(page, 'list_providers');
  expect(providers.status).toBe(200);
  const provider = (providers.body as Array<{ id: string }>)[0]?.id ?? 'claude';
  const session = await cmd(page, 'create_session', { projectId: project.id, provider, model: 'default' });
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  const id = session.body.id;

  expect((await cmd(page, 'update_session', { sessionId: id, title: 'E2E renamed' })).status).toBe(200);
  const listed = await cmd(page, 'list_sessions');
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain('E2E renamed');
  expect((await cmd(page, 'get_messages', { sessionId: id })).status).toBe(200);
  expect((await cmd(page, 'list_subagents', { sessionId: id })).status).toBe(200);

  const board = await cmd(page, 'create_board_task', { projectId: project.id, provider, model: 'default', title: 'E2E board', description: 'card' });
  expect(board.status, JSON.stringify(board.body)).toBe(200);
  const boardId = board.body.id;
  expect((await cmd(page, 'update_task_details', { sessionId: boardId, title: 'E2E board 2', description: 'card 2' })).status).toBe(200);

  for (const target of [id, boardId]) {
    expect((await cmd(page, 'delete_session', { sessionId: target })).status).toBe(200);
  }
  const final = await cmd(page, 'list_sessions');
  expect(JSON.stringify(final.body)).not.toContain('E2E renamed');
});
