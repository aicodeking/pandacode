import test from 'node:test';
import assert from 'node:assert/strict';

// The pure half of desktop notifications: what an event may do given the settings and focus,
// and how a batch of requests within the window becomes one notice.
const { DEFAULT_SETTINGS, COALESCE_MS, gate, flushGate, soundOf, notice, batchNotice, createCoalescer, readSettings, saveSetting } = await import('../src/notifications-model.ts');

/** Fake clock and timer queue: a coalescer driven by hand, no real waits. */
function fakeHost() {
  const timers = [];
  let now = 1_000;
  const flushed = [];
  const host = {
    now: () => now,
    schedule(run, ms) { const timer = { run, at: now + ms }; timers.push(timer); return timer; },
    cancel(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    flush(batch) { flushed.push(batch); },
  };
  return {
    host,
    flushed,
    tick(ms) {
      now += ms;
      const due = timers.filter(timer => timer.at <= now);
      for (const timer of due) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); timer.run(); }
    },
    pending: () => timers.length,
  };
}

test('defaults notify about approvals and questions while unfocused, nothing else', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: true, approval: true, input: true, finished: false, failed: false,
    soundWhenFocused: false, sound: 'Glass', hideDetails: false,
  });
});

test('an unfocused event with the master on shows a banner for each enabled kind', () => {
  assert.equal(gate('approval', DEFAULT_SETTINGS, false), 'banner');
  assert.equal(gate('input', DEFAULT_SETTINGS, false), 'banner');
  assert.equal(gate('done', DEFAULT_SETTINGS, false), null);
  assert.equal(gate('failed', DEFAULT_SETTINGS, false), null);
  assert.equal(gate('done', { ...DEFAULT_SETTINGS, finished: true }, false), 'banner');
  assert.equal(gate('failed', { ...DEFAULT_SETTINGS, failed: true }, false), 'banner');
});

test('the master switch off silences every banner, however the per-event switches sit', () => {
  const off = { ...DEFAULT_SETTINGS, enabled: false, finished: true, failed: true };
  assert.equal(gate('approval', off, false), null);
  assert.equal(gate('input', off, false), null);
  assert.equal(gate('done', off, false), null);
  assert.equal(gate('failed', off, false), null);
});

test('a focused event never shows a banner; a chime needs the focused-sound switch and a sound', () => {
  assert.equal(gate('approval', DEFAULT_SETTINGS, true), null);
  assert.equal(gate('input', DEFAULT_SETTINGS, true), null);
  assert.equal(gate('done', { ...DEFAULT_SETTINGS, finished: true }, true), null);
  assert.equal(gate('approval', { ...DEFAULT_SETTINGS, soundWhenFocused: true }, true), 'sound');
  assert.equal(gate('input', { ...DEFAULT_SETTINGS, soundWhenFocused: true }, true), 'sound');
  // No sound chosen: nothing happens while focused.
  assert.equal(gate('approval', { ...DEFAULT_SETTINGS, soundWhenFocused: true, sound: 'None' }, true), 'sound');
  assert.equal(soundOf({ ...DEFAULT_SETTINGS, sound: 'None' }), undefined);
  assert.equal(soundOf(DEFAULT_SETTINGS), 'Glass');
});

test('per-event switches can be turned off on their own', () => {
  assert.equal(gate('approval', { ...DEFAULT_SETTINGS, approval: false }, false), null);
  assert.equal(gate('input', { ...DEFAULT_SETTINGS, input: false }, false), null);
});

test('settings read and write through the pandacode.notifications. prefix', () => {
  const backing = new Map();
  const storage = { getItem: key => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) };
  assert.deepEqual(readSettings(storage), DEFAULT_SETTINGS);
  saveSetting(storage, 'finished', true);
  saveSetting(storage, 'sound', 'Frog');
  assert.deepEqual(readSettings(storage), { ...DEFAULT_SETTINGS, finished: true, sound: 'Frog' });
  // A bad stored sound falls back to the default, never to an unknown name.
  saveSetting(storage, 'sound', 'Bogus');
  assert.equal(readSettings(storage).sound, 'Glass');
});

test('a single request names the task; privacy keeps the task out', () => {
  const request = { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 };
  assert.deepEqual(notice('approval', 'Fix the flaky test', false), { title: 'Fix the flaky test needs approval', body: 'Review it in PandaCode.' });
  assert.deepEqual(notice('input', 'Fix the flaky test', false), { title: 'Fix the flaky test needs your answer', body: 'Reply in PandaCode.' });
  assert.deepEqual(notice('done', 'Fix the flaky test', false), { title: 'Fix the flaky test finished', body: 'Task finished.' });
  assert.deepEqual(notice('failed', 'Fix the flaky test', false), { title: 'Fix the flaky test failed', body: 'See PandaCode for the error.' });
  assert.deepEqual(notice('approval', 'Fix the flaky test', true), { title: 'PandaCode needs you', body: 'Open PandaCode to respond.' });
  assert.deepEqual(batchNotice([request], true), { title: 'PandaCode needs you', body: 'Open PandaCode to respond.', sessionId: 's1' });
});

