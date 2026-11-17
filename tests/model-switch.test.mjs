import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// model-switch.ts talks to native through './bridge': answer its calls here (`calls`), and give it the window it listens on.
const bridge = 'export const call = (command, args) => globalThis.__modelSwitchCall(command, args);';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === './bridge' && context.parentURL?.endsWith('/src/model-switch.ts')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(bridge)}), shortCircuit: true };
  return next(specifier, context);
}`));
globalThis.window ??= { addEventListener() {} };
const replies = [];
globalThis.__modelSwitchCall = (command, args) => {
  if (command === 'start_ahead_get') return Promise.resolve({ on: false });
  return new Promise((resolve, reject) => replies.push({ command, args, resolve, reject }));
};
const switcher = await import('../src/model-switch.ts');

const tasks = new Map();
switcher.initModelSwitch({
  setBusy() {}, pickerOpening: () => false, notify() {}, task: id => tasks.get(id), put: task => tasks.set(task.id, task),
  team: () => undefined, teamChanged() {}, autoTeam: base => Promise.resolve(base), releaseAccount: () => Promise.resolve(),
  label: task => task.model, effortName: task => task.reasoningEffort ?? '', pickerShown: () => false, remember() {},
});
const stored = (id, values = {}) => ({ id, provider: 'claude', model: 'sonnet', reasoningEffort: 'low', codexSettings: null, contextUsage: null, mode: 'ask', title: 'Task', ...values });
const ui = { show() {}, repaint() {} };
const reply = async (command, outcome) => {
  for (let i = 0; i < 20 && !replies.some(entry => entry.command === command); i += 1) await new Promise(resolve => setImmediate(resolve));
  const index = replies.findIndex(entry => entry.command === command);
  assert.ok(index >= 0, `a ${command} call`);
  const [entry] = replies.splice(index, 1);
  if (outcome instanceof Error) entry.reject(outcome); else entry.resolve(outcome(entry.args));
};

/** A read held open for `run` (a listing or get_task in flight), ended even when an assertion fails. */
const whileReading = async run => { const read = switcher.beginRead(); try { return await run(read); } finally { read.end(); } };

test('a listing read before a model pick saved keeps the picked model; one read after the save is believed', async () => {
  tasks.set('a', stored('a'));
  await whileReading(async stale => {
    const saving = switcher.pickModel('a', { provider: 'codex', model: 'astra', warm: false, local: true }, ui);
    // Landing mid-save, it still lists the old harness and model.
    const midSave = stale.hold({ ...stored('a'), title: 'Renamed' });
    assert.deepEqual([midSave.provider, midSave.model, midSave.reasoningEffort, midSave.title], ['codex', 'astra', null, 'Renamed']);
    // A listing that started after the pick but read before native stored it: still held while the pick saves.
    await whileReading(read => assert.equal(read.hold(stored('a')).model, 'astra'));
    await reply('configure_session', args => stored('a', { provider: args.provider, model: args.model, reasoningEffort: null }));
    assert.equal(await saving, true);
    // Landing after the save: the old read still cannot put the old model back.
    assert.equal(stale.hold(stored('a')).model, 'astra');
    // A listing read after the save says what native has, even a later change made elsewhere.
    await whileReading(read => assert.equal(read.hold(stored('a', { provider: 'codex', model: 'other' })).model, 'other'));
  });
});

test('a refused pick goes back once, and a listing read before it shows the same model', async () => {
  tasks.set('b', stored('b'));
  await whileReading(async stale => {
    const saving = switcher.pickModel('b', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
    assert.equal(tasks.get('b').model, 'opus');
    await reply('configure_session', new Error('Stop the agent first.'));
    assert.equal(await saving, false);
    assert.equal(tasks.get('b').model, 'sonnet');
    assert.equal(stale.hold(stored('b')).model, 'sonnet');
  });
});

test('an effort change holds only the effort: another field changed elsewhere still shows', async () => {
  tasks.set('c', stored('c'));
  await whileReading(async stale => {
    const saving = switcher.pickEffort('c', 'high', { warm: false, paint() {} });
    const listed = stale.hold(stored('c', { model: 'opus', mode: 'full' }));
    assert.deepEqual([listed.reasoningEffort, listed.model, listed.mode], ['high', 'opus', 'full']);
    await reply('set_reasoning_effort', args => stored('c', { reasoningEffort: args.reasoningEffort }));
    await saving;
    assert.equal(stale.hold(stored('c')).reasoningEffort, 'high');
    await whileReading(read => assert.equal(read.hold(stored('c')).reasoningEffort, 'low'));
  });
});

test('a task with no pick is listed as read', async () => {
  tasks.set('d', stored('d'));
  const listed = stored('d', { model: 'opus' });
  await whileReading(read => assert.equal(read.hold(listed), listed));
});

// Every native reply that replaces a task in state (get_task for a goal or a board edit, an update's answer, a listing)
// goes through readTasks, so a pick made while it ran, or still saving, is not undone by it.
/** A native call answering with `answer` once released. */
const pendingCall = answer => { let release; const done = new Promise(resolve => { release = () => resolve(answer()); }); return { done, release }; };

test('readTasks: a get_task begun before a pick that saved meanwhile keeps the picked model', async () => {
  tasks.set('e', stored('e', { mode: 'ask' }));
  const read = pendingCall(() => stored('e', { title: 'Goal set', mode: 'full' }));
  const reading = switcher.readTasks(() => read.done);
  const saving = switcher.pickModel('e', { provider: 'codex', model: 'astra', warm: false, local: true }, ui);
  await reply('configure_session', args => stored('e', { provider: args.provider, model: args.model, reasoningEffort: null }));
  assert.equal(await saving, true);
  read.release();
  const task = await reading;
  // The pick's fields stay; what the read says about everything else (a title, permissions changed elsewhere) is taken.
  assert.deepEqual([task.provider, task.model, task.title, task.mode], ['codex', 'astra', 'Goal set', 'full']);
  assert.equal(switcher.markedTasks(), 0, 'no read open: no marks kept');
});

test('readTasks: a reply landing while a pick saves keeps it; lists are held task by task; other replies pass through', async () => {
  tasks.set('f', stored('f'));
  tasks.set('g', stored('g'));
  const saving = switcher.pickModel('f', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const one = await switcher.readTasks(async () => stored('f', { title: 'Edited' }));
  assert.deepEqual([one.model, one.title], ['opus', 'Edited']);
  const otherTask = stored('g', { model: 'haiku' });
  const [held, untouched] = await switcher.readTasks(async () => [stored('f'), otherTask]);
  assert.equal(held.model, 'opus');
  assert.equal(untouched, otherTask, 'a task with no pick comes back as read');
  // Replies that are not tasks (a goal, a bot, nothing) are returned as they are, even with a task's id.
  const notTask = { id: 'f', model: 'sonnet' };
  assert.equal(await switcher.readTasks(async () => notTask), notTask);
  assert.equal(await switcher.readTasks(async () => null), null);
  await reply('configure_session', args => stored('f', { provider: args.provider, model: args.model }));
  assert.equal(await saving, true);
  // Saved: a read now is believed.
  assert.equal((await switcher.readTasks(async () => stored('f', { model: 'other' }))).model, 'other');
});

test('readTasks: a failed read ends and keeps no marks', async () => {
  tasks.set('h', stored('h'));
  let fail;
  const read = switcher.readTasks(() => new Promise((_, reject) => { fail = reject; }));
  const saving = switcher.pickEffort('h', 'high', { warm: false, paint() {} });
  await reply('set_reasoning_effort', args => stored('h', { reasoningEffort: args.reasoningEffort }));
  await saving;
  assert.equal(switcher.markedTasks(), 1, 'the open read began before the pick');
  fail(new Error('gone'));
  await assert.rejects(read, /gone/);
  assert.equal(switcher.markedTasks(), 0);
});

test('marks: kept only while a read could predate them, and dropped for deleted tasks', async () => {
  tasks.set('i', stored('i'));
  tasks.set('j', stored('j'));
  // No read open: a pick leaves nothing to remember.
  const first = switcher.pickEffort('i', 'high', { warm: false, paint() {} });
  await reply('set_reasoning_effort', args => stored('i', { reasoningEffort: args.reasoningEffort }));
  await first;
  assert.equal(switcher.markedTasks(), 0);
  const open = switcher.beginRead();
  try {
    const efforts = [switcher.pickEffort('i', 'low', { warm: false, paint() {} }), switcher.pickEffort('j', 'low', { warm: false, paint() {} })];
    await reply('set_reasoning_effort', args => stored('i', { reasoningEffort: args.reasoningEffort }));
    await reply('set_reasoning_effort', args => stored('j', { reasoningEffort: args.reasoningEffort }));
    await Promise.all(efforts);
    assert.equal(switcher.markedTasks(), 2, 'an open read began before both picks');
    // A read begun after them, ending, keeps the older read's marks.
    switcher.beginRead().end();
    assert.equal(switcher.markedTasks(), 2);
    switcher.forgetTasks(['j']);
    assert.equal(switcher.markedTasks(), 1, 'a deleted task loses its marks');
  } finally { open.end(); }
  assert.equal(switcher.markedTasks(), 0, 'the last read ended: nothing could predate the picks');
  open.end();
  assert.equal(switcher.markedTasks(), 0, 'ending twice is harmless');
});

// A redrawn busy control's CSS pulse starts on its own clock; joinPulses puts it on the shared phase (startTime 0) at once.
const fakeAnimation = (animationName, startTime) => ({ animationName, startTime });
/** A composer or control: `busy` when something under it is aria-busy (the only pulses joinPulses aligns). */
const fakeRoot = (animations, busy = true) => ({
  matches: () => false, querySelector: selector => { assert.equal(selector, '[aria-busy="true"]'); return busy ? {} : null; },
  getAnimations: options => { assert.deepEqual(options, { subtree: true }); return animations; },
});

test('joinPulses puts every state pulse under the root on the shared phase and leaves other animations alone', () => {
  const fresh = fakeAnimation('state-pulse', null), late = fakeAnimation('state-pulse', 812.5), other = fakeAnimation('glide', 300);
  switcher.joinPulses(fakeRoot([fresh, late, other]));
  assert.deepEqual([fresh.startTime, late.startTime, other.startTime], [0, 0, 300]);
});

test('joinPulses does not touch a pulse already in phase', () => {
  let sets = 0;
  const aligned = { animationName: 'state-pulse', get startTime() { return 0; }, set startTime(_) { sets += 1; } };
  switcher.joinPulses(fakeRoot([aligned]));
  assert.equal(sets, 0);
});

test('joinPulses with no root, or none to align (reduced motion has no pulses), does nothing', () => {
  assert.doesNotThrow(() => switcher.joinPulses(null));
  assert.doesNotThrow(() => switcher.joinPulses(undefined));
  assert.doesNotThrow(() => switcher.joinPulses(fakeRoot([])));
});

test('joinPulses skips walking animations unless something under the root is busy', () => {
  let walked = 0;
  const idle = { matches: () => false, querySelector: () => null, getAnimations: () => { walked += 1; return []; } };
  switcher.joinPulses(idle);
  assert.equal(walked, 0);
  // A control marked busy itself (holdSend's button) is a root that matches.
  const pulse = fakeAnimation('state-pulse', 40);
  switcher.joinPulses({ matches: () => true, querySelector: () => null, getAnimations: () => [pulse] });
  assert.equal(pulse.startTime, 0);
});
