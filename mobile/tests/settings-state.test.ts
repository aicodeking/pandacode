/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TasksList } from '../src/connect/types.ts';
import { pickableProjects } from '../src/ui/new-task-projects.ts';
import { needsRegistration, notificationRow } from '../src/ui/push-state.ts';

test('the notifications row tells a failed registration from an enabled phone', () => {
  const granted = { granted: true, canAskAgain: true };
  assert.equal(notificationRow(null), 'loading');
  assert.equal(notificationRow({ ...granted, registration: 'enrolled' }), 'on');
  assert.equal(notificationRow({ ...granted, registration: 'skipped' }), 'on');
  assert.equal(notificationRow({ ...granted, registration: null }), 'on');
  assert.equal(notificationRow({ ...granted, registration: 'error' }), 'failed');
  assert.equal(notificationRow({ ...granted, registration: 'unsupported' }), 'unsupported');
});

test('off asks while the system still can, then points at system settings', () => {
  assert.equal(notificationRow({ granted: false, canAskAgain: true, registration: null }), 'ask');
  assert.equal(notificationRow({ granted: false, canAskAgain: false, registration: null }), 'denied');
});

test('a phone registers again only until the relay has answered for good', () => {
  assert.equal(needsRegistration({ granted: true, registration: null }), true);
  assert.equal(needsRegistration({ granted: true, registration: 'error' }), true);
  assert.equal(needsRegistration({ granted: true, registration: 'enrolled' }), false);
  assert.equal(needsRegistration({ granted: true, registration: 'unsupported' }), false);
  assert.equal(needsRegistration({ granted: false, registration: null }), false);
});

test('chat pseudo-projects are not offered for a new task', () => {
  const task = (projectId: string, chat: boolean) => ({ projectId, chat }) as TasksList['tasks'][number];
  const project = (id: string) => ({ id, name: id, repo: null });
  const list: TasksList = { tasks: [task('app', false), task('chat', true)], projects: [project('chat'), project('app'), project('idle')] };
  assert.deepEqual(pickableProjects(list).map(p => p.id), ['app', 'idle']);
  assert.deepEqual(pickableProjects(undefined), []);
});
