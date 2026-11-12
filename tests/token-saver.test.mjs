import test from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) };
const { REMIND_EVERY, contextFor, defaults, estimate, guidance, setDefaults, suggestion, threadSaver, updateThread } = await import('../src/token-saver.ts');
const noRtk = { rtk: false }, withRtk = { rtk: true };

test('guidance rides along when it changes and as a periodic reminder, never every message', () => {
  memory.clear();
  assert.equal(contextFor('t1', noRtk), '', 'nothing is sent while the saver is off');
  updateThread('t1', { packs: ['caveman'], level: 'full' });
  const first = contextFor('t1', noRtk);
  assert.match(first, /^\n\nResponse style \(PandaCode token saver/);
  assert.match(first, /Respond like smart caveman/);
  assert.match(first, /plain full sentences for security warnings/);
  for (let i = 1; i < REMIND_EVERY; i++) assert.equal(contextFor('t1', noRtk), '', `message ${i} stays quiet`);
  assert.notEqual(contextFor('t1', noRtk), '', 'then it is restated');
  updateThread('t1', { level: 'lite' });
  assert.match(contextFor('t1', noRtk), /Answer first\. No greeting/);
  updateThread('t1', { packs: [] });
  assert.match(contextFor('t1', noRtk), /: off\. Answer in your normal style again\./);
  assert.equal(contextFor('t1', noRtk), '', 'the switch-off is said once');
});

test('RTK guidance needs rtk installed, and packs combine in one block', () => {
  memory.clear();
  updateThread('t2', { packs: ['rtk'] });
  assert.equal(contextFor('t2', noRtk), '', 'without rtk the pack is inert');
  assert.match(contextFor('t2', withRtk), /Prefix shell commands with rtk/);
  updateThread('t2', { packs: ['lean-code', 'quiet-tools', 'rtk'] });
  const block = guidance(['lean-code', 'quiet-tools', 'rtk'], 'full', withRtk);
  assert.match(block, /least code that fully solves/);
  assert.match(block, /not broad listings/);
  assert.doesNotMatch(block, /caveman/i);
});

test('threads start from the saved default and keep their own changes', () => {
  memory.clear();
  assert.deepEqual(threadSaver('fresh').packs, []);
  setDefaults({ packs: ['caveman', 'quiet-tools'], level: 'ultra' });
  assert.deepEqual(threadSaver('new-thread').packs, ['caveman', 'quiet-tools']);
  assert.equal(threadSaver('new-thread').level, 'ultra');
  updateThread('new-thread', { packs: ['lean-code'] });
  assert.deepEqual(threadSaver('new-thread').packs, ['lean-code']);
  assert.deepEqual(defaults().packs, ['caveman', 'quiet-tools']);
  setDefaults(null);
  assert.deepEqual(threadSaver('another').packs, []);
});

test('the estimate compounds, ignores unavailable tools, and stays plausible', () => {
  assert.equal(estimate([], 'full', noRtk), 0);
  assert.equal(estimate(['rtk'], 'full', noRtk), 0);
  const all = estimate(['caveman', 'lean-code', 'quiet-tools', 'rtk'], 'ultra', withRtk);
  assert.ok(all > 50 && all < 75, String(all));
  assert.ok(estimate(['caveman'], 'lite', noRtk) < estimate(['caveman'], 'ultra', noRtk));
});

test('a nearly full context offers one-click tightening, only while something is left', () => {
  const full = { usedTokens: 820000, contextWindow: 1000000 };
  assert.equal(suggestion([], 'full', null), null, 'no reading, no hint');
  assert.equal(suggestion([], 'full', { usedTokens: 100000, contextWindow: 1000000 }), null, 'quiet below the threshold');
  assert.deepEqual(suggestion([], 'full', full), { addPacks: ['caveman', 'quiet-tools'], level: 'ultra' });
  assert.deepEqual(suggestion(['caveman'], 'full', full), { addPacks: ['quiet-tools'], level: 'ultra' });
  assert.deepEqual(suggestion(['caveman'], 'ultra', full), { addPacks: ['quiet-tools'] });
  assert.deepEqual(suggestion(['quiet-tools'], 'full', full), { addPacks: ['caveman'], level: 'ultra' });
  assert.equal(suggestion(['caveman', 'quiet-tools'], 'ultra', full), null, 'already tight');
  assert.equal(suggestion([], 'full', { usedTokens: 900000, contextWindow: 0 }), null, 'unknown window stays quiet');
  assert.deepEqual(suggestion(['rtk'], 'lite', { usedTokens: 750000, contextWindow: 1000000 }), { addPacks: ['caveman', 'quiet-tools'], level: 'ultra' }, 'exactly at the threshold counts as full');
});

test('the saver stamps when its configuration was sent, and reminders keep the stamp', () => {
  memory.clear();
  updateThread('t5', { packs: ['caveman'] });
  contextFor('t5', noRtk);
  const at = threadSaver('t5').changedAt;
  assert.equal(typeof at, 'number');
  for (let i = 0; i < REMIND_EVERY; i++) contextFor('t5', noRtk);
  assert.equal(threadSaver('t5').changedAt, at, 'reminders keep the original stamp');
  updateThread('t5', { packs: ['caveman', 'quiet-tools'] });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60000;
    contextFor('t5', noRtk);
    assert.ok(threadSaver('t5').changedAt > at, 'a new configuration stamps again');
  } finally {
    Date.now = realNow;
  }
});

test('guidance snapshot: all 96 pack, level and rtk combinations', async () => {
  // token_saver.rs hashes the same 96 outputs to the same value (`guidance_snapshot`), so
  // threads and team workers get identical text. Update both hashes when you change
  // src/token-saver-packs.json on purpose.
  const { createHash } = await import('node:crypto');
  const ids = ['caveman', 'lean-code', 'quiet-tools', 'rtk'], out = [];
  for (let mask = 0; mask < 16; mask++) for (const level of ['lite', 'full', 'ultra']) for (const rtk of [false, true]) {
    out.push(guidance(ids.filter((_, i) => mask & (1 << i)), level, { rtk }));
  }
  assert.equal(createHash('sha256').update(out.join('\0')).digest('hex'), '6e2a8923af5b48bc63b6ac8cd8b48b19049095e727909c04228da63bd5390502');
  assert.equal(guidance(['quiet-tools'], 'full', noRtk), 'Response style (PandaCode token saver, applies to this whole thread until changed; reader pays per token):\nKeep tool output small. Search with targeted patterns, not broad listings. Read only the line ranges you need, and do not read a file again unless it changed. Use quiet flags (git --no-pager, -q, --silent) and cap long output with head or tail. Run the tests closest to the change before the full suite.\n\nStart each prompt you give your own subagents (Task tool or similar) with one "Response style:" line that asks for this same style and its exceptions.');
  // Only an active style mentions subagents; a switch-off does not.
  assert.doesNotMatch(guidance([], 'full', noRtk), /subagents/);
  assert.match(guidance(['caveman'], 'lite', noRtk), /reports to the lead \(keep findings complete and unambiguous\)/);
  assert.match(guidance(['rtk'], 'lite', withRtk), /without the explore tool \(pandacode_explore\), also rtk read <file> and rtk grep <pattern>\./);
});
