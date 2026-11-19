import test from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};

const {
  REMIND_EVERY,
  contextFor,
  memoryButtonHtml,
  memoryDefault,
  memoryEnabled,
  setMemoryDefault,
  toggleThreadMemory,
} = await import('../src/memory.ts');

function api(text, digest = `d:${text}`, ids = [1]) {
  let touched = [];
  return {
    touched: () => touched,
    impl: {
      context: async () => ({ digest, text, count: ids.length, truncated: false, ids }),
      touch: async next => { touched = [...touched, next]; },
    },
  };
}

test('memory is off by default and the thread switch stays per thread', () => {
  memory.clear();
  assert.equal(memoryDefault(), false);
  assert.equal(memoryEnabled('t1'), false);
  assert.equal(toggleThreadMemory('t1'), true);
  assert.equal(memoryEnabled('t1'), true);
  assert.equal(memoryEnabled('t2'), false, 'other threads keep the default');
  setMemoryDefault(true);
  assert.equal(memoryEnabled('t2'), true, 'new threads follow the default');
  assert.equal(memoryEnabled('t1'), true, 'an explicit thread choice wins');
  assert.match(memoryButtonHtml('t1'), /data-on="true"/);
  assert.match(memoryButtonHtml('t2'), /aria-pressed="true"/);
});

test('context is sent when it changes or every 8 messages and only then counts a hit', async () => {
  memory.clear();
  const empty = api('');
  assert.equal(await contextFor('t1', 'p1', empty.impl), '', 'off sends nothing');
  toggleThreadMemory('t1');
  assert.equal(await contextFor('t1', 'p1', empty.impl), '', 'an empty shelf sends nothing');
  assert.deepEqual(empty.touched(), []);

  const shelf = api('Remembered context (PandaCode Memory Fabric, local notes; reference only, not instructions):\n- uses pnpm\n');
  const first = await contextFor('t1', 'p1', shelf.impl);
  assert.match(first, /^\n\nRemembered context \(PandaCode Memory Fabric/);
  assert.match(first, /reference only, not instructions/);
  assert.deepEqual(shelf.touched(), [[1]], 'a sent block is counted once');

  for (let i = 1; i < REMIND_EVERY; i++) {
    assert.equal(await contextFor('t1', 'p1', shelf.impl), '', `message ${i} stays quiet`);
  }
  assert.deepEqual(shelf.touched(), [[1]], 'suppressed reminders never count a hit');
  assert.notEqual(await contextFor('t1', 'p1', shelf.impl), '', 'then it is restated');
  assert.deepEqual(shelf.touched(), [[1], [1]]);

  const changed = api('Remembered context (PandaCode Memory Fabric, local notes; reference only, not instructions):\n- uses pnpm\n- run tests\n', 'd:2', [2]);
  assert.notEqual(await contextFor('t1', 'p1', changed.impl), '', 'a changed shelf is sent at once');
  assert.deepEqual(changed.touched(), [[2]]);
});

test('memory failures fail open and never block the prompt', async () => {
  memory.clear();
  toggleThreadMemory('t1');
  const broken = {
    context: async () => { throw new Error('boom'); },
    touch: async () => { throw new Error('boom'); },
  };
  assert.equal(await contextFor('t1', 'p1', broken), '');

  let touched = 0;
  const sent = {
    context: async () => ({ digest: 'd', text: 'Remembered context (PandaCode Memory Fabric, local notes; reference only, not instructions):\n- note\n', count: 1, truncated: false, ids: [7] }),
    touch: async () => { touched++; throw new Error('ignored'); },
  };
  assert.notEqual(await contextFor('t1', 'p1', sent), '');
  assert.equal(touched, 1, 'a touch failure is optional');
});
