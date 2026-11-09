import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProject, cmd, ready, workspace } from './helpers';

test.describe.configure({ mode: 'serial' });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('status, diff, stage, commit, branches, switch and push reach the real repo', async ({ page }) => {
  await ready(page);
  const ws = workspace();
  const project = await addProject(page);
  appendFileSync(join(ws.repo, 'README.md'), 'edited from e2e\n');

  const status = await cmd(page, 'git_status', { projectId: project.id });
  expect(status.status).toBe(200);
  expect(JSON.stringify(status.body)).toContain('README.md');

  const diff = await cmd(page, 'git_diff', { projectId: project.id, path: 'README.md' });
  expect(diff.status).toBe(200);
  expect(JSON.stringify(diff.body)).toContain('edited from e2e');

  expect((await cmd(page, 'git_stage', { projectId: project.id, paths: ['README.md'], staged: true })).status).toBe(200);
  expect(git(ws.repo, 'diff', '--cached', '--name-only')).toBe('README.md');

  const commit = await cmd(page, 'git_commit', { projectId: project.id, message: 'e2e: commit from browser' });
  expect(commit.status, JSON.stringify(commit.body)).toBe(200);
  expect(git(ws.repo, 'log', '-1', '--format=%s')).toBe('e2e: commit from browser');

  const push = await cmd(page, 'git_push', { projectId: project.id });
  expect(push.status, JSON.stringify(push.body)).toBe(200);
  expect(git(join(ws.base, 'remote.git'), 'log', '-1', '--format=%s', 'main')).toBe('e2e: commit from browser');

  git(ws.repo, 'branch', 'e2e-other');
  const branches = await cmd(page, 'git_branches', { projectId: project.id });
  expect(branches.status).toBe(200);
  expect(JSON.stringify(branches.body)).toContain('e2e-other');
  expect((await cmd(page, 'git_switch_branch', { projectId: project.id, branch: 'e2e-other' })).status).toBe(200);
  expect(git(ws.repo, 'branch', '--show-current')).toBe('e2e-other');
  expect((await cmd(page, 'git_switch_branch', { projectId: project.id, branch: 'main' })).status).toBe(200);
});

test('worktree task: create, status, remove', async ({ page }) => {
  await ready(page);
  const ws = workspace();
  const project = await addProject(page);
  const provider = ((await cmd(page, 'list_providers')).body as Array<{ id: string }>)[0]?.id ?? 'claude';
  const session = await cmd(page, 'create_session', { projectId: project.id, provider, model: 'default' });
  expect(session.status).toBe(200);
  const created = await cmd(page, 'create_worktree', { sessionId: session.body.id, branch: 'e2e-wt' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const worktreeSession = created.body.id ?? session.body.id;
  expect(git(ws.repo, 'worktree', 'list')).toContain('e2e-wt');
  expect((await cmd(page, 'worktree_status', { sessionId: worktreeSession })).status).toBe(200);
  const removed = await cmd(page, 'remove_worktree', { sessionId: worktreeSession, deleteBranch: true });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(git(ws.repo, 'worktree', 'list')).not.toContain('e2e-wt');
});

test('jj commands report cleanly when jj is absent or the repo is not jj', async ({ page }) => {
  await ready(page);
  const project = await addProject(page);
  const reply = await cmd(page, 'jj_status', { projectId: project.id });
  // Either real jj output, or a bounded command failure; never a 5xx or a hang.
  expect([200, 422]).toContain(reply.status);
});
