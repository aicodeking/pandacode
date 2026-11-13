/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { runningTerminal, scriptState } from '../src/store/run-script.ts';

test('scriptState records whether the host reported a running terminal', () => {
  assert.deepEqual(scriptState({ script: null, running: null }), { script: null, running: null, reportsRunning: true });
  assert.deepEqual(scriptState({ script: { path: 'run.sh' }, running: { terminalId: 't1' } }), { script: { path: 'run.sh' }, running: 't1', reportsRunning: true });
  assert.deepEqual(scriptState({ script: null }), { script: null, running: null, reportsRunning: false });
  assert.deepEqual(scriptState(null), { script: null, running: null, reportsRunning: false });
  assert.equal(scriptState({ running: { terminalId: '' } }).running, null);
  assert.equal(scriptState({ running: { terminalId: 7 } }).running, null);
});

test('a host that reports running is the only word: null means it ended, even after this Start', () => {
  assert.equal(runningTerminal(scriptState({ running: null }), 'opened'), null);
  assert.equal(runningTerminal(scriptState({ running: { terminalId: 'host' } }), 'opened'), 'host');
  assert.equal(runningTerminal(scriptState({ running: { terminalId: 'host' } }), null), 'host');
});

test('an older host (no running key) falls back to the terminal this screen opened', () => {
  assert.equal(runningTerminal(scriptState({ script: null }), 'opened'), 'opened');
  assert.equal(runningTerminal(scriptState({ script: null }), null), null);
  assert.equal(runningTerminal(undefined, 'opened'), 'opened');
});
