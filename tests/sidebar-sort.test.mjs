import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SORT, PROJECT_ORDER_KEY, SORT_KEY, compareCompleted, readProjectOrder, compareManual, matchesFilter, projectComparator, readSort, taskComparator } from '../src/sidebar-sort.ts';
import { folderGroups } from '../src/sidebar-tree.ts';

const task = (id, extra = {}) => ({ id, projectId: 'p', title: id, createdAt: 1, updatedAt: 1, lastResponseAt: null, lastPromptAt: null, sidebarOrder: null, ...extra });
const ids = list => list.map(t => t.id);
const sorted = (tasks, compare) => ids([...tasks].sort(compare));

test('manual order: unranked (new) tasks lead, newest first, then saved ranks', () => {
  const tasks = [task('ranked-1', { sidebarOrder: 1 }), task('ranked-0', { sidebarOrder: 0 }), task('new-old', { createdAt: 5 }), task('new', { createdAt: 9 })];
  assert.deepEqual(sorted(tasks, compareManual), ['new', 'new-old', 'ranked-0', 'ranked-1']);
});

test('a task created after a reorder stays on top instead of sinking below arranged ones', () => {
  const arranged = ['c', 'a', 'b'].map((id, index) => task(id, { sidebarOrder: index, lastPromptAt: 100 + index }));
  const created = task('created', { createdAt: 50 });
  assert.deepEqual(sorted([...arranged, created], compareManual), ['created', 'c', 'a', 'b']);
});

test('sorts are deterministic: equal keys fall back to creation, then id', () => {
  const tasks = [task('b'), task('a'), task('c', { createdAt: 2 })];
  for (const sort of ['manual', 'recent', 'created']) {
    assert.deepEqual(sorted(tasks, taskComparator(sort)), ['c', 'a', 'b'], sort);
    assert.deepEqual(sorted([...tasks].reverse(), taskComparator(sort)), ['c', 'a', 'b'], sort);
  }
});

test('recent and created ignore manual ranks', () => {
  const tasks = [task('old', { sidebarOrder: 0, createdAt: 1, lastPromptAt: 10 }), task('busy', { sidebarOrder: 1, createdAt: 2, lastResponseAt: 90 }), task('young', { sidebarOrder: 2, createdAt: 3 })];
  assert.deepEqual(sorted(tasks, taskComparator('recent')), ['busy', 'old', 'young']);
  assert.deepEqual(sorted(tasks, taskComparator('created')), ['young', 'busy', 'old']);
});

test('completed order uses completion, never updatedAt (a rename does not move a row)', () => {
  const tasks = [task('renamed', { completedAt: 10, updatedAt: 999 }), task('later', { completedAt: 20 }), task('legacy', { completedAt: null, lastResponseAt: 15, updatedAt: 1000 })];
  assert.deepEqual(sorted(tasks, compareCompleted), ['later', 'legacy', 'renamed']);
});

test('the saved sort is validated field by field', () => {
  const read = value => readSort({ getItem: key => key === SORT_KEY ? value : null });
  assert.deepEqual(read(null), DEFAULT_SORT);
  assert.deepEqual(read('not json'), DEFAULT_SORT);
  assert.deepEqual(read(JSON.stringify({ tasks: 'recent', projects: 'bogus', perProject: 7 })), { ...DEFAULT_SORT, tasks: 'recent' });
  assert.deepEqual(read(JSON.stringify({ tasks: 'created', projects: 'name', perProject: 15, group: 'flat' })), { tasks: 'created', projects: 'name', perProject: 15, group: 'flat' });
  assert.deepEqual(read(JSON.stringify({ projects: 'manual', group: 'tree' })), { ...DEFAULT_SORT, projects: 'manual' });
  assert.deepEqual(readSort({ getItem: () => { throw new Error('denied'); } }), DEFAULT_SORT);
});

test('projects sort by recent activity, order added, or name', () => {
  const projects = [{ id: 'z', name: 'zeta', path: '/z' }, { id: 'a', name: 'Alpha', path: '/a' }, { id: 'm', name: 'mid 10', path: '/m' }, { id: 'n', name: 'mid 9', path: '/n' }];
  const latest = new Map([['m', 30], ['z', 20]]);
  const order = sort => [...projects].sort(projectComparator(sort, projects, latest)).map(p => p.id);
  assert.deepEqual(order('recent'), ['m', 'z', 'a', 'n']);
  assert.deepEqual(order('added'), ['z', 'a', 'm', 'n']);
  assert.deepEqual(order('name'), ['a', 'n', 'm', 'z']);
  // Manual: the dragged order; projects not in it yet lead, most recent first.
  const manual = [...projects].sort(projectComparator('manual', projects, latest, ['a', 'z'])).map(p => p.id);
  assert.deepEqual(manual, ['m', 'n', 'a', 'z']);
});

test('Added follows each project’s addedOrder, not the name order the list arrives in', () => {
  const listed = [{ id: 'a', name: 'Alpha', path: '/a', addedOrder: 7 }, { id: 'b', name: 'beta', path: '/b', addedOrder: 2 }, { id: 'c', name: 'gamma', path: '/c', addedOrder: 5 }];
  assert.deepEqual([...listed].sort(projectComparator('added', listed, new Map())).map(p => p.id), ['b', 'c', 'a']);
});

test('the saved folder order keeps unique string ids only', () => {
  const read = value => readProjectOrder({ getItem: key => key === PROJECT_ORDER_KEY ? value : null });
  assert.deepEqual(read(JSON.stringify(['b', 'a', 'b', 3, null])), ['b', 'a']);
  assert.deepEqual(read('{"not":"a list"}'), []);
  assert.deepEqual(read('broken'), []);
  assert.deepEqual(read(null), []);
});

test('a folder holds its place when its newest task moves to Active', () => {
  const projects = [{ id: 'a', name: 'alpha', path: '/a' }, { id: 'b', name: 'beta', path: '/b' }];
  const running = task('run', { projectId: 'a', lastPromptAt: 100 });
  const folderTasks = [task('a1', { projectId: 'a', lastPromptAt: 10 }), task('b1', { projectId: 'b', lastPromptAt: 50 })];
  const groups = folderGroups({ projects, tasks: folderTasks, all: [...folderTasks, running], includeEmpty: true });
  assert.deepEqual(groups.map(g => g.project.id), ['a', 'b']);
  assert.deepEqual(folderGroups({ projects, tasks: folderTasks, includeEmpty: true, sort: 'name' }).map(g => g.project.id), ['a', 'b']);
});

test('the filter matches title, branch, linked PR and project, word by word', () => {
  const t = task('x', { title: 'Speed up search', worktreeBranch: 'feat/instant-search', pullRequest: { kind: 'pull', number: 482, title: 'Compact rows' } });
  assert.equal(matchesFilter(t, ''), true);
  assert.equal(matchesFilter(t, 'SPEED'), true);
  assert.equal(matchesFilter(t, 'instant'), true);
  assert.equal(matchesFilter(t, '#482'), true);
  assert.equal(matchesFilter(t, 'compact speed'), true);
  assert.equal(matchesFilter(t, 'orbit', 'Orbit'), true);
  assert.equal(matchesFilter(t, 'speed missing'), false);
});
