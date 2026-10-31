import test from 'node:test';
import assert from 'node:assert/strict';

// The pure parts of the updater: modes, when a downloaded update may restart the app, and what About says.
const { readyToRestart, restartNow, downloadsOnItsOwn, parseUpdateMode, updatePrompt, describeUpdate, IDLE_BEFORE_RESTART } = await import('../src/app-updates-policy.ts');

test('a downloaded update restarts only when no agent works and the user stepped away', () => {
  const now = 10_000_000;
  assert.equal(readyToRestart(false, now - IDLE_BEFORE_RESTART, now), true);
  assert.equal(readyToRestart(false, now - IDLE_BEFORE_RESTART + 1, now), false);
  assert.equal(readyToRestart(true, now - 60 * 60_000, now), false);
});

test('the old boolean preference keeps its behavior', () => {
  assert.equal(parseUpdateMode(null), 'automatic');
  assert.equal(parseUpdateMode('on'), 'automatic');
  assert.equal(parseUpdateMode('off'), 'off');
  assert.equal(parseUpdateMode('notify'), 'notify');
  assert.equal(parseUpdateMode('automatic'), 'automatic');
  assert.equal(parseUpdateMode('junk'), 'automatic');
});

test('only Automatic on an installable copy downloads by itself', () => {
  assert.equal(downloadsOnItsOwn('automatic', true), true);
  assert.equal(downloadsOnItsOwn('automatic', false), false);
  assert.equal(downloadsOnItsOwn('notify', true), false);
  assert.equal(downloadsOnItsOwn('off', true), false);
});

test('Notify me restarts only after Install and restart, and never over a running agent', () => {
  const now = 10_000_000, idle = now - IDLE_BEFORE_RESTART, active = now;
  assert.equal(restartNow('notify', false, false, idle, now), false);
  assert.equal(restartNow('notify', true, false, active, now), true);
  assert.equal(restartNow('notify', true, true, idle, now), false);
  assert.equal(restartNow('automatic', false, false, idle, now), true);
  assert.equal(restartNow('automatic', false, false, active, now), false);
  assert.equal(restartNow('automatic', true, true, idle, now), false);
  assert.equal(restartNow('off', false, false, idle, now), false);
});

test('the header prompt offers Install and restart / Later until dismissed', () => {
  const available = { kind: 'available', version: '0.3.40' };
  assert.deepEqual(updatePrompt(available, true, null), { label: 'Install and restart', title: 'PandaCode 0.3.40 is available. Installs when your agents are done.', later: true });
  assert.equal(updatePrompt(available, true, '0.3.40'), null);
  assert.ok(updatePrompt(available, true, '0.3.39'));
  assert.match(updatePrompt(available, false, null).title, /GitHub Releases/);
  assert.equal(updatePrompt({ kind: 'ready', version: '0.3.40' }, true, '0.3.40').label, 'Restart to update');
  assert.equal(updatePrompt({ kind: 'checking' }, true, null), null);
});

test('About explains each state in one line', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(describeUpdate({ kind: 'current', checkedAt: now - 5 * 60_000 }, 'automatic', now), 'Up to date · checked 5m ago');
  assert.equal(describeUpdate({ kind: 'downloading', version: '0.3.1', percent: 42 }, 'automatic'), 'Downloading 0.3.1 · 42%');
  assert.match(describeUpdate({ kind: 'ready', version: '0.3.1' }, 'automatic'), /^0\.3\.1 is ready\. PandaCode restarts when your agents are done/);
  assert.equal(describeUpdate({ kind: 'ready', version: '0.3.1' }, 'notify'), '0.3.1 is ready. Restart to finish.');
  assert.equal(describeUpdate({ kind: 'idle' }, 'off'), 'Automatic updates are off.');
  assert.equal(describeUpdate({ kind: 'idle' }, 'notify'), 'Checks GitHub Releases automatically.');
  assert.match(describeUpdate({ kind: 'available', version: '0.3.1' }, 'automatic', now, false), /installed by its package or a new AppImage/);
  assert.match(describeUpdate({ kind: 'error', message: 'offline' }, 'automatic'), /offline$/);
});
