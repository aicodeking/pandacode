import test from 'node:test';
import assert from 'node:assert/strict';
import { nextToastCount, shouldShowGlobalError, isBenignGlobalError, globalErrorText, GLOBAL_ERROR_TEXT, escapeClosesToast, TOAST_ESCAPE_GRACE_MS, shouldToastLiveError, queueToast, TOAST_QUEUE_MAX, toastTitle, TOAST_TITLE_CHARS } from '../src/toast-model.ts';

test('first message counts 1', () => assert.equal(nextToastCount(null, 'a', true), 1));
test('identical visible message counts up', () => assert.equal(nextToastCount({ text: 'a', count: 2 }, 'a', true), 3));
test('different message or hidden toast restarts at 1', () => {
  assert.equal(nextToastCount({ text: 'a', count: 2 }, 'b', true), 1);
  assert.equal(nextToastCount({ text: 'a', count: 2 }, 'a', false), 1);
});
test('global errors: same text is suppressed for 30 s, any text for 2 s', () => {
  assert.equal(shouldShowGlobalError(null, 'x', 0), true);
  assert.equal(shouldShowGlobalError({ key: 'x', at: 0 }, 'x', 29_000), false);
  assert.equal(shouldShowGlobalError({ key: 'x', at: 0 }, 'y', 1_000), false);
  assert.equal(shouldShowGlobalError({ key: 'x', at: 0 }, 'y', 2_500), true);
  assert.equal(shouldShowGlobalError({ key: 'x', at: 0 }, 'x', 31_000), true);
});
test('benign noise is ignored', () => {
  assert.equal(isBenignGlobalError({ name: 'AbortError' }, ''), true);
  assert.equal(isBenignGlobalError(undefined, 'ResizeObserver loop completed with undelivered notifications.'), true);
  assert.equal(isBenignGlobalError(undefined, 'Script error.'), true);
  assert.equal(isBenignGlobalError(new Error('real'), 'real'), false);
});

test('global errors: internal messages stay in the console, IPC strings may show', () => {
  assert.equal(globalErrorText(new TypeError("Cannot read properties of undefined (reading 'x')")), GLOBAL_ERROR_TEXT);
  assert.equal(globalErrorText(undefined), GLOBAL_ERROR_TEXT);
  assert.equal(globalErrorText({ foo: 1 }), GLOBAL_ERROR_TEXT);
  assert.equal(globalErrorText('Project folder is missing'), 'Project folder is missing');
  assert.equal(globalErrorText({ message: 'Disk is full' }), 'Disk is full');
  assert.equal(globalErrorText('   '), GLOBAL_ERROR_TEXT);
  assert.match(GLOBAL_ERROR_TEXT, /restart PandaCode/);
});
test('Escape closes the toast first only when focus is in it or an urgent one just appeared', () => {
  const base = { visible: true, focusInToast: false, urgent: true, shownAt: 1000, now: 1000 + TOAST_ESCAPE_GRACE_MS - 1, blocked: false };
  assert.equal(escapeClosesToast(base), true);
  assert.equal(escapeClosesToast({ ...base, now: 1000 + TOAST_ESCAPE_GRACE_MS }), false);
  assert.equal(escapeClosesToast({ ...base, now: 99_999, focusInToast: true }), true);
  assert.equal(escapeClosesToast({ ...base, visible: false }), false);
  assert.equal(escapeClosesToast({ ...base, focusInToast: true, blocked: true }), false);
  assert.equal(escapeClosesToast({ ...base, now: 500 }), false);
});

test('a plain notice that just appeared does not take Escape from Stop; focus in it still does', () => {
  const base = { visible: true, focusInToast: false, urgent: false, shownAt: 1000, now: 1001, blocked: false };
  assert.equal(escapeClosesToast(base), false);
  assert.equal(escapeClosesToast({ ...base, focusInToast: true }), true);
});

test('only a plain notice repeating a plain notice bumps the count', () => {
  assert.equal(nextToastCount({ text: 'a', count: 1, plain: false }, 'a', true), 1);
  assert.equal(nextToastCount({ text: 'a', count: 1 }, 'a', true, false), 1);
  assert.equal(nextToastCount({ text: 'a', count: 1, plain: true }, 'a', true, true), 2);
});

test('a repeat in another tone starts a fresh toast instead of bumping the count', () => {
  const plainShown = { text: 'a', count: 1, plain: true };
  assert.equal(nextToastCount(plainShown, 'a', true, true, 'danger'), 1);
  assert.equal(nextToastCount({ ...plainShown, tone: 'danger' }, 'a', true, true), 1);
  assert.equal(nextToastCount({ ...plainShown, tone: 'danger' }, 'a', true, true, 'danger'), 2);
});

