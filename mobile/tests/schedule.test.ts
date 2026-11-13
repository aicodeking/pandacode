/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { editState, onceChoice, threadOptions, watchOptions, withSaved } from '../src/ui/schedule-form.ts';

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 10, 9, 0).getTime();
const PRESETS = [{ label: 'In 1 hour', hours: 1 }, { label: 'In 1 day', hours: 24 }];
const fmt = (at: number) => `@${at}`;
const tasks = [
  { sessionId: 'a', projectId: 'p', title: 'Alpha' },
  { sessionId: 'b', projectId: 'p', title: 'Beta' },
  { sessionId: 'c', projectId: 'q', title: '' },
];

test('withSaved appends a missing saved value once, with a fallback label', () => {
  const base = [{ value: 'a', label: 'Alpha' }];
  assert.deepEqual(withSaved(base, 'a', 'Other'), base);
  assert.deepEqual(withSaved(base, 'z', '  '), [...base, { value: 'z', label: 'Untitled thread' }]);
  assert.deepEqual(withSaved(base, '', 'x'), base);
  assert.equal(base.length, 1, 'never mutates');
});

test('threadOptions keeps the schedule’s own thread when the recent list lacks it', () => {
  assert.deepEqual(threadOptions(tasks).map(o => o.label), ['Alpha', 'Beta', 'Untitled thread']);
  const saved = threadOptions(tasks, { sessionId: 'old', sessionTitle: 'Nightly report' });
  assert.deepEqual(saved.at(-1), { value: 'old', label: 'Nightly report' }, 'a title, never the raw id');
  assert.equal(threadOptions(tasks, { sessionId: 'a', sessionTitle: 'Alpha' }).length, 3);
});

test('watchOptions adds the saved watched thread only while the saved thread is picked', () => {
  const saved = { sessionId: 'old', watchSessionId: 'w', watchSessionTitle: 'Build' };
  assert.deepEqual(watchOptions(tasks, 'old', saved), [{ value: 'w', label: 'Build' }]);
  assert.deepEqual(watchOptions(tasks, 'a', saved).map(o => o.value), ['b'], 'another thread drops it');
  assert.deepEqual(watchOptions(tasks, 'a', { sessionId: 'a', watchSessionId: 'b', watchSessionTitle: 'Beta' }).map(o => o.value), ['b']);
  assert.deepEqual(watchOptions(tasks, 'a', { sessionId: 'a', watchSessionId: null, watchSessionTitle: null }).map(o => o.value), ['b']);
});

test('onceChoice selects a matching preset', () => {
  const { options, value } = onceChoice(PRESETS, NOW, NOW + HOUR + 60_000, true, fmt);
  assert.equal(options.length, 2);
  assert.equal(value, String(NOW + HOUR));
});

test('onceChoice keeps a saved time no preset matches, selected and first', () => {
  const at = NOW + 5 * HOUR;
  const { options, value } = onceChoice(PRESETS, NOW, at, true, fmt);
  assert.deepEqual(options[0], { value: String(at), label: `Keep: @${at}` });
  assert.equal(value, String(at));
});

test('onceChoice without a saved time falls back to the first preset', () => {
  const { options, value } = onceChoice(PRESETS, NOW, NOW + 5 * HOUR, false, fmt);
  assert.equal(options.length, 2);
  assert.equal(value, String(NOW + HOUR));
});

test('editState waits for the schedule list before an edit can save', () => {
  assert.equal(editState(undefined, false, false), 'new');
  assert.equal(editState('s', false, false), 'loading');
  assert.equal(editState('s', true, true), 'ready');
  assert.equal(editState('s', true, false), 'missing');
});
