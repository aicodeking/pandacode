import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_WINDOW, readOpen, sectionOf, sidebarSections } from '../src/sidebar-sections.ts';

const now = 10 * REVIEW_WINDOW;
const task = (id, extra = {}) => ({ id, projectId: 'p', createdAt: 1, updatedAt: 1, lastResponseAt: null, taskStage: 'pending', ...extra });
const ids = list => list.map(t => t.id);
const split = (tasks, options = {}) => sidebarSections({
  tasks, now, active: t => Boolean(t.running), stage: t => t.taskStage, ...options,
});

test('puts every task in exactly one section', () => {
  const tasks = [
    task('run', { running: true, taskStage: 'in_progress' }),
    task('fresh', { taskStage: 'review', lastResponseAt: now - 60_000 }),
    task('stale', { taskStage: 'review', lastResponseAt: now - REVIEW_WINDOW - 1 }),
    task('idea'),
    task('done', { taskStage: 'completed', completedAt: now - 5 }),
  ];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.active), ['run']);
  assert.deepEqual(ids(sections.review), ['fresh']);
  assert.deepEqual(ids(sections.rest), ['stale', 'idea']);
  assert.deepEqual(ids(sections.completed), ['done']);
  assert.equal(Object.values(sections).flat().length, tasks.length);
});

test('Active lists the latest start first and Needs review the latest response, whatever the manual order', () => {
  const tasks = [task('b', { running: true, lastPromptAt: 5 }), task('a', { running: true, lastPromptAt: 9 }), task('d', { taskStage: 'review', lastResponseAt: now - 2 }), task('c', { taskStage: 'review', lastResponseAt: now - 1 })];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.active), ['a', 'b']);
  assert.deepEqual(ids(sections.review), ['c', 'd']);
});

test('lists completed tasks newest first, and a running completed task stays active', () => {
  const tasks = [
    task('old', { taskStage: 'completed', completedAt: 10 }),
    task('new', { taskStage: 'completed', completedAt: 30 }),
    task('mid', { taskStage: 'completed', completedAt: null, lastResponseAt: 20, updatedAt: 99 }),
    task('again', { taskStage: 'completed', running: true }),
  ];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.completed), ['new', 'mid', 'old']);
  assert.deepEqual(ids(sections.active), ['again']);
});

test('running threads are Active even when pinned or open; pinned review work stays pinned', () => {
  const tasks = [
    task('pin', { pinned: true, running: true, lastPromptAt: 2 }), task('open', { running: true, lastPromptAt: 1 }),
    task('pinDone', { pinned: true, taskStage: 'completed' }), task('pinReview', { pinned: true, taskStage: 'review', lastResponseAt: now - 1 }),
  ];
  const placed = split(tasks, { selectedId: 'open' });
  assert.deepEqual(ids(placed.active), ['pin', 'open']);
  assert.deepEqual(ids(placed.rest), ['pinReview']);
  assert.deepEqual(ids(placed.completed), ['pinDone']);
});

test('Needs review lists only unseen turns, and a held open thread stays there', () => {
  const tasks = [task('seen', { taskStage: 'review', lastResponseAt: now - 1 }), task('new', { taskStage: 'review', lastResponseAt: now - 1 })];
  const unseen = t => t.id === 'new';
  assert.deepEqual(ids(split(tasks, { unseen }).review), ['new']);
  assert.deepEqual(ids(split(tasks, { unseen, selectedId: 'seen', hold: 'review' }).review), ['new', 'seen']);
  assert.deepEqual(ids(split(tasks, { unseen, selectedId: 'new' }).review), []);
});

test('the open thread holds its section, so a click on its row never moves it; running still wins', () => {
  const done = task('done', { taskStage: 'completed', completedAt: 5 }), idea = task('idea');
  assert.deepEqual(ids(split([{ ...done, taskStage: 'review' }], { selectedId: 'done', hold: 'completed' }).completed), ['done']);
  assert.deepEqual(ids(split([done], { selectedId: 'done', hold: 'rest' }).rest), ['done']);
  assert.deepEqual(ids(split([done], { selectedId: 'other', hold: 'rest' }).completed), ['done']);
  assert.deepEqual(ids(split([{ ...idea, running: true }], { selectedId: 'idea', hold: 'rest' }).active), ['idea']);
  // Opened from Active, a finished run stays there while the thread is open.
  assert.deepEqual(ids(split([idea], { selectedId: 'idea', hold: 'active' }).active), ['idea']);
  assert.deepEqual(ids(split([idea], { selectedId: 'other', hold: 'active' }).rest), ['idea']);
});

test('sectionOf maps sidebar groups to the section a thread holds', () => {
  assert.equal(sectionOf('active'), 'active');
  assert.equal(sectionOf('review'), 'review');
  assert.equal(sectionOf('completed'), 'completed');
  for (const group of ['pinned', 'chats', 'project:p', 'all', 'archived']) assert.equal(sectionOf(group), 'rest');
  assert.equal(sectionOf(undefined), undefined);
});

test('the Completed section reads its open state safely', () => {
  assert.equal(readOpen({ getItem: () => 'true' }, 'k'), true);
  assert.equal(readOpen({ getItem: () => null }, 'k'), false);
  assert.equal(readOpen({ getItem: () => { throw new Error('denied'); } }, 'k'), false);
});
