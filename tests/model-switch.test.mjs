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
/** Named teams by task, the notices shown, and the tasks whose account binding was released. */
const teams = new Map(), notices = [], releases = [], remembered = [];
switcher.initModelSwitch({
  setBusy() {}, pickerOpening: () => false, notify: text => notices.push(text), task: id => tasks.get(id), put: task => tasks.set(task.id, task),
  team: id => teams.get(id), teamChanged: event => { if (event.removed) teams.delete(event.sessionId); else teams.set(event.sessionId, event.config); },
  autoTeam: base => Promise.resolve(base), releaseAccount: id => { releases.push(id); return Promise.resolve(); },
  label: task => task.model, effortName: task => task.reasoningEffort ?? '', pickerShown: () => false, remember: choice => remembered.push(choice),
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

test('two model picks saving: the first to finish leaves the other held, and settled waits for both', async () => {
  tasks.set('k', stored('k'));
  const first = switcher.pickModel('k', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('k', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  let settled = false;
  const waiting = switcher.settled('k').then(() => { settled = true; });
  await reply('configure_session', args => stored('k', { model: args.model }));
  assert.equal(await first, true);
  // The first reply does not paint over the second pick, which still saves: a read now (native has not stored it) keeps it.
  assert.equal(tasks.get('k').model, 'haiku');
  assert.equal((await switcher.readTasks(async () => stored('k', { model: 'opus' }))).model, 'haiku');
  assert.equal(switcher.saving('k'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'still saving the second pick');
  await reply('configure_session', args => stored('k', { model: args.model }));
  assert.equal(await second, true);
  await waiting;
  assert.equal(switcher.saving('k'), false);
  assert.equal((await switcher.readTasks(async () => stored('k', { model: 'other' }))).model, 'other');
});

test('an older pick refused while a newer one saves leaves the newer one shown and lets it decide', async () => {
  tasks.set('n', stored('n'));
  const first = switcher.pickModel('n', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('n', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await first, false);
  assert.equal(tasks.get('n').model, 'haiku');
  await reply('configure_session', args => stored('n', { model: args.model }));
  assert.equal(await second, true);
  assert.equal(await switcher.settledChange('n'), null, 'the newest pick saved: nothing refused');
});

test('a speed change answering while a model change saves is believed for codexSettings, held for the model', async () => {
  tasks.set('l', stored('l', { provider: 'codex', model: 'astra', codexSettings: { serviceTier: null } }));
  const saving = switcher.pickModel('l', { provider: 'codex', model: 'nova', warm: false, local: true }, ui);
  const owned = switcher.fieldsWrittenBy('set_task_preference');
  assert.deepEqual(owned, ['codexSettings']);
  const fast = { serviceTier: 'fast' };
  const answered = await switcher.readTasks(async () => stored('l', { provider: 'codex', model: 'astra', codexSettings: fast }), owned);
  assert.deepEqual([answered.model, answered.codexSettings], ['nova', fast]);
  // Any other read still holds codexSettings while the model saves.
  assert.deepEqual((await switcher.readTasks(async () => stored('l', { provider: 'codex', codexSettings: { serviceTier: 'slow' } }))).codexSettings, { serviceTier: null });
  assert.deepEqual(switcher.fieldsWrittenBy('get_task'), []);
  // main.ts puts the reply in state; the model change is then refused: the speed saved meanwhile stays.
  tasks.set('l', answered);
  await reply('configure_session', new Error('Stop the agent first.'));
  assert.equal(await saving, false);
  assert.deepEqual([tasks.get('l').model, tasks.get('l').codexSettings], ['astra', fast]);
});

test('a refused pick to another harness restores the codexSettings it cleared', async () => {
  const settings = { serviceTier: 'fast' };
  tasks.set('m', stored('m', { provider: 'codex', model: 'astra', codexSettings: settings }));
  const saving = switcher.pickModel('m', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  assert.equal(tasks.get('m').codexSettings, null);
  await reply('configure_session', new Error('No.'));
  assert.equal(await saving, false);
  assert.deepEqual([tasks.get('m').provider, tasks.get('m').codexSettings], ['codex', settings]);
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

/* ----- Model and permission saves go to native one at a time, in pick order ----- */
/** Lets queued saves start their next native call. */
const ticks = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const pending = command => replies.filter(entry => entry.command === command);

test('two model picks: the newer is not sent until the older lands, so it cannot finish first or be stored before it', async () => {
  tasks.set('p', stored('p'));
  let native = 'sonnet';
  const first = switcher.pickModel('p', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('p', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  assert.equal(tasks.get('p').model, 'haiku', 'the newest pick shows at once');
  await ticks();
  assert.deepEqual(pending('configure_session').map(entry => entry.args.model), ['opus'], 'only the older pick is in flight');
  let settled = false;
  const waiting = switcher.settled('p').then(() => { settled = true; });
  await reply('configure_session', args => { native = args.model; return stored('p', { model: args.model }); });
  assert.equal(await first, true);
  assert.equal(switcher.saving('p'), true, 'the newer pick still saves');
  assert.equal(tasks.get('p').model, 'haiku');
  await ticks();
  assert.equal(settled, false);
  assert.deepEqual(pending('configure_session').map(entry => entry.args.model), ['haiku']);
  await reply('configure_session', args => { native = args.model; return stored('p', { model: args.model }); });
  assert.equal(await second, true);
  await waiting;
  assert.equal(switcher.saving('p'), false);
  assert.deepEqual([native, tasks.get('p').model], ['haiku', 'haiku'], 'native stored the newest pick last');
});

test('two model picks: the older refused, the newer still waits its turn and decides what shows', async () => {
  tasks.set('q', stored('q'));
  let native = 'sonnet';
  const first = switcher.pickModel('q', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('q', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  await ticks();
  assert.equal(pending('configure_session').length, 1);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await first, false);
  assert.equal(switcher.saving('q'), true);
  assert.equal(tasks.get('q').model, 'haiku');
  await reply('configure_session', args => { native = args.model; return stored('q', { model: args.model }); });
  assert.equal(await second, true);
  assert.deepEqual([native, tasks.get('q').model], ['haiku', 'haiku']);
  assert.equal(await switcher.settledChange('q'), null);
});

test('two model picks both refused go back to the model native has, not the older pick', async () => {
  tasks.set('r', stored('r'));
  const first = switcher.pickModel('r', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('r', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  await reply('configure_session', new Error('Busy.'));
  await reply('configure_session', new Error('Still busy.'));
  assert.deepEqual([await first, await second], [false, false]);
  assert.equal(tasks.get('r').model, 'sonnet');
});

test('a model pick made while a permission pick saves goes after it; both keep the task saving until the last lands', async () => {
  tasks.set('s', stored('s'));
  const modeUi = { warm: false, paint() {}, name: mode => mode, trigger: () => null };
  const mode = switcher.pickMode('s', 'full', modeUi);
  const model = switcher.pickModel('s', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  await ticks();
  assert.equal(pending('configure_session').length, 0, 'the model waits for the permission save');
  assert.equal(switcher.modeBusy('s'), true);
  await reply('update_session', () => null);
  assert.equal(await mode, true);
  assert.equal(switcher.saving('s'), true);
  assert.equal(switcher.modeBusy('s'), false);
  await reply('configure_session', args => stored('s', { model: args.model, mode: 'full' }));
  assert.equal(await model, true);
  assert.equal(switcher.saving('s'), false);
  assert.deepEqual([tasks.get('s').model, tasks.get('s').mode], ['opus', 'full']);
});

test('two permission picks: the older refused leaves the newer shown and busy; both refused go back to the saved one', async () => {
  tasks.set('t', stored('t', { mode: 'ask' }));
  const modeUi = { warm: false, paint() {}, name: mode => mode, trigger: () => null };
  const first = switcher.pickMode('t', 'full', modeUi);
  const second = switcher.pickMode('t', 'plan', modeUi);
  await ticks();
  assert.deepEqual(pending('update_session').map(entry => entry.args.mode), ['full']);
  await reply('update_session', new Error('Busy.'));
  assert.equal(await first, false);
  assert.equal(tasks.get('t').mode, 'plan');
  assert.equal(switcher.modeBusy('t'), true, 'the newer permission pick still saves');
  await reply('update_session', new Error('Still busy.'));
  assert.equal(await second, false);
  assert.equal(tasks.get('t').mode, 'ask');
  assert.equal(switcher.modeBusy('t'), false);
});

test('every command that writes pick fields is authoritative for them in its own reply', () => {
  assert.deepEqual([...switcher.fieldsWrittenBy('configure_session')].sort(), ['codexSettings', 'contextUsage', 'model', 'provider', 'reasoningEffort']);
  assert.deepEqual(switcher.fieldsWrittenBy('set_reasoning_effort'), ['reasoningEffort']);
});

test('a configure_session answering (a bot’s model) while a pick saves is believed for the model fields', async () => {
  tasks.set('u', stored('u'));
  const saving = switcher.pickEffort('u', 'high', { warm: false, paint() {} });
  const answered = await switcher.readTasks(async () => stored('u', { provider: 'codex', model: 'astra', reasoningEffort: 'medium' }), switcher.fieldsWrittenBy('configure_session'));
  assert.deepEqual([answered.provider, answered.model, answered.reasoningEffort], ['codex', 'astra', 'medium']);
  const effort = await switcher.readTasks(async () => stored('u', { reasoningEffort: 'xhigh' }), switcher.fieldsWrittenBy('set_reasoning_effort'));
  assert.equal(effort.reasoningEffort, 'xhigh');
  await reply('set_reasoning_effort', args => stored('u', { reasoningEffort: args.reasoningEffort }));
  await saving;
});

/* ----- A failing repaint, superseded picks, refusals out of a team, mixed picks ----- */
test('a repaint that throws does not stall the next save: it runs, cleans up and the task stops saving', async () => {
  tasks.set('v', stored('v'));
  const logged = console.error; console.error = () => {};
  try {
    const first = switcher.pickModel('v', { provider: 'claude', model: 'opus', warm: false, local: true }, { show() {}, repaint() { throw new Error('repaint broke'); } });
    const second = switcher.pickModel('v', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
    await reply('configure_session', args => stored('v', { model: args.model }));
    await first.catch(() => undefined);
    await reply('configure_session', args => stored('v', { model: args.model }));
    assert.equal(await second, true);
    assert.equal(switcher.saving('v'), false);
    assert.equal(await switcher.settled('v'), true);
    assert.equal(tasks.get('v').model, 'haiku');
  } finally { console.error = logged; }
});

test('a pick back to the harness native has, after a refused pick to another, keeps the account binding', async () => {
  tasks.set('w', stored('w', { provider: 'codex', model: 'astra' }));
  releases.length = 0;
  const harnesses = [];
  const track = { show() {}, repaint: (_, harness) => harnesses.push(harness) };
  const first = switcher.pickModel('w', { provider: 'claude', model: 'opus', warm: false, local: true }, track);
  const second = switcher.pickModel('w', { provider: 'codex', model: 'nova', warm: false, local: true }, track);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await first, false);
  await reply('configure_session', args => stored('w', { provider: args.provider, model: args.model }));
  assert.equal(await second, true);
  assert.deepEqual(releases, [], 'native never left Codex');
  assert.equal(harnesses.at(-1), false, 'the saved pick repaints as a change within the harness');
});

test('a model pick replaced before its save starts is skipped: only the older in flight and the newest reach native', async () => {
  tasks.set('x', stored('x'));
  const picks = ['opus', 'haiku', 'sonnet-4'].map(model => switcher.pickModel('x', { provider: 'claude', model, warm: true, local: true }, ui));
  await ticks();
  assert.deepEqual(pending('configure_session').map(entry => entry.args.model), ['opus']);
  await reply('configure_session', args => stored('x', { model: args.model }));
  await ticks();
  assert.deepEqual(pending('configure_session').map(entry => entry.args.model), ['sonnet-4'], 'haiku was replaced before its turn');
  assert.equal(tasks.get('x').model, 'sonnet-4');
  assert.equal(switcher.saving('x'), true);
  await reply('configure_session', new Error('Busy.'));
  assert.deepEqual(await Promise.all(picks), [true, false, false]);
  // The refusal goes back to what native confirmed (the first pick), not the skipped one.
  assert.equal(tasks.get('x').model, 'opus');
  assert.equal(switcher.saving('x'), false);
  assert.equal((await switcher.settledChange('x'))?.what, 'model');
});

test('a permission pick replaced before its save starts is skipped too', async () => {
  tasks.set('y', stored('y', { mode: 'ask' }));
  const modeUi = { warm: false, paint() {}, name: mode => mode, trigger: () => null };
  const picks = ['full', 'plan', 'auto'].map(mode => switcher.pickMode('y', mode, modeUi));
  await reply('update_session', () => null);
  await ticks();
  assert.deepEqual(pending('update_session').map(entry => entry.args.mode), ['auto']);
  await reply('update_session', () => null);
  assert.deepEqual(await Promise.all(picks), [true, false, true]);
  assert.equal(tasks.get('y').mode, 'auto');
  assert.equal(switcher.modeBusy('y'), false);
  assert.equal(switcher.saving('y'), false);
});

test('an older pick out of a named team refused while a newer one saves: the final refusal still says the task left it', async () => {
  tasks.set('z', stored('z'));
  teams.set('z', { rosterOnly: true, name: 'Reviewers' });
  notices.length = 0;
  const first = switcher.pickModel('z', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('z', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  await reply('architect_configure', () => null);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await first, false);
  assert.deepEqual(notices, [], 'the newer pick decides what to say');
  await reply('configure_session', new Error('Still busy.'));
  assert.equal(await second, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /still on sonnet; the task left team Reviewers/);
  // Said once: a later refusal does not repeat it.
  const third = switcher.pickModel('z', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  await reply('configure_session', new Error('No.'));
  assert.equal(await third, false);
  assert.doesNotMatch(notices.at(-1), /Reviewers/);
});

test('model pick, refused permission pick, model pick: native gets them in order and the refusal is what settles', async () => {
  tasks.set('mx', stored('mx', { mode: 'ask' }));
  const modeUi = { warm: false, paint() {}, name: mode => mode, trigger: () => null };
  const order = [];
  const record = command => args => { order.push(command === 'configure_session' ? args.model : args.mode); return command === 'configure_session' ? stored('mx', { model: args.model }) : null; };
  const first = switcher.pickModel('mx', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const mode = switcher.pickMode('mx', 'full', modeUi);
  const second = switcher.pickModel('mx', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  assert.deepEqual([tasks.get('mx').model, tasks.get('mx').mode], ['haiku', 'full']);
  await reply('configure_session', record('configure_session'));
  await ticks();
  assert.equal(pending('configure_session').length, 0, 'the second model waits for the permission save');
  await reply('update_session', new Error('Approvals are locked.'));
  assert.equal(await mode, false);
  await reply('configure_session', record('configure_session'));
  assert.deepEqual([await first, await second], [true, true]);
  assert.deepEqual(order, ['opus', 'haiku']);
  assert.deepEqual([tasks.get('mx').model, tasks.get('mx').mode], ['haiku', 'ask']);
  assert.equal(switcher.saving('mx'), false);
  assert.equal(switcher.modeBusy('mx'), false);
  assert.deepEqual(await switcher.settledChange('mx'), { what: 'permissions', reason: 'Approvals are locked.', still: 'still ask' });
});

test('an older pick out of a named team that saved, then a newer one refused: the refusal says the task left it', async () => {
  tasks.set('za', stored('za'));
  teams.set('za', { rosterOnly: true, name: 'Writers' });
  notices.length = 0;
  const first = switcher.pickModel('za', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const second = switcher.pickModel('za', { provider: 'claude', model: 'haiku', warm: false, local: true }, ui);
  await reply('architect_configure', () => null);
  await reply('configure_session', args => stored('za', { model: args.model }));
  assert.equal(await first, true);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await second, false);
  assert.match(notices.at(-1), /still on opus; the task left team Writers/);
});

/* ----- A saved permission pick, replaced picks that still save, deleted tasks, one notice for a held send ----- */
const modeUi = { warm: false, paint() {}, name: mode => mode, trigger: () => null };

test('a listing read before a permission pick saved, landing after it, keeps the picked permissions', async () => {
  tasks.set('pa', stored('pa', { mode: 'ask' }));
  const saving = switcher.pickMode('pa', 'full', modeUi);
  await whileReading(async stale => {
    await reply('update_session', () => null);
    assert.equal(await saving, true);
    // The read began before native stored Full access: it must not put Ask back.
    assert.equal(stale.hold(stored('pa', { mode: 'ask' })).mode, 'full');
  });
  await whileReading(read => assert.equal(read.hold(stored('pa', { mode: 'plan' })).mode, 'plan', 'a read after the save is believed'));
});

test('a replaced pick that saves runs no settle side effects; only the final pick does, against the harness native started on', async () => {
  tasks.set('rb', stored('rb', { provider: 'codex', model: 'astra' }));
  teams.set('rb', { auto: true, rosterOnly: false, workers: [] });
  releases.length = 0; remembered.length = 0;
  const harnesses = [];
  const track = { show() {}, repaint: (saved, harness) => harnesses.push([saved, harness]) };
  const first = switcher.pickModel('rb', { provider: 'claude', model: 'opus', warm: false, local: true }, track);
  const second = switcher.pickModel('rb', { provider: 'claude', model: 'haiku', warm: false, local: true }, track);
  await reply('configure_session', args => stored('rb', { provider: args.provider, model: args.model }));
  assert.equal(await first, true);
  await ticks();
  assert.deepEqual([releases, remembered, pending('architect_configure').length], [[], [], 0], 'the replaced pick settles nothing while the newer one saves');
  assert.deepEqual(harnesses, [[true, false]], 'the replaced pick does not ask for a harness reload');
  await reply('configure_session', args => stored('rb', { provider: args.provider, model: args.model }));
  await reply('architect_configure', () => ({ sessionId: 'rb', config: { auto: true, rosterOnly: false, workers: [] } }));
  assert.equal(await second, true);
  assert.deepEqual(releases, ['rb'], 'native left Codex over the two picks: the binding goes once');
  assert.deepEqual(remembered.map(choice => choice.model), ['haiku']);
  assert.deepEqual(harnesses.at(-1), [true, true]);
  teams.delete('rb');
});

test('a replaced pick that saved, then a refused newer pick: the saved one is remembered and settled, not a skipped one', async () => {
  tasks.set('rc', stored('rc', { provider: 'codex', model: 'astra' }));
  releases.length = 0; remembered.length = 0;
  const harnesses = [];
  const track = { show() {}, repaint: (saved, harness) => harnesses.push([saved, harness]) };
  const picks = [
    switcher.pickModel('rc', { provider: 'claude', model: 'opus', warm: false, local: true }, track),
    switcher.pickModel('rc', { provider: 'codex', model: 'nova', warm: false, local: true }, track),
    switcher.pickModel('rc', { provider: 'claude', model: 'haiku', warm: false, local: true }, track),
  ];
  await reply('configure_session', args => stored('rc', { provider: args.provider, model: args.model }));
  await reply('configure_session', new Error('Busy.'));
  assert.deepEqual(await Promise.all(picks), [true, false, false]);
  assert.equal(tasks.get('rc').model, 'opus');
  assert.deepEqual(remembered.map(choice => choice.model), ['opus'], 'the last pick native confirmed');
  assert.deepEqual(releases, ['rc']);
  assert.deepEqual(harnesses.at(-1), [false, true], 'native changed harness: the final pick says so');
});

test('a task deleted mid-pick is not put back by the late reply, and forgetTasks drops its pick state', async () => {
  tasks.set('da', stored('da'));
  const saving = switcher.pickModel('da', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const mode = switcher.pickMode('da', 'full', modeUi);
  tasks.delete('da');
  switcher.forgetTasks(['da']);
  assert.equal(switcher.remembersTask('da'), false);
  await reply('configure_session', args => stored('da', { model: args.model }));
  assert.equal(tasks.has('da'), false, 'a configure reply for a deleted task is not added back');
  // The permission pick queued behind it is dropped with the task: it never reaches native.
  assert.deepEqual(await Promise.all([saving, mode]), [true, false]);
  assert.equal(pending('update_session').length, 0);
  assert.equal(tasks.has('da'), false, 'nor a refusal’s restore');
  assert.equal(switcher.remembersTask('da'), false);
  tasks.set('db', stored('db'));
  const refused = switcher.pickModel('db', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  tasks.delete('db'); switcher.forgetTasks(['db']);
  await reply('configure_session', new Error('No such task.'));
  assert.equal(await refused, false);
  assert.equal(tasks.has('db'), false);
});

test('a refusal holding a send is said once by the send, still naming what stays', async () => {
  tasks.set('ha', stored('ha'));
  notices.length = 0;
  const saving = switcher.pickModel('ha', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const held = switcher.holdSend('ha', () => null);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await saving, false);
  const [unchanged] = await held;
  assert.deepEqual(notices, [], 'the held send says it instead');
  assert.equal(unchanged.still, 'still on sonnet');
  assert.equal(switcher.unchangedText(unchanged), 'the model wasn’t changed (Busy); still on sonnet');
  // Without a held send, the refusal says it itself.
  tasks.set('hb', stored('hb', { mode: 'ask' }));
  const mode = switcher.pickMode('hb', 'full', modeUi);
  const heldMode = switcher.holdSend('hb', () => null);
  await reply('update_session', new Error('Locked.'));
  assert.equal(await mode, false);
  assert.equal(switcher.refusalsText(await heldMode), 'the permissions weren’t changed (Locked); still ask');
  assert.deepEqual(notices, []);
  const alone = switcher.pickMode('hb', 'full', modeUi);
  await reply('update_session', new Error('Locked.'));
  assert.equal(await alone, false);
  assert.deepEqual(notices, ['Permissions not changed (Locked); still ask']);
});

test('a refused effort holding a send is said once by the send', async () => {
  tasks.set('hc', stored('hc'));
  notices.length = 0;
  const saving = switcher.pickEffort('hc', 'high', { warm: false, paint() {} });
  const held = switcher.holdSend('hc', () => null);
  await reply('set_reasoning_effort', new Error('No.'));
  await assert.rejects(saving);
  assert.equal(switcher.refusalsText(await held), 'the effort wasn’t changed (No); still low');
  assert.deepEqual(notices, []);
});

test('a refusal kept back for a held send is said when a newer pick replaces it before the send’s wait ends', async () => {
  tasks.set('hd', stored('hd', { mode: 'ask' }));
  notices.length = 0;
  const mode = switcher.pickMode('hd', 'full', modeUi);
  const model = switcher.pickModel('hd', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const held = switcher.holdSend('hd', () => null);
  await reply('update_session', new Error('Locked.'));
  assert.equal(await mode, false);
  assert.deepEqual(notices, [], 'kept back for the held send');
  const again = switcher.pickMode('hd', 'plan', modeUi);
  assert.deepEqual(notices, ['Permissions not changed (Locked); still ask'], 'said once the newer pick replaces it');
  await reply('configure_session', args => stored('hd', { model: args.model }));
  await reply('update_session', () => null);
  assert.deepEqual([await model, await again, await held], [true, true, []]);
  assert.equal(notices.length, 1);
});

/** A board start, a continue or a picker row as main.ts' afterChoiceSaved runs it: held, then one notice of its own. */
const boardStart = async id => {
  const refusals = await switcher.holdChange(id);
  const text = switcher.unsaidText(refusals);
  if (text) notices.push(`Not started — ${text}.`);
  return !refusals.length;
};

test('a board start waiting on a refused pick shows one notice, keeping what the task is still on', async () => {
  tasks.set('bs', stored('bs'));
  notices.length = 0;
  const saving = switcher.pickModel('bs', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const start = boardStart('bs');
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await saving, false);
  assert.equal(await start, false);
  assert.deepEqual(notices, ['Not started — the model wasn’t changed (Busy); still on sonnet.']);
  // A later action still explains why it is blocked.
  assert.equal(switcher.unsaidText(await switcher.holdChange('bs')), 'the model wasn’t changed (Busy); still on sonnet');
  assert.equal(notices.length, 1);
});

test('a refusal said on its own still explains why a later held start is blocked', async () => {
  tasks.set('bt', stored('bt', { mode: 'ask' }));
  notices.length = 0;
  const mode = switcher.pickMode('bt', 'full', modeUi);
  const model = switcher.pickModel('bt', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  await reply('update_session', new Error('Locked.'));
  assert.equal(await mode, false);
  assert.equal(notices.length, 1, 'nothing waited: said at once');
  const start = boardStart('bt');
  const again = boardStart('bt');
  await reply('configure_session', args => stored('bt', { model: args.model }));
  assert.equal(await model, true);
  assert.equal(await start, false, 'the refused permissions still hold the start back');
  assert.equal(await again, false);
  assert.equal(notices.length, 2, 'the newly blocked action explains why it stopped');
  assert.deepEqual(notices, ['Permissions not changed (Locked); still ask', 'Not started — the permissions weren’t changed (Locked); still ask.']);
});

test('a refused permissions pick and a refused model pick holding one send are both said, once', async () => {
  tasks.set('bu', stored('bu', { mode: 'ask' }));
  notices.length = 0;
  const mode = switcher.pickMode('bu', 'full', modeUi);
  const model = switcher.pickModel('bu', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  const held = switcher.holdSend('bu', () => null);
  const again = switcher.holdSend('bu', () => null);
  await reply('update_session', new Error('Locked.'));
  await reply('configure_session', new Error('Busy.'));
  assert.deepEqual([await mode, await model], [false, false]);
  const refusals = await held;
  assert.deepEqual(refusals.map(refusal => refusal.what), ['permissions', 'model']);
  assert.deepEqual(notices, [], 'the held send says them');
  assert.equal(switcher.unsaidText(refusals), 'the permissions weren’t changed (Locked); still ask; and the model wasn’t changed (Busy); still on sonnet');
  assert.equal(switcher.unsaidText(await again), null, 'a second press of Enter repeats nothing');
  // A newer pick clears them without saying them again.
  const next = switcher.pickMode('bu', 'plan', modeUi);
  await reply('update_session', () => null);
  assert.equal(await next, true);
  assert.deepEqual(notices, []);
});

test('a newer pick landing while an older one settles: the run settles once (account, team, default, reload)', async () => {
  tasks.set('bv', stored('bv'));
  teams.set('bv', { auto: true, rosterOnly: false, workers: [] });
  releases.length = 0; remembered.length = 0;
  const harnesses = [];
  const track = { show() {}, repaint: (saved, harness) => harnesses.push([saved, harness]) };
  const first = switcher.pickModel('bv', { provider: 'codex', model: 'astra', warm: false, local: true }, track);
  await reply('configure_session', args => stored('bv', { provider: args.provider, model: args.model }));
  // The older pick is refreshing its automatic team when the newer one is picked.
  for (let i = 0; i < 20 && !pending('architect_configure').length; i += 1) await new Promise(resolve => setImmediate(resolve));
  const second = switcher.pickModel('bv', { provider: 'codex', model: 'nova', warm: false, local: true }, track);
  await reply('architect_configure', () => ({ sessionId: 'bv', config: { auto: true, rosterOnly: false, workers: [] } }));
  assert.equal(await first, true);
  await reply('configure_session', args => stored('bv', { provider: args.provider, model: args.model }));
  await reply('architect_configure', () => ({ sessionId: 'bv', config: { auto: true, rosterOnly: false, workers: [] } }));
  assert.equal(await second, true);
  assert.deepEqual(releases, ['bv'], 'the account binding is released once');
  assert.deepEqual(remembered.map(choice => choice.model), ['nova'], 'only the newest pick is remembered');
  assert.deepEqual(harnesses, [[true, false], [true, true]], 'only the newest pick reloads the thread');
  teams.delete('bv');
});

test('an effort refusal after deletion keeps no task state or notice', async () => {
  tasks.set('deleted-effort', stored('deleted-effort'));
  notices.length = 0;
  const saving = switcher.pickEffort('deleted-effort', 'high', { warm: false, paint() {} });
  const rejected = assert.rejects(saving);
  tasks.delete('deleted-effort'); switcher.forgetTasks(['deleted-effort']);
  await reply('set_reasoning_effort', new Error('No such task.'));
  await rejected;
  assert.equal(switcher.remembersTask('deleted-effort'), false);
  assert.equal(await switcher.settledChange('deleted-effort'), null);
  assert.deepEqual(notices, []);
});

test('own model notices attach the reason to the model, before any team left', async () => {
  tasks.set('wording', stored('wording'));
  teams.set('wording', { rosterOnly: true, name: 'Ship crew' });
  notices.length = 0;
  const saving = switcher.pickModel('wording', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  await reply('architect_configure', () => null);
  await reply('configure_session', new Error('Busy.'));
  assert.equal(await saving, false);
  assert.deepEqual(notices, ['Model not changed (Busy); still on sonnet; the task left team Ship crew']);
});