test('a live error toasts only when its inline row is not already in front of the reader', () => {
  const base = { onScreen: true, attended: true, undoShowing: false };
  // The thread is on screen in a focused, visible window: the inline row is enough.
  assert.equal(shouldToastLiveError(base), false);
  // Background thread, or the window is hidden or unfocused: toast.
  assert.equal(shouldToastLiveError({ ...base, onScreen: false }), true);
  assert.equal(shouldToastLiveError({ ...base, attended: false }), true);
  // An Undo toast for the thread on screen is never replaced by an error its row already shows.
  assert.equal(shouldToastLiveError({ ...base, attended: false, undoShowing: true }), false);
  assert.equal(shouldToastLiveError({ ...base, onScreen: false, undoShowing: true }), true);
});

test('queueToast: shows at once unless a dismissal still offers its Undo', () => {
  const a = { text: 'a' };
  assert.deepEqual(queueToast({ holding: false, queue: [] }, a, false), { show: true, queue: [] });
  assert.deepEqual(queueToast({ holding: true, queue: [] }, a, false), { show: false, queue: [a] });
});

test('queueToast: a second dismissal replaces the first (which commits); the queue is kept', () => {
  const waiting = [{ text: 'saved' }];
  assert.deepEqual(queueToast({ holding: true, queue: waiting }, { text: 'Error dismissed' }, true), { show: true, queue: waiting });
});

test('queueToast: another feature\'s Undo toast takes over at once; plain, danger and action notices wait', () => {
  const waiting = [{ text: 'saved' }];
  assert.deepEqual(queueToast({ holding: true, queue: waiting }, { text: 'Task archived', undo: () => {} }, false), { show: true, queue: waiting });
  assert.equal(queueToast({ holding: true, queue: [] }, { text: 'Opened', undo: { label: 'Show', run: () => {} } }, false).show, false);
  assert.equal(queueToast({ holding: true, queue: [] }, { text: 'Failed', tone: 'danger' }, false).show, false);
});

test('queueToast: deduped by text and tone, bounded by dropping the oldest plain notices, input untouched', () => {
  const queue = Object.freeze([{ text: 'a' }, { text: 'b', tone: 'danger' }]);
  assert.deepEqual(queueToast({ holding: true, queue }, { text: 'a' }, false).queue, queue);
  assert.deepEqual(queueToast({ holding: true, queue }, { text: 'b' }, false).queue, [...queue, { text: 'b' }]);
  let full = [];
  for (let index = 0; index < TOAST_QUEUE_MAX + 2; index++) full = queueToast({ holding: true, queue: full }, { text: String(index) }, false).queue;
  assert.deepEqual(full, Array.from({ length: TOAST_QUEUE_MAX }, (_, index) => ({ text: String(index + 2) })));
  full = queueToast({ holding: true, queue: full }, { text: 'next' }, false).queue;
  assert.deepEqual(full.map(entry => entry.text), ['3', '4', 'next']);
});

test('queueToast: a notice with an action button is never dropped', () => {
  const action = { text: 'Worker finished', undo: { label: 'Open task', run: () => {} } };
  let queue = [action];
  for (let index = 0; index < TOAST_QUEUE_MAX + 2; index++) queue = queueToast({ holding: true, queue }, { text: `saved ${index}` }, false).queue;
  assert.equal(queue[0], action);
  assert.equal(queue.length, TOAST_QUEUE_MAX + 1);
});

test('queueToast: notices that need the user (approval, input) and danger notices are never dropped', () => {
  let queue = [{ text: 'Orbit needs approval', important: true }, { text: 'Disk is full', tone: 'danger' }];
  for (let index = 0; index < TOAST_QUEUE_MAX + 3; index++) queue = queueToast({ holding: true, queue }, { text: `saved ${index}` }, false).queue;
  assert.deepEqual(queue.slice(0, 2).map(entry => entry.text), ['Orbit needs approval', 'Disk is full']);
  assert.equal(queue.filter(entry => !entry.important && entry.tone !== 'danger').length, TOAST_QUEUE_MAX);
  // Arriving last into a full queue, it is still kept.
  queue = queueToast({ holding: true, queue }, { text: 'Atlas needs your answer', important: true }, false).queue;
  assert.equal(queue.at(-1).text, 'Atlas needs your answer');
});

test('toastTitle: bounded to TOAST_TITLE_CHARS with an ellipsis', () => {
  assert.equal(toastTitle('short'), 'short');
  const title = toastTitle('x'.repeat(8192));
  assert.equal(title.length, TOAST_TITLE_CHARS);
  assert.ok(title.endsWith('…'));
});
