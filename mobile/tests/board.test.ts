/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import { demoCall, type DemoHost } from '../src/demo-host.ts';
import type { ConnectState } from '../src/store/index.ts';
import { BOARD_LABELS, boardAction, boardLayout, boardProjects, boardStage, firstStage, groupBoard, stageLocked, stageMoves, startPrompt } from '../src/store/board.ts';
import { STAGE_NAMES, stageName } from '../src/store/stages.ts';

const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'Panda', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, ...extra,
});

test('a task’s stage follows the desktop’s taskStage', () => {
  assert.equal(boardStage(task('a', { stage: 'review' })), 'review');
  assert.equal(boardStage(task('a', { stage: 'review', archived: true })), 'completed', 'archived counts as settled');
  assert.equal(boardStage(task('a', { status: 'running' })), 'in_progress');
  assert.equal(boardStage(task('a', { status: 'interrupted' })), 'in_progress');
  assert.equal(boardStage(task('a', { lastPromptAt: 5 })), 'review');
  assert.equal(boardStage(task('a')), 'pending');
  assert.equal(boardStage(task('a', { stage: 'bogus', lastPromptAt: 5 })), 'review', 'an unknown stage falls back');
});

test('the board groups project tasks by stage, newest first, without chats or bots', () => {
  const list = [
    task('old', { stage: 'review', updatedAt: 1 }), task('new', { stage: 'review', updatedAt: 9 }),
    task('chat', { chat: true, stage: 'review' }), task('bot', { botId: 'b', stage: 'pending' }),
    task('other', { projectId: 'q', projectName: 'Other', stage: 'pending' }), task('done', { stage: 'completed' }),
  ];
  const all = groupBoard(list);
  assert.deepEqual(all.review.map(t => t.sessionId), ['new', 'old']);
  assert.deepEqual(all.pending.map(t => t.sessionId), ['other']);
  assert.deepEqual(all.completed.map(t => t.sessionId), ['done']);
  assert.deepEqual(all.in_progress, []);
  assert.deepEqual(groupBoard(list, 'q').pending.map(t => t.sessionId), ['other']);
  assert.deepEqual(groupBoard(list, 'q').review, []);
  assert.deepEqual(list.map(t => t.sessionId), ['old', 'new', 'chat', 'bot', 'other', 'done'], 'the input is not reordered');
  assert.deepEqual(boardProjects(list), [{ id: 'p', name: 'Panda' }, { id: 'q', name: 'Other' }]);
});

test('moves skip the current stage and In progress, and none while the agent works', () => {
  assert.deepEqual(stageMoves(task('a', { stage: 'review' })), ['pending', 'completed']);
  assert.deepEqual(stageMoves(task('a', { stage: 'in_progress', status: 'stopped' })), ['pending', 'review', 'completed']);
  assert.deepEqual(stageMoves(task('a', { status: 'running' })), []);
  assert.equal(stageLocked(task('a', { status: 'waiting' })), true);
  assert.equal(stageLocked(task('a', { status: 'failed' })), false);
});

test('stage names are the desktop board’s, one table for Board and Task info', () => {
  assert.deepEqual(STAGE_NAMES, { pending: 'Pending', in_progress: 'In progress', review: 'Review', completed: 'Settled' });
  assert.equal(BOARD_LABELS, STAGE_NAMES);
  assert.equal(stageName('review'), 'Review');
  assert.equal(stageName('later'), 'later', 'an unknown stage shows as it came');
});

test('a card’s action follows the desktop’s task details', () => {
  assert.equal(boardAction(task('a')), 'start');
  assert.equal(boardAction(task('a', { stage: 'in_progress', status: 'stopped' })), 'retry');
  assert.equal(boardAction(task('a', { status: 'interrupted' })), 'retry', 'an interrupted run can be retried');
  assert.equal(boardAction(task('a', { status: 'running' })), null);
  assert.equal(boardAction(task('a', { stage: 'review', status: 'waiting' })), null, 'none while the agent holds it');
  assert.equal(boardAction(task('a', { lastPromptAt: 5 })), 'settle');
  assert.equal(boardAction(task('a', { stage: 'completed' })), 'reopen');
  assert.equal(boardAction(task('a', { archived: true, status: 'running' })), 'reopen', 'archived counts as settled');
});

test('starting sends the task’s details, else its title', () => {
  assert.equal(startPrompt('Fix login', '  Make the login page work  '), 'Make the login page work');
  assert.equal(startPrompt('Fix login', '   '), 'Fix login');
  assert.equal(startPrompt('Fix login', null), 'Fix login');
  assert.equal(startPrompt('Fix login'), 'Fix login');
});

test('layout and the opening tab', () => {
  assert.equal(boardLayout(390), 'tabs');
  assert.equal(boardLayout(1000), 'columns');
  assert.equal(firstStage(groupBoard([task('a', { stage: 'review' })])), 'review');
  assert.equal(firstStage(groupBoard([task('a', { status: 'running' }), task('b', { stage: 'review' })])), 'in_progress');
  assert.equal(firstStage(groupBoard([])), 'pending');
});

function demo(list: TaskSummary[]) {
  let state = {
    configured: false, ready: true, signedIn: true, connected: true, account: null, deviceId: 'phone', error: null, demo: true, older: {}, teams: {},
    devices: [{ id: 'mac', name: 'Mac', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { mac: { tasks: list, projects: [], loadedAt: 0 } },
    messages: {}, history: {}, sent: {}, live: {}, providers: {}, models: {}, pulls: {}, outdated: {}, bots: {},
  } as unknown as ConnectState;
  const h: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => 5000 };
  return { h, state: () => state };
}

test('demo worktree.create moves an unstarted task and branches a started one into a new task', async () => {
  const { h, state } = demo([task('fresh', { title: 'Fix the login page' }), task('talked', { lastPromptAt: 3 }), task('busy', { status: 'running' })]);
  const moved = await demoCall(h, 'mac', 'worktree.create', { sessionId: 'fresh' }) as { sessionId: string; moved: boolean; branch: string };
  assert.equal(moved.sessionId, 'fresh');
  assert.equal(moved.moved, true);
  assert.equal(moved.branch, 'pandacode/fix-the-login-page');
  const status = await demoCall(h, 'mac', 'worktree.status', { sessionId: 'fresh' }) as { worktree: boolean; branch: string };
  assert.equal(status.worktree, true);
  assert.equal(status.branch, 'pandacode/fix-the-login-page');
  await assert.rejects(demoCall(h, 'mac', 'worktree.create', { sessionId: 'fresh' }), /already has a worktree/);
  const created = await demoCall(h, 'mac', 'worktree.create', { sessionId: 'talked', branch: 'try-it' }) as { sessionId: string; moved: boolean; branch: string };
  assert.equal(created.moved, false);
  assert.notEqual(created.sessionId, 'talked');
  assert.equal(created.branch, 'pandacode/try-it');
  assert.ok(state().tasks.mac?.tasks.some(t => t.sessionId === created.sessionId && t.branch === 'pandacode/try-it'), 'the new task is listed');
  await assert.rejects(demoCall(h, 'mac', 'worktree.create', { sessionId: 'busy' }), /Stop the agent/);
  await assert.rejects(demoCall(h, 'mac', 'worktree.create', { sessionId: 'talked', branch: 'a..b' }), /branch name/);
});
