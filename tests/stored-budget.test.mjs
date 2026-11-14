import test from 'node:test';
import assert from 'node:assert/strict';

// The local storage helpers shared by composer drafts (launch-restore.ts) and unsent line comments
// (review-comments.ts): src/stored-budget.ts.
const { safeRead, safeRemove, storedKeys, expiredAt, storedTotal, evictOldest, writeWithinBudget } = await import('../src/stored-budget.ts');

/** Local storage in a Map. `full(key, value)` says whether a write fails as a full store would. */
function memoryStore({ items = new Map(), full = () => false } = {}) {
  const writes = [];
  const store = {
    getItem: key => items.has(key) ? items.get(key) : null,
    setItem: (key, value) => { writes.push(key); if (full(key, value)) throw new Error('QuotaExceededError'); items.set(key, String(value)); },
    removeItem: key => { items.delete(key); },
    key: i => [...items.keys()][i] ?? null,
    get length() { return items.size; },
  };
  return { store, items, writes };
}
/** What a feature has stored, and an `evict` that moves an item out of storage as the features do. */
function stored(store, entries) {
  const sizes = new Map(entries.map(([id, t, size]) => [id, { t, size }]));
  for (const [id, , size] of entries) store.setItem(`k:${id}`, 'x'.repeat(size));
  const evicted = [];
  const evict = id => { evicted.push(id); sizes.delete(id); safeRemove(store, `k:${id}`); };
  return { sizes, evicted, evict };
}

test('reads, removals and key listing never throw', () => {
  const broken = { getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { throw new Error('denied'); }, get length() { throw new Error('denied'); } };
  assert.equal(safeRead(broken, 'a'), null);
  assert.doesNotThrow(() => safeRemove(broken, 'a'));
  assert.deepEqual(storedKeys(broken, 'k:'), []);
  const { store } = memoryStore({ items: new Map([['k:a', '1'], ['other', '2'], ['k:b', '3']]) });
  assert.deepEqual(storedKeys(store, 'k:'), ['k:a', 'k:b']);
  assert.equal(safeRead(store, 'k:b'), '3');
});

test('an item expires when older than the age limit or dated past the slack ahead', () => {
  assert.equal(expiredAt(100, 200, 100, 10), false, 'exactly at the age limit');
  assert.equal(expiredAt(99, 200, 100, 10), true);
  assert.equal(expiredAt(210, 200, 100, 10), false, 'exactly at the slack');
  assert.equal(expiredAt(211, 200, 100, 10), true);
});

test('eviction moves out the oldest first and never the item being saved, whose old size is left out', () => {
  const { store, items } = memoryStore();
  const { sizes, evicted, evict } = stored(store, [['saving', 1, 40], ['old', 2, 30], ['mid', 3, 30], ['new', 4, 30]]);
  assert.equal(storedTotal(sizes), 130);
  // Without `saving` (the oldest, and larger than the limit allows) the others total 90: the oldest
  // of them goes, then the next, until they fit 40.
  evictOldest(sizes, 40, evict, 'saving');
  assert.deepEqual(evicted, ['old', 'mid']);
  assert.deepEqual([...sizes.keys()], ['saving', 'new']);
  assert.ok(items.has('k:saving') && items.has('k:new') && !items.has('k:old'));
  // Within the limit already: nothing goes.
  evictOldest(sizes, 30, evict, 'saving');
  assert.deepEqual(evicted, ['old', 'mid']);
  // With no item excepted, every item counts and can go.
  evictOldest(sizes, 30, evict);
  assert.deepEqual(evicted, ['old', 'mid', 'saving']);
});

test('a write keeps the feature within its budget, replacing the item\'s own entry', () => {
  const { store, items } = memoryStore();
  const { sizes, evicted, evict } = stored(store, [['a', 1, 40], ['b', 2, 40], ['c', 3, 10]]);
  const warn = () => assert.fail('no warning');
  // `c` grows from 10 to 50: its old size is not counted, and only `a` has to go for 90 to fit 100.
  assert.equal(writeWithinBudget(store, sizes, { id: 'c', key: 'k:c', value: 'y'.repeat(50), t: 5, size: 50 }, 100, evict, warn), true);
  assert.deepEqual(evicted, ['a']);
  assert.deepEqual(sizes.get('c'), { t: 5, size: 50 });
  assert.equal(items.get('k:c'), 'y'.repeat(50));
  assert.equal(storedTotal(sizes), 90);
});

test('a write that finds the store full moves out the older half and tries once more', () => {
  let fails = 1;
  const { store, items, writes } = memoryStore({ full: key => key === 'k:new' && fails-- > 0 });
  const { sizes, evicted, evict } = stored(store, [['a', 1, 10], ['b', 2, 10], ['c', 3, 10], ['d', 4, 10]]);
  const warnings = [];
  assert.equal(writeWithinBudget(store, sizes, { id: 'new', key: 'k:new', value: 'n', t: 9, size: 1 }, 1000, evict, error => warnings.push(error)), true);
  // Within budget, so nothing went before the first try; after it failed, the older half (20 of 40) went.
  assert.deepEqual(evicted, ['a', 'b']);
  assert.deepEqual(writes.filter(key => key === 'k:new').length, 2);
  assert.equal(items.get('k:new'), 'n');
  assert.deepEqual([...sizes.keys()], ['c', 'd', 'new']);
  assert.deepEqual(warnings, []);
});

test('a write that still does not fit is warned about, removed from storage and left in memory only', () => {
  let full = false;
  const { store, items } = memoryStore({ full: key => full && key === 'k:big' });
  const { sizes, evict } = stored(store, [['a', 1, 10], ['big', 2, 10]]);
  full = true;
  const warnings = [];
  assert.equal(writeWithinBudget(store, sizes, { id: 'big', key: 'k:big', value: 'z'.repeat(20), t: 3, size: 20 }, 1000, evict, error => warnings.push(error)), false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /QuotaExceededError/);
  assert.equal(items.has('k:big'), false, 'its older copy is not left behind');
  assert.equal(sizes.has('big'), false);
  assert.equal(sizes.has('a'), false, 'the older half was tried first');
});