test('three rapid approvals for one task coalesce into one counted notice', () => {
  const batch = [
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 },
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 1_000 },
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 2_000 },
  ];
  assert.deepEqual(batchNotice(batch, false), { title: 'Fix the flaky test needs you', body: '3 approvals waiting', sessionId: 's1' });
  const mixed = [
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 },
    { kind: 'input', sessionId: 's2', title: 'Pick a name', at: 1_000 },
  ];
  assert.deepEqual(batchNotice(mixed, false), { title: 'Tasks need your attention', body: '2 requests waiting' });
});

test('privacy hides the task name but a batch for one task still carries its click payload', () => {
  const one = [
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 },
    { kind: 'input', sessionId: 's1', title: 'Fix the flaky test', at: 1_000 },
  ];
  assert.deepEqual(batchNotice(one, true), { title: 'PandaCode needs you', body: '2 requests waiting', sessionId: 's1' });
  const across = [
    { kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 },
    { kind: 'approval', sessionId: 's2', title: 'Pick a name', at: 1_000 },
  ];
  const notice2 = batchNotice(across, true);
  assert.equal(notice2.sessionId, undefined);
  assert.ok(!('sessionId' in notice2), 'a multi-task batch has no task to open');
});

test('the batch is gated again when its window ends, not only when it was queued', () => {
  const batch = [{ kind: 'approval', sessionId: 's1', title: 'Fix the flaky test', at: 0 }];
  // Unfocused at both ends: the banner shows.
  assert.equal(flushGate(batch, DEFAULT_SETTINGS, false), 'banner');
  // The app was focused by the time the window ended: downgraded to the chosen sound alone,
  // or dropped when that switch is off.
  assert.equal(flushGate(batch, DEFAULT_SETTINGS, true), null);
  assert.equal(flushGate(batch, { ...DEFAULT_SETTINGS, soundWhenFocused: true }, true), 'sound');
  // Notifications were turned off while the requests waited: nothing shows.
  assert.equal(flushGate(batch, { ...DEFAULT_SETTINGS, enabled: false }, false), null);
  // A kind switched off mid-window does not keep the batch alive on the back of the others.
  const both = [
    { kind: 'approval', sessionId: 's1', title: 'A', at: 0 },
    { kind: 'input', sessionId: 's2', title: 'B', at: 1_000 },
  ];
  assert.equal(flushGate(both, { ...DEFAULT_SETTINGS, approval: false, input: false }, false), null);
});

test('a batch holds its requests until the window passes, then sends one flush', () => {
  const fake = fakeHost();
  const coalescer = createCoalescer(fake.host, COALESCE_MS);
  coalescer.add('approval', 's1', 'Fix the flaky test');
  coalescer.add('approval', 's1', 'Fix the flaky test');
  coalescer.add('input', 's1', 'Fix the flaky test');
  assert.equal(fake.flushed.length, 0);
  assert.equal(fake.pending(), 1, 'one timer for the whole batch');
  fake.tick(COALESCE_MS);
  assert.equal(fake.flushed.length, 1);
  assert.equal(fake.flushed[0].length, 3);
  assert.equal(fake.pending(), 0);
});

test('requests keep arriving through the window and all leave in the one flush', () => {
  const fake = fakeHost();
  const coalescer = createCoalescer(fake.host, COALESCE_MS);
  coalescer.add('approval', 's1', 'A');
  fake.tick(2_000);
  coalescer.add('approval', 's2', 'B');
  fake.tick(2_000);
  coalescer.add('input', 's3', 'C');
  assert.equal(fake.flushed.length, 0);
  fake.tick(COALESCE_MS);
  assert.equal(fake.flushed.length, 1);
  assert.equal(fake.flushed[0].length, 3);
});

test('flushNow sends what is pending at once and nothing after it', () => {
  const fake = fakeHost();
  const coalescer = createCoalescer(fake.host, COALESCE_MS);
  coalescer.add('approval', 's1', 'A');
  coalescer.flushNow();
  assert.equal(fake.flushed.length, 1);
  assert.equal(fake.pending(), 0);
  coalescer.flushNow();
  assert.equal(fake.flushed.length, 1, 'an empty flush sends nothing');
});

test('a cancelled request leaves the batch before the window ends, and the count follows', () => {
  const fake = fakeHost();
  const coalescer = createCoalescer(fake.host, COALESCE_MS);
  coalescer.add('approval', 's1', 'A', 'r-1');
  coalescer.add('approval', 's1', 'A', 'r-2');
  coalescer.cancel('approval', 's1', 'r-1');
  coalescer.cancel('approval', 's2', 'r-9');
  fake.tick(COALESCE_MS);
  assert.equal(fake.flushed.length, 1, 'the surviving request still notifies');
  assert.equal(fake.flushed[0].length, 1);
  assert.equal(fake.flushed[0][0].requestId, 'r-2');
  // Cancelling every request empties the batch, and the timer then sends nothing.
  const quiet = fakeHost();
  const alone = createCoalescer(quiet.host, COALESCE_MS);
  alone.add('approval', 's1', 'A', 'r-1');
  alone.cancel('approval', 's1', 'r-1');
  quiet.tick(COALESCE_MS);
  assert.equal(quiet.flushed.length, 0);
});
