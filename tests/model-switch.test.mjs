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

test('a listing read before a model pick saved keeps the picked model; one read after the save is believed', async () => {
  tasks.set('a', stored('a'));
  const stale = switcher.listingStamp();
  const saving = switcher.pickModel('a', { provider: 'codex', model: 'astra', warm: false, local: true }, ui);
  // Landing mid-save, it still lists the old harness and model.
  const midSave = switcher.heldChoices({ ...stored('a'), title: 'Renamed' }, stale);
  assert.deepEqual([midSave.provider, midSave.model, midSave.reasoningEffort, midSave.title], ['codex', 'astra', null, 'Renamed']);
  // A listing that started after the pick but read before native stored it: still held while the pick saves.
  assert.equal(switcher.heldChoices(stored('a'), switcher.listingStamp()).model, 'astra');
  await reply('configure_session', args => stored('a', { provider: args.provider, model: args.model, reasoningEffort: null }));
  assert.equal(await saving, true);
  // Landing after the save: the old read still cannot put the old model back.
  assert.equal(switcher.heldChoices(stored('a'), stale).model, 'astra');
  // A listing read after the save says what native has, even a later change made elsewhere.
  const fresh = switcher.heldChoices(stored('a', { provider: 'codex', model: 'other' }), switcher.listingStamp());
  assert.equal(fresh.model, 'other');
});

test('a refused pick goes back once, and a listing read before it shows the same model', async () => {
  tasks.set('b', stored('b'));
  const stale = switcher.listingStamp();
  const saving = switcher.pickModel('b', { provider: 'claude', model: 'opus', warm: false, local: true }, ui);
  assert.equal(tasks.get('b').model, 'opus');
  await reply('configure_session', new Error('Stop the agent first.'));
  assert.equal(await saving, false);
  assert.equal(tasks.get('b').model, 'sonnet');
  assert.equal(switcher.heldChoices(stored('b'), stale).model, 'sonnet');
});

test('an effort change holds only the effort: another field changed elsewhere still shows', async () => {
  tasks.set('c', stored('c'));
  const stale = switcher.listingStamp();
  const saving = switcher.pickEffort('c', 'high', { warm: false, paint() {} });
  const listed = switcher.heldChoices(stored('c', { model: 'opus', mode: 'full' }), stale);
  assert.deepEqual([listed.reasoningEffort, listed.model, listed.mode], ['high', 'opus', 'full']);
  await reply('set_reasoning_effort', args => stored('c', { reasoningEffort: args.reasoningEffort }));
  await saving;
  assert.equal(switcher.heldChoices(stored('c'), stale).reasoningEffort, 'high');
  assert.equal(switcher.heldChoices(stored('c'), switcher.listingStamp()).reasoningEffort, 'low');
});

test('a task with no pick is listed as read', () => {
  tasks.set('d', stored('d'));
  const listed = stored('d', { model: 'opus' });
  assert.equal(switcher.heldChoices(listed, 0), listed);
});

// A redrawn busy control's CSS pulse starts on its own clock; joinPulses puts it on the shared phase (startTime 0) at once.
const fakeAnimation = (animationName, startTime) => ({ animationName, startTime });
const fakeRoot = animations => ({ getAnimations: options => { assert.deepEqual(options, { subtree: true }); return animations; } });

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
