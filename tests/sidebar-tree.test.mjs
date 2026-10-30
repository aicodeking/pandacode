import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_LIMIT, folderGroups, readCollapsed, shownTasks, sidebarSkeletonHtml } from '../src/sidebar-tree.ts';

const projects = [{ id: 'a', name: 'alpha', path: '/a' }, { id: 'b', name: 'beta', path: '/b' }, { id: 'c', name: 'empty', path: '/c' }];
const task = (id, projectId, at) => ({ id, projectId, createdAt: 1, lastPromptAt: at, lastResponseAt: null });

test('folders with the newest work come first and keep their task order', () => {
  const tasks = [task('1', 'a', 10), task('2', 'b', 50), task('3', 'a', 90)];
  const groups = folderGroups({ projects, tasks, activity: t => t.lastPromptAt, includeEmpty: true });
  assert.deepEqual(groups.map(group => group.project.id), ['a', 'b', 'c']);
  assert.deepEqual(groups[0].tasks.map(t => t.id), ['1', '3']);
  assert.deepEqual(folderGroups({ projects, tasks, activity: t => t.lastPromptAt, includeEmpty: false }).map(group => group.project.id), ['a', 'b']);
});

test('folders show six tasks and always include the selected one', () => {
  const tasks = Array.from({ length: 9 }, (_, i) => task(String(i), 'a', i));
  assert.equal(shownTasks(tasks, false, '').length, 6);
  assert.deepEqual(shownTasks(tasks, false, '8').map(t => t.id), ['0', '1', '2', '3', '4', '5', '8']);
  assert.equal(shownTasks(tasks, true, '').length, 9);
  assert.equal(shownTasks(tasks.slice(0, 4), false, '').length, 4);
  const many = Array.from({ length: 30 }, (_, i) => task(String(i), 'a', i));
  assert.equal(shownTasks(many, false, '', PROJECT_LIMIT).length, 20, 'a selected project shows more rows');
});

test('collapsed folders survive bad stored values', () => {
  const store = value => ({ getItem: () => value });
  assert.deepEqual([...readCollapsed(store('["a",3,"b"]'), 'k')], ['a', 'b']);
  assert.equal(readCollapsed(store('{oops'), 'k').size, 0);
  assert.equal(readCollapsed(store(null), 'k').size, 0);
});

test('sidebar skeleton generates pulsing placeholder rows', () => {
  const html = sidebarSkeletonHtml(4);
  assert.equal(html.match(/class="sidebar-row-skeleton"/g)?.length, 4);
  assert.ok(html.includes('class="sidebar-skeleton-line"'));
  assert.ok(html.includes('class="sidebar-skeleton-line-sub"'));
  assert.ok(html.includes('aria-hidden="true"'));
});
