import test from 'node:test';
import assert from 'node:assert/strict';

// Drafts and the open thread survive any exit, a crash included, without bringing back what was
// sent, filling storage, or reopening a thread that takes the app down.
const {
  PersistedDrafts, decodeDraft, rememberOpenThread, threadToReopen, beginThreadRestore, finishThreadRestore,
  DRAFT_PREFIX, OPEN_THREAD_KEY, PREVIOUS_THREAD_KEY, OPEN_NEW_TASK_KEY, NEW_TASK_DRAFT, RESTORING_KEY, MAX_DRAFT_CHARS, DRAFT_MAX_AGE, DRAFTS_BYTE_BUDGET,
  expireDraftsWhileRunning, finishThreadRestoreAfterPaint, windowStable, pageClosed, leavePage, PAGE_ALIVE_KEY, DRAFT_FUTURE_SLACK, WINDOW_DIED_KEY, WINDOW_STABLE_AFTER, PAINT_WAIT,
} = await import('../src/launch-restore.ts');

const NOW = Date.UTC(2026, 10, 11, 12);
/** A Storage stand-in; `quota` (bytes, UTF-16) makes setItem throw like a full store. */
const memory = (initial = {}, quota = Infinity) => {
  const data = new Map(Object.entries(initial));
  const used = () => [...data].reduce((sum, [k, v]) => sum + (k.length + v.length) * 2, 0);
  return {
    data, writes: [],
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      const before = data.get(key);
      data.set(key, String(value));
      if (used() > quota) { if (before === undefined) data.delete(key); else data.set(key, before); throw new Error('QuotaExceededError'); }
      this.writes.push(key);
    },
    removeItem: key => data.delete(key),
  };
};
const NORMAL = { crashed: false, paused: false }, CRASHED = { crashed: true, paused: false }, PAUSED = { crashed: true, paused: true };
const stored = (text, t = NOW) => JSON.stringify({ t, text });
const quiet = fn => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

test('every change is written at once, so a crash mid-typing loses no keystroke, and all are read back on the next launch', () => {
  const store = memory();
  const drafts = new PersistedDrafts(store, () => NOW);
  for (const text of ['h', 'half a thought', 'half a thought, finished']) {
    drafts.set('a', text);
    assert.deepEqual(decodeDraft(store.getItem(DRAFT_PREFIX + 'a')), { t: NOW, text }, `written before the next keystroke: ${text}`);
  }
  assert.equal(store.writes.length, 3);
  assert.deepEqual([...new PersistedDrafts(store, () => NOW)], [['a', 'half a thought, finished']]);
});

test('a keystroke rewrites only its own draft', () => {
  const store = memory({ [DRAFT_PREFIX + 'a']: stored('x'), [DRAFT_PREFIX + 'b']: stored('y') });
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.set('b', 'yz');
  assert.deepEqual(store.writes, [DRAFT_PREFIX + 'b']);
});

test('sending removes the stored draft at once, so a crash cannot bring it back', () => {
  const store = memory();
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.set('a', 'the prompt');
  drafts.set('a', 'the prompt, edited'); drafts.set('a', 'the prompt, edited twice');
  drafts.delete('a');
  assert.equal(store.getItem(DRAFT_PREFIX + 'a'), null, 'gone at once');
  drafts.set('b', 'x'); drafts.set('b', '');
  assert.equal(store.getItem(DRAFT_PREFIX + 'b'), null, 'clearing the field removes it at once too');
});

test('loading does not write, and neither does an unchanged set', () => {
  const store = memory({ [DRAFT_PREFIX + 'a']: stored('x') });
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.set('a', 'x');
  assert.deepEqual(store.writes, []);
});

test('drafts older than the age limit, malformed ones and oversized ones are dropped at launch', () => {
  const store = memory({
    [DRAFT_PREFIX + 'old']: stored('stale', NOW - DRAFT_MAX_AGE - 1),
    [DRAFT_PREFIX + 'recent']: stored('fresh', NOW - DRAFT_MAX_AGE + 60_000),
    [DRAFT_PREFIX + 'bad']: '{',
    [DRAFT_PREFIX + 'big']: stored('x'.repeat(MAX_DRAFT_CHARS + 1)),
    'pandacode.other': 'untouched',
  });
  const drafts = new PersistedDrafts(store, () => NOW);
  assert.deepEqual([...drafts.keys()], ['recent']);
  assert.deepEqual([...store.data.keys()].sort(), [DRAFT_PREFIX + 'recent', 'pandacode.other']);
});

test('drafts of threads the session list leaves out (older tasks, worker threads) are kept', () => {
  const store = memory({ [DRAFT_PREFIX + 'a']: stored('x'), [DRAFT_PREFIX + 'worker']: stored('y') });
  const drafts = new PersistedDrafts(store, () => NOW);
  assert.equal('prune' in drafts, false, 'nothing drops drafts by the listed ids');
  assert.deepEqual([...drafts.keys()].sort(), ['a', 'worker']);
  drafts.delete('worker');
  assert.equal(store.getItem(DRAFT_PREFIX + 'worker'), null, 'deleting the thread drops it at once');
});

test('drafts expire while the app runs, not only at launch', () => {
  let clock = NOW;
  const store = memory({ [DRAFT_PREFIX + 'old']: stored('x', NOW - DRAFT_MAX_AGE + 1000), [DRAFT_PREFIX + 'new']: stored('y', NOW) });
  const drafts = new PersistedDrafts(store, () => clock);
  drafts.expire();
  assert.deepEqual([...drafts.keys()].sort(), ['new', 'old'], 'nothing is past the limit yet');
  clock += 2000;
  drafts.expire();
  assert.deepEqual([...drafts.keys()], ['new']);
  assert.equal(store.getItem(DRAFT_PREFIX + 'old'), null);
});

test('expiry runs daily and whenever the window shows again', () => {
  const listeners = {}, doc = { visibilityState: 'hidden', addEventListener: (name, run) => { listeners[name] = run; } };
  let expired = 0, every = 0;
  const original = globalThis.setInterval;
  globalThis.setInterval = (run, ms) => { every = ms; return 0; };
  try { expireDraftsWhileRunning({ expire: () => { expired++; } }, doc); } finally { globalThis.setInterval = original; }
  assert.equal(every, 24 * 60 * 60 * 1000);
  listeners.visibilitychange();
  assert.equal(expired, 0, 'not while hidden');
  doc.visibilityState = 'visible'; listeners.visibilitychange();
  assert.equal(expired, 1);
});

/** Tasks 'n1', 'n2' are New tasks of project 'p'; 't' is an ordinary thread. */
const newTasks = drafts => { drafts.newTaskKey = id => id.startsWith('n') ? NEW_TASK_DRAFT + 'p' : undefined; return drafts; };

test('a New task keeps its text under its project, which the next launch’s New task takes over', () => {
  const store = memory();
  const drafts = newTasks(new PersistedDrafts(store, () => NOW));
  drafts.set('n1', 'a long first prompt');
  assert.equal(store.getItem(DRAFT_PREFIX + 'n1'), null, 'never under the draft session’s id');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'a long first prompt');
  // The next launch: the draft session is gone; a new one in the project gets the text.
  const next = newTasks(new PersistedDrafts(store, () => NOW));
  assert.equal(next.get('t'), undefined, 'an ordinary thread does not');
  assert.equal(next.get('n2'), 'a long first prompt');
  next.set('n2', 'a long first prompt, edited');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'a long first prompt, edited');
  // Sending (or clearing) removes it at once.
  next.delete('n2');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
  assert.equal(newTasks(new PersistedDrafts(store, () => NOW)).get('n1'), undefined);
});

test('a New task’s key is removed when it is sent after it stopped being a New task, and clearing the field removes it', () => {
  const store = memory();
  const drafts = newTasks(new PersistedDrafts(store, () => NOW));
  drafts.set('n1', 'prompt');
  drafts.newTaskKey = () => undefined; // published by the send before the composer clears
  drafts.delete('n1');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
  newTasks(drafts).set('n2', 'x'); drafts.set('n2', '');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
});

test('a New task that stops being one (a queued message was delivered) moves its text to its own id', () => {
  const store = memory();
  let draft = true;
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = id => id === 'n1' && draft ? NEW_TASK_DRAFT + 'p' : undefined;
  drafts.set('n1', 'queued');
  drafts.delete('n1'); // the queued message cleared the composer
  drafts.set('n1', 'more'); // typed again while still a draft
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'more');
  draft = false; // deliverQueued published it
  drafts.reclaim('n1');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null, 'the project key goes at once');
 
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'n1')).text, 'more', 'kept under the thread');
  drafts.set('n1', 'more text');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null, 'later typing stays off the project key');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'n1')).text, 'more text');
  // After a crash: the thread gets its text back, the next New task in the project does not.
  const next = new PersistedDrafts(store, () => NOW);
  next.newTaskKey = id => id === 'n2' ? NEW_TASK_DRAFT + 'p' : undefined;
  assert.equal(next.get('n1'), 'more text');
  assert.equal(next.get('n2'), undefined);
});

test('a New task whose first send failed moves its restored text back under its project once it is a New task again', () => {
  const store = memory();
  let draft = true;
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = id => id === 'n1' && draft ? NEW_TASK_DRAFT + 'p' : undefined;
  drafts.set('n1', 'first prompt');
  draft = false; // the send published it optimistically
  drafts.delete('n1'); // and cleared the composer
  drafts.set('n1', 'first prompt'); // send_message rejected: the text comes back, under the thread's id
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'n1')).text, 'first prompt');
  draft = true; // native storage says it is still a draft
  drafts.reclaim('n1');
  assert.equal(store.getItem(DRAFT_PREFIX + 'n1'), null, 'not left under an id the next launch discards');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'first prompt');
  // reclaimAll does the same for every thread draft, after any session list change.
  draft = false; drafts.reclaimAll();
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'n1')).text, 'first prompt');
  draft = true; drafts.reclaimAll();
  assert.equal(store.getItem(DRAFT_PREFIX + 'n1'), null);
  // The next launch: the empty draft session is gone, the project's next New task gets the text.
  const next = new PersistedDrafts(store, () => NOW);
  next.newTaskKey = id => id === 'n2' ? NEW_TASK_DRAFT + 'p' : undefined;
  assert.equal(next.get('n2'), 'first prompt');
});

test('typing after a New task stopped being one moves its text too, without a reclaim, on its next change', () => {
  const store = memory();
  let draft = true;
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = () => draft ? NEW_TASK_DRAFT + 'p' : undefined;
  drafts.set('n1', 'a'); drafts.set('n1', 'ab');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'ab');
  draft = false;
  drafts.set('n1', 'abc');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'n1')).text, 'abc');
});

test('a second New task in the same launch starts empty and owns the key once typed in', () => {
  const store = memory();
  const drafts = newTasks(new PersistedDrafts(store, () => NOW));
  drafts.set('n1', 'first');
  assert.equal(drafts.get('n2'), undefined, 'another New task does not show the first one’s text');
  drafts.set('n2', 'second');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'second');
  assert.equal(drafts.get('n1'), 'first', 'the first keeps its text for this launch');
  drafts.delete('n1');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'second', 'and dropping it leaves the owner’s text');
});

test('a New task moved to another project takes its text to that project’s key', () => {
  const store = memory();
  let project = 'p';
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = () => NEW_TASK_DRAFT + project;
  drafts.set('n1', 'plan');
  project = 'q';
  drafts.set('n1', 'plan');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null, 'the old project’s key is gone at once');
 
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:q')).text, 'plan');
});

test('removing a project removes its New task text, kept or claimed by a New task', () => {
  const store = memory({ [DRAFT_PREFIX + 'new:p']: stored('kept from the last launch') });
  const drafts = newTasks(new PersistedDrafts(store, () => NOW));
  drafts.delete(NEW_TASK_DRAFT + 'p');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
  assert.equal(drafts.get('n1'), undefined, 'and no New task takes it over');
  // Typed into a New task this launch: deleting the task's draft removes the project's key.
  drafts.set('n1', 'typed now');
  drafts.delete('n1'); drafts.delete(NEW_TASK_DRAFT + 'p');
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
});

test('a New task’s kept text has the same age limit, size cap and validation', () => {
  let clock = NOW;
  const store = memory({ [DRAFT_PREFIX + 'new:old']: stored('x', NOW - DRAFT_MAX_AGE - 1), [DRAFT_PREFIX + 'new:big']: stored('x'.repeat(MAX_DRAFT_CHARS + 1)), [DRAFT_PREFIX + 'new:bad']: '[]', [DRAFT_PREFIX + 'new:']: stored('x'), [DRAFT_PREFIX + 'new:p']: stored('ok') });
  const drafts = newTasks(new PersistedDrafts(store, () => clock));
  assert.deepEqual([...drafts.keys()], ['new:p']);
  clock += DRAFT_MAX_AGE + 1;
  drafts.expire();
  assert.equal(drafts.get('n1'), undefined);
  assert.equal(store.getItem(DRAFT_PREFIX + 'new:p'), null);
});

test('the stored total stays under the byte budget, oldest dropped first, newest kept in memory', () => {
  const store = memory();
  let clock = NOW;
  const drafts = new PersistedDrafts(store, () => clock);
  const big = 'x'.repeat(MAX_DRAFT_CHARS - 5);
  const count = Math.ceil(DRAFTS_BYTE_BUDGET / (MAX_DRAFT_CHARS * 2)) + 3;
  for (let index = 0; index < count; index++) { clock++; drafts.set(`t${index}`, big + index); }
  const total = [...store.data].filter(([key]) => key.startsWith(DRAFT_PREFIX)).reduce((sum, [, value]) => sum + JSON.parse(value).text.length * 2, 0);
  assert.ok(total <= DRAFTS_BYTE_BUDGET, `${total} bytes stored`);
  assert.ok(store.getItem(DRAFT_PREFIX + `t${count - 1}`), 'the newest is stored');
  assert.equal(store.getItem(DRAFT_PREFIX + 't0'), null, 'the oldest is not');
  assert.equal(drafts.get('t0'), big + 0, 'but stays for this launch');
  assert.ok(DRAFTS_BYTE_BUDGET <= 5_000_000 / 4, 'well below WebKit’s ~5 MB');
});

test('a full store drops older drafts and retries once instead of failing every save', () => {
  const quota = 4 * 1024;
  const store = memory({}, quota);
  let clock = NOW;
  const drafts = new PersistedDrafts(store, () => clock);
  for (const id of ['a', 'b', 'c']) { clock++; drafts.set(id, id.repeat(500)); }
  clock++; drafts.set('d', 'd'.repeat(500));
  assert.ok(store.getItem(DRAFT_PREFIX + 'd'), 'the newest draft was kept');
  assert.equal(store.getItem(DRAFT_PREFIX + 'a'), null, 'by dropping the oldest');
  // Too large for the store even when empty: it fails once more and is left out, quietly.
  quiet(() => { clock++; drafts.set('e', 'e'.repeat(2500)); });
  assert.equal(store.getItem(DRAFT_PREFIX + 'e'), null);
  assert.equal(drafts.get('e'), 'e'.repeat(2500));
});

test('a failing store never throws', () => {
  const broken = { length: 1, key() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } };
  quiet(() => {
    const drafts = new PersistedDrafts(broken, () => NOW);
    drafts.set('a', 'still here'); drafts.delete('b'); drafts.expire();
    rememberOpenThread(broken, 'a');
    assert.deepEqual(threadToReopen(broken, [{ id: 'a', archived: false }], NORMAL), { task: undefined, fallback: true });
    beginThreadRestore(broken, 'a'); finishThreadRestore(broken);
  });
});

test('the thread open at exit is reopened when it still exists and is not archived', () => {
  const tasks = [{ id: 'a', archived: false }, { id: 'b', archived: true }];
  assert.deepEqual(threadToReopen(memory(), tasks, NORMAL), { task: undefined, fallback: true });
  for (const [id, expected] of [['a', 'a'], ['b', undefined], ['missing', undefined]]) {
    const store = memory();
    rememberOpenThread(store, id);
    assert.equal(threadToReopen(store, tasks, NORMAL).task?.id, expected);
  }
  const store = memory();
  rememberOpenThread(store, 'a'); rememberOpenThread(store, '');
  assert.equal(store.getItem(OPEN_THREAD_KEY), null, 'an empty id forgets it');
});

test('after a crash, a thread whose opening may have taken the app down is reported stuck once, and the next launch is normal', () => {
  const tasks = [{ id: 'a', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'a');
  assert.equal(threadToReopen(store, tasks, NORMAL).task?.id, 'a');
  beginThreadRestore(store, 'a');
  assert.equal(store.getItem(RESTORING_KEY), 'a', 'marked while it opens');
  // The app crashed while opening it: the mark is still there at the next boot, which follows a crash.
  assert.deepEqual(threadToReopen(store, tasks, CRASHED), { stuck: 'a', fallback: true });
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.equal(store.getItem(OPEN_THREAD_KEY), null);
  assert.deepEqual(threadToReopen(store, tasks, CRASHED), { task: undefined, fallback: true }, 'reported only once');
  // An opening that finishes clears the mark.
  rememberOpenThread(store, 'a'); beginThreadRestore(store, 'a'); finishThreadRestore(store);
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.equal(threadToReopen(store, tasks, CRASHED).task?.id, 'a');
});

test('a thread that took the app down while opening is held back, and the thread open before it reopens instead of the newest', () => {
  const tasks = [{ id: 'new', archived: false }, { id: 'a', archived: false }, { id: 'b', archived: false }];
  const store = memory();
  // In thread A; B opens, loads (remembered) and takes the app down while painting.
  rememberOpenThread(store, 'a');
  beginThreadRestore(store, 'b');
  assert.equal(store.getItem(PREVIOUS_THREAD_KEY), 'a', 'the thread open before it is kept with the mark');
  rememberOpenThread(store, 'b');
  assert.deepEqual(threadToReopen(store, tasks, CRASHED), { task: tasks[1], stuck: 'b', fallback: true });
  assert.equal(store.getItem(PREVIOUS_THREAD_KEY), null, 'cleared with the mark');
  assert.equal(store.getItem(RESTORING_KEY), null);
  // The previous thread archived or deleted since: the newest opens as before.
  for (const gone of [[tasks[0], { id: 'a', archived: true }, tasks[2]], [tasks[0], tasks[2]]]) {
    const again = memory();
    rememberOpenThread(again, 'a'); beginThreadRestore(again, 'b'); rememberOpenThread(again, 'b');
    assert.deepEqual(threadToReopen(again, gone, CRASHED), { stuck: 'b', fallback: true });
  }
  // Paused restarts still open nothing by themselves.
  const paused = memory();
  rememberOpenThread(paused, 'a'); beginThreadRestore(paused, 'b');
  assert.deepEqual(threadToReopen(paused, tasks, PAUSED), { stuck: 'b', fallback: false });
  // Reopening the same thread keeps no previous; a finished open clears it with its mark.
  const same = memory();
  rememberOpenThread(same, 'a'); beginThreadRestore(same, 'a');
  assert.equal(same.getItem(PREVIOUS_THREAD_KEY), null);
  beginThreadRestore(same, 'b'); finishThreadRestore(same, 'b');
  assert.equal(same.getItem(PREVIOUS_THREAD_KEY), null);
  assert.equal(same.getItem(RESTORING_KEY), null);
  // A superseded thread's finish leaves a later thread's mark and previous alone.
  beginThreadRestore(same, 'b'); finishThreadRestore(same, 'a');
  assert.equal(same.getItem(PREVIOUS_THREAD_KEY), 'a');
  leavePage(same);
  assert.equal(same.getItem(PREVIOUS_THREAD_KEY), null, 'an orderly exit clears it');
});

/** Fake timers and document for finishThreadRestoreAfterPaint. */
const paintEnv = () => {
  const timers = [], listeners = new Set();
  const doc = { visibilityState: 'visible', addEventListener: (_, run) => listeners.add(run), removeEventListener: (_, run) => listeners.delete(run) };
  const wait = (run, ms) => { timers.push({ run, ms, cancelled: false }); return timers.length - 1; };
  const cancel = handle => { timers[handle].cancelled = true; };
  const elapse = () => timers.filter(timer => !timer.cancelled).forEach(timer => { timer.cancelled = true; timer.run(); });
  const visibility = state => { doc.visibilityState = state; [...listeners].forEach(run => run()); };
  return { timers, listeners, doc, wait, cancel, elapse, visibility };
};
const afterPaint = (store, id, frame, env = paintEnv()) => finishThreadRestoreAfterPaint(store, id, frame, env.wait, env.cancel, env.doc);

test('the restoring mark is cleared only after the thread has painted: on the second animation frame', () => {
  const store = memory(), frames = [];
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', run => frames.push(run));
  assert.equal(store.getItem(RESTORING_KEY), 'a', 'not in the task that rendered it');
  frames.shift()();
  assert.equal(store.getItem(RESTORING_KEY), 'a', 'not before the first paint either');
  // A crash while laying out or painting leaves the mark, so the next boot keeps the thread closed.
  assert.deepEqual(threadToReopen(memory(Object.fromEntries(store.data)), [{ id: 'a', archived: false }], CRASHED), { stuck: 'a', fallback: true });
  frames.shift()();
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.equal(frames.length, 0);
});

const DIED = { crashed: false, paused: false, windowDied: true };

test('a first reload after the window died suspects only the marked thread; with no mark the remembered one reopens, noted', () => {
  const tasks = [{ id: 'a', archived: false }, { id: 'b', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'a');
  // It had finished loading: a single reload (often macOS ending the content under memory pressure) reopens it.
  assert.deepEqual(threadToReopen(store, tasks, DIED), { task: tasks[0], fallback: true }, 'a loaded thread is not held back');
  assert.equal(store.getItem(OPEN_THREAD_KEY), 'a', 'still remembered');
  assert.equal(store.getItem(WINDOW_DIED_KEY), 'a', 'but noted, in case the window dies again');
  const marked = memory();
  rememberOpenThread(marked, 'a'); beginThreadRestore(marked, 'b');
  assert.deepEqual(threadToReopen(marked, tasks, DIED), { task: tasks[0], stuck: 'b', fallback: true }, 'a thread that was mid-open is held back, and the one open before it comes back');
  assert.equal(marked.getItem(WINDOW_DIED_KEY), 'b');
  // A New task is no suspect, and comes back; the death is noted all the same.
  const fresh = memory();
  rememberOpenThread(fresh, 'draft-1', true);
  assert.deepEqual(threadToReopen(fresh, tasks, DIED), { newTask: true, fallback: true });
  assert.equal(fresh.getItem(WINDOW_DIED_KEY), '');
  // A crash notice alone never suspects a thread that had finished opening.
  const crashed = memory();
  rememberOpenThread(crashed, 'a');
  assert.equal(threadToReopen(crashed, tasks, CRASHED).task?.id, 'a');
  assert.equal(crashed.getItem(WINDOW_DIED_KEY), null);
});

test('the suspicion survives Restart PandaCode: the next launch, not a reload, honours the note once and opens nothing', () => {
  const tasks = [{ id: 'a', archived: false }, { id: 'b', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'a');
  assert.equal(threadToReopen(store, tasks, DIED).task?.id, 'a', 'the first reload reopens it');
  // The user then opened b (remembered once painted); the window died for good and the user chose Restart.
  rememberOpenThread(store, 'b');
  assert.deepEqual(threadToReopen(store, tasks, NORMAL), { stuck: 'a', fallback: false, windowDiedAgain: true });
  assert.equal(store.getItem(WINDOW_DIED_KEY), null, 'honoured once');
  assert.equal(store.getItem(OPEN_THREAD_KEY), null);
  assert.deepEqual(threadToReopen(store, tasks, NORMAL), { task: undefined, fallback: true }, 'the launch after that is normal');
});

test('a window that dies again before it proved stable opens nothing, and keeps its first suspect', () => {
  const tasks = [{ id: 'a', archived: false }, { id: 'b', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'a');
  assert.equal(threadToReopen(store, tasks, DIED).task?.id, 'a', 'the first reload reopens it');
  beginThreadRestore(store, 'b');
  assert.deepEqual(threadToReopen(store, tasks, DIED), { stuck: 'a', fallback: false, windowDiedAgain: true }, 'the second death holds back and names the noted thread');
  assert.equal(store.getItem(OPEN_THREAD_KEY), null);
  assert.equal(store.getItem(WINDOW_DIED_KEY), 'a', 'kept while the window keeps dying');
  assert.equal(store.getItem(RESTORING_KEY), null);
  // With no thread noted, the mark or the remembered thread is the suspect.
  const unnamed = memory({ [WINDOW_DIED_KEY]: '' });
  rememberOpenThread(unnamed, 'b');
  assert.deepEqual(threadToReopen(unnamed, tasks, DIED), { stuck: 'b', fallback: false, windowDiedAgain: true });
});

test('the note goes once the page has proved stable or closes in an orderly way', () => {
  assert.ok(WINDOW_STABLE_AFTER > 60_000, 'longer than the native reload budget window');
  for (const settle of [windowStable, pageClosed]) {
    const store = memory();
    rememberOpenThread(store, 'a');
    threadToReopen(store, [{ id: 'a', archived: false }], DIED);
    settle(store);
    assert.equal(store.getItem(WINDOW_DIED_KEY), null);
    rememberOpenThread(store, 'a');
    assert.equal(threadToReopen(store, [{ id: 'a', archived: false }], NORMAL).task?.id, 'a');
  }
});

test('a mark left by a quit during the last launch is cleared without a crash, and the thread reopens', () => {
  const tasks = [{ id: 'a', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'a'); beginThreadRestore(store, 'a');
  assert.deepEqual(threadToReopen(store, tasks, NORMAL), { task: tasks[0], fallback: true });
  assert.equal(store.getItem(RESTORING_KEY), null, 'the leftover mark is cleared');
  assert.equal(store.getItem(OPEN_THREAD_KEY), 'a', 'the thread stays remembered');
  // So it cannot count against a crash in a later launch.
  assert.equal(threadToReopen(store, tasks, CRASHED).task?.id, 'a');
});

test('a page reload is told apart from a fresh launch by its navigation type', async () => {
  const { reloadedPage } = await import('../src/launch-restore.ts');
  const original = globalThis.performance.getEntriesByType;
  try {
    for (const [type, expected] of [['reload', true], ['navigate', false]]) {
      globalThis.performance.getEntriesByType = () => [{ type }];
      assert.equal(reloadedPage(), expected, type);
    }
    globalThis.performance.getEntriesByType = () => [];
    assert.equal(reloadedPage(), false);
  } finally { globalThis.performance.getEntriesByType = original; }
});

test('paused restarts skip the reopen, forget the thread, and keep it from being opened instead', () => {
  const store = memory();
  rememberOpenThread(store, 'a');
  // No restoring marker (the crash came after the thread had loaded): the remembered thread is the suspect.
  assert.deepEqual(threadToReopen(store, [{ id: 'a', archived: false }], PAUSED), { stuck: 'a', fallback: false });
  assert.equal(store.getItem(OPEN_THREAD_KEY), null);
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.deepEqual(threadToReopen(store, [{ id: 'a', archived: false }], NORMAL), { task: undefined, fallback: true }, 'forgotten for the next launch');
});

test('paused restarts prefer the restoring marker over the remembered thread', () => {
  const store = memory();
  rememberOpenThread(store, 'a'); beginThreadRestore(store, 'b');
  assert.deepEqual(threadToReopen(store, [{ id: 'a', archived: false }, { id: 'b', archived: false }], PAUSED), { stuck: 'b', fallback: false });
});

test('paused restarts open no thread by itself, even with nothing remembered (the newest may be the one that crashes)', () => {
  assert.deepEqual(threadToReopen(memory(), [{ id: 'a', archived: false }], PAUSED), { stuck: undefined, fallback: false });
});

test('a New task open at exit reopens as a New task, unless it was sent since', () => {
  const tasks = [{ id: 'a', archived: false }];
  const store = memory();
  rememberOpenThread(store, 'draft-1', true);
  assert.equal(store.getItem(OPEN_NEW_TASK_KEY), '1');
  // fallback: if its project is gone (removed elsewhere while closed), boot opens the newest thread instead.
  assert.deepEqual(threadToReopen(store, tasks, NORMAL), { newTask: true, fallback: true });
  // Sent: the draft session is an ordinary listed thread now.
  assert.deepEqual(threadToReopen(store, [...tasks, { id: 'draft-1', archived: false }], NORMAL), { task: { id: 'draft-1', archived: false }, fallback: true });
  rememberOpenThread(store, 'a');
  assert.equal(store.getItem(OPEN_NEW_TASK_KEY), null, 'opening an ordinary thread forgets it');
});

test('an unsent New task reopens with its kept text even when boot holds threads back: paused, crashed with a mark, window dying again; a held-back thread beside it is not the last one (stuckNotLast)', () => {
  const tasks = [{ id: 'a', archived: false }, { id: 'b', archived: false }];
  // Paused: no thread opens by itself, but the New task page is no suspect (no transcript).
  let store = memory();
  rememberOpenThread(store, 'draft-1', true);
  assert.deepEqual(threadToReopen(store, tasks, PAUSED), { newTask: true, stuck: undefined, fallback: false });
  assert.equal(store.getItem(OPEN_NEW_TASK_KEY), '1', 'still remembered for the next launch');
  // Its own mark is no suspect either; another thread's mark is held back.
  store = memory();
  rememberOpenThread(store, 'draft-1', true); beginThreadRestore(store, 'draft-1');
  assert.deepEqual(threadToReopen(store, tasks, PAUSED), { newTask: true, stuck: undefined, fallback: false });
  store = memory();
  rememberOpenThread(store, 'draft-1', true); beginThreadRestore(store, 'b');
  assert.deepEqual(threadToReopen(store, tasks, CRASHED), { newTask: true, stuck: 'b', stuckNotLast: true, fallback: true }, 'a single crash still lets the newest thread open when the New task cannot');
  store = memory();
  rememberOpenThread(store, 'draft-1', true); beginThreadRestore(store, 'b');
  assert.deepEqual(threadToReopen(store, tasks, PAUSED), { newTask: true, stuck: 'b', stuckNotLast: true, fallback: false });
  // The window died again: the noted thread is named, the New task page still comes back.
  store = memory({ [WINDOW_DIED_KEY]: 'a' });
  rememberOpenThread(store, 'draft-1', true);
  assert.deepEqual(threadToReopen(store, tasks, DIED), { newTask: true, stuck: 'a', stuckNotLast: true, fallback: false, windowDiedAgain: true });
  // Sent since (listed, with a transcript): an ordinary suspect, held back as before.
  store = memory();
  rememberOpenThread(store, 'a', true);
  assert.deepEqual(threadToReopen(store, tasks, PAUSED), { stuck: 'a', fallback: false });
  assert.equal(store.getItem(OPEN_NEW_TASK_KEY), null);
});

test('a reload counts as the window content dying only when the last page never reached pagehide', async () => {
  const { windowContentDied, pageClosed, PAGE_ALIVE_KEY } = await import('../src/launch-restore.ts');
  const store = memory();
  assert.equal(windowContentDied(store, false), false, 'a fresh launch');
  assert.equal(store.getItem(PAGE_ALIVE_KEY), '1', 'this page is marked alive');
  assert.equal(windowContentDied(store, true), true, 'reloaded with the mark still there: no pagehide ran');
  pageClosed(store);
  assert.equal(store.getItem(PAGE_ALIVE_KEY), null);
  assert.equal(windowContentDied(store, true), false, 'an orderly reload ran pagehide');
  assert.equal(windowContentDied(memory({ [PAGE_ALIVE_KEY]: '1' }), false), false, 'a fresh launch after a crash is not a reload');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(windowContentDied(broken, true), false, 'unreadable storage never claims a dead window');
});

const { draftThreadBatches, dropDeletedDrafts, MISSING_BATCH, MAX_SESSION_ID } = await import('../src/launch-restore.ts');
const quietAsync = async fn => { const warn = console.warn; let warned = 0; console.warn = () => { warned++; }; try { await fn(); } finally { console.warn = warn; } assert.equal(warned, 1, 'logged once'); };

test('the drafts asked about are per-thread ones only, in batches the native command accepts', () => {
  assert.equal(MISSING_BATCH, 2000);
  assert.equal(MAX_SESSION_ID, 128);
  const ids = Array.from({ length: 4001 }, (_, index) => `t${index}`);
  const batches = draftThreadBatches([...ids, NEW_TASK_DRAFT + 'p', 'x'.repeat(129), '']);
  assert.deepEqual(batches.map(batch => batch.length), [2000, 2000, 1]);
  assert.deepEqual(batches.flat(), ids, 'no New task key, no id the command would refuse');
  assert.deepEqual(draftThreadBatches([NEW_TASK_DRAFT + 'p']), []);
});

test('drafts of threads deleted while the app was closed are dropped; a failing check changes nothing', async () => {
  const load = () => new PersistedDrafts(memory({
    [DRAFT_PREFIX + 'kept']: stored('mine'), [DRAFT_PREFIX + 'gone']: stored('lost'), [DRAFT_PREFIX + NEW_TASK_DRAFT + 'p']: stored('new'),
  }), () => NOW);
  const drafts = load(), asked = [];
  await dropDeletedDrafts(drafts, async ids => { asked.push(ids); return ['gone', 'not-asked']; });
  assert.deepEqual(asked, [['kept', 'gone']]);
  assert.deepEqual([...drafts.keys()].sort(), ['kept', NEW_TASK_DRAFT + 'p']);
  for (const fail of [async () => { throw new Error('no such command'); }, async () => 'nonsense']) {
    const untouched = load();
    await quietAsync(() => dropDeletedDrafts(untouched, fail));
    assert.equal(untouched.size, 3);
  }
  // Nothing to ask about: no call.
  let calls = 0;
  await dropDeletedDrafts(new PersistedDrafts(memory(), () => NOW), async () => { calls++; return []; });
  assert.equal(calls, 0);
});

test('at boot the New task text of projects that no longer exist is dropped, from memory and storage', async () => {
  const { dropRemovedProjectDrafts } = await import('../src/launch-restore.ts');
  const store = memory({
    [DRAFT_PREFIX + 'thread']: stored('mine'), [DRAFT_PREFIX + NEW_TASK_DRAFT + 'kept']: stored('new here'), [DRAFT_PREFIX + NEW_TASK_DRAFT + 'removed']: stored('new there'),
  });
  const drafts = new PersistedDrafts(store, () => NOW);
  dropRemovedProjectDrafts(drafts, ['kept', 'other']);
  assert.deepEqual([...drafts.keys()].sort(), [NEW_TASK_DRAFT + 'kept', 'thread'], 'thread drafts are never judged by the project list');
  assert.equal(store.getItem(DRAFT_PREFIX + NEW_TASK_DRAFT + 'removed'), null);
  assert.ok(store.getItem(DRAFT_PREFIX + NEW_TASK_DRAFT + 'kept'));
  // An empty project list that loaded is real: no project keeps New task text.
  dropRemovedProjectDrafts(drafts, []);
  assert.deepEqual([...drafts.keys()], ['thread']);
});

test('main.ts drops removed projects\' New task text only after list_projects answered', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const listed = source.indexOf("[state.projects, state.sessions, state.providers] = await Promise.all([call<Project[]>('list_projects')");
  const dropped = source.indexOf('dropRemovedProjectDrafts(state.drafts, state.projects.map(');
  assert.ok(listed > 0 && dropped > listed, 'called once the awaited list (which throws on failure) is in');
  assert.equal(source.split('dropRemovedProjectDrafts(').length, 2, 'called once, at boot');
});

test('a thread finishing or failing clears only its own mark, so quick switches never leave a stale one', () => {
  const store = memory(), frames = [];
  // A painted, B opened before A's second frame: A's late finish leaves B's mark.
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', run => frames.push(run));
  beginThreadRestore(store, 'b');
  frames.shift()(); frames.shift()();
  assert.equal(store.getItem(RESTORING_KEY), 'b', 'the later thread keeps its mark');
  // B superseded by C, which fails: C's failure clears C; B's early return clears nothing of C's.
  beginThreadRestore(store, 'c');
  finishThreadRestore(store, 'b');
  assert.equal(store.getItem(RESTORING_KEY), 'c');
  finishThreadRestore(store, 'c');
  assert.equal(store.getItem(RESTORING_KEY), null, 'a failed load is not a thread that took the app down');
  // A superseded load whose mark is still its own (nothing else opened) clears it.
  beginThreadRestore(store, 'd');
  finishThreadRestore(store, 'd');
  assert.equal(store.getItem(RESTORING_KEY), null);
  // Leaving the page clears any mark.
  beginThreadRestore(store, 'e');
  finishThreadRestore(store);
  assert.equal(store.getItem(RESTORING_KEY), null);
});

test('a window that paints nothing still clears the mark: after PAINT_WAIT, or when it becomes hidden, only that thread’s', () => {
  // No animation frames run (covered or minimised): the timer clears it.
  let store = memory(), env = paintEnv();
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', () => undefined, env);
  assert.equal(PAINT_WAIT, 5000);
  assert.equal(env.timers[0].ms, PAINT_WAIT);
  env.visibility('visible');
  assert.equal(store.getItem(RESTORING_KEY), 'a', 'showing again is not a reason');
  env.elapse();
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.equal(env.listeners.size, 0, 'and stops listening');
  // Hidden after rendering: cleared at once, and the timer is cancelled.
  store = memory(); env = paintEnv();
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', () => undefined, env);
  env.visibility('hidden');
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.ok(env.timers[0].cancelled);
  // A later thread's mark survives the earlier thread's timer and hide.
  store = memory(); env = paintEnv();
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', () => undefined, env);
  beginThreadRestore(store, 'b');
  env.elapse();
  assert.equal(store.getItem(RESTORING_KEY), 'b');
  // Painted first: the timer and listener go with it.
  store = memory(); env = paintEnv();
  const frames = [];
  beginThreadRestore(store, 'a');
  afterPaint(store, 'a', run => frames.push(run), env);
  frames.shift()(); frames.shift()();
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.ok(env.timers[0].cancelled);
  assert.equal(env.listeners.size, 0);
});

test('a thread the user opened that takes the app down while painting is held back at the first crash', () => {
  const store = memory(), tasks = [{ id: 'a', archived: false }, { id: 'b', archived: false }];
  // Boot's thread painted; then the user opened b, which crashed the app before its second frame.
  rememberOpenThread(store, 'a');
  beginThreadRestore(store, 'b');
  afterPaint(store, 'b', () => undefined);
  assert.deepEqual(threadToReopen(store, tasks, CRASHED), { task: tasks[0], stuck: 'b', fallback: true }, 'and a, open before it, comes back');
});

test('an orderly exit (pagehide or app-quitting) clears the window note, the restoring mark and the alive key', () => {
  const store = memory({ [WINDOW_DIED_KEY]: 'a', [RESTORING_KEY]: 'a', [PAGE_ALIVE_KEY]: '1' });
  leavePage(store);
  assert.equal(store.getItem(WINDOW_DIED_KEY), null);
  assert.equal(store.getItem(RESTORING_KEY), null);
  assert.equal(store.getItem(PAGE_ALIVE_KEY), null);
  // The next normal launch then opens the remembered thread with no window-death note.
  rememberOpenThread(store, 'a');
  assert.deepEqual(threadToReopen(store, [{ id: 'a', archived: false }], NORMAL), { task: { id: 'a', archived: false }, fallback: true });
  // A failing store never throws.
  const broken = { getItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => leavePage(broken));
});

test('a draft dated more than a day ahead (the clock ran ahead) is dropped at launch and while running', () => {
  assert.equal(DRAFT_FUTURE_SLACK, 24 * 60 * 60 * 1000);
  const store = memory({
    [`${DRAFT_PREFIX}ahead`]: stored('from the future', NOW + DRAFT_FUTURE_SLACK + 1),
    [`${DRAFT_PREFIX}slightly`]: stored('a little ahead', NOW + DRAFT_FUTURE_SLACK),
  });
  const drafts = new PersistedDrafts(store, () => NOW);
  assert.equal(drafts.get('ahead'), undefined);
  assert.equal(store.getItem(`${DRAFT_PREFIX}ahead`), null);
  assert.equal(drafts.get('slightly'), 'a little ahead');
  // The clock goes back by more than a day while the app runs: expire drops it.
  let now = NOW;
  const running = new PersistedDrafts(memory(), () => now);
  running.set('typed', 'hello');
  now = NOW - DRAFT_FUTURE_SLACK - 1;
  running.expire();
  assert.equal(running.get('typed'), undefined);
});

test('a shared channel\'s composer text is kept like a thread\'s, under its own key, and never asked about as a thread', async () => {
  const { CHANNEL_DRAFT, channelDraftKey, dropRemovedChannelDrafts } = await import('../src/launch-restore.ts');
  assert.equal(channelDraftKey('c1'), 'channel:c1');
  const store = memory();
  const drafts = new PersistedDrafts(store, () => NOW);
  // Written at once, every keystroke.
  drafts.set(channelDraftKey('c1'), 'hello @Ada');
  assert.deepEqual(decodeDraft(store.getItem('pandacode.draft:channel:c1')), { t: NOW, text: 'hello @Ada' });
  // Read back on the next launch (after a crash).
  assert.equal(new PersistedDrafts(store, () => NOW).get(channelDraftKey('c1')), 'hello @Ada');
  // Same cap and expiry as thread drafts.
  drafts.set(channelDraftKey('big'), 'x'.repeat(MAX_DRAFT_CHARS + 1));
  assert.equal(store.getItem(DRAFT_PREFIX + channelDraftKey('big')), null);
  assert.equal(new PersistedDrafts(store, () => NOW + DRAFT_MAX_AGE + 1).get(channelDraftKey('c1')), undefined);
  assert.equal(store.getItem(DRAFT_PREFIX + channelDraftKey('c1')), null);
  // Sent: gone from storage at once.
  drafts.set(channelDraftKey('c2'), 'sent soon');
  drafts.delete(channelDraftKey('c2'));
  assert.equal(store.getItem(DRAFT_PREFIX + channelDraftKey('c2')), null);
  // A bare prefix is malformed.
  assert.equal(new PersistedDrafts(memory({ [DRAFT_PREFIX + CHANNEL_DRAFT]: stored('x') }), () => NOW).size, 0);
  // Channel keys are not thread ids.
  assert.deepEqual(draftThreadBatches([channelDraftKey('c1'), 'thread']), [['thread']]);
  let asked = [];
  const both = new PersistedDrafts(memory({ [DRAFT_PREFIX + 'thread']: stored('t'), [DRAFT_PREFIX + channelDraftKey('c3')]: stored('c') }), () => NOW);
  await dropDeletedDrafts(both, async ids => { asked = ids; return ids; });
  assert.deepEqual(asked, ['thread']);
  assert.deepEqual([...both.keys()], [channelDraftKey('c3')]);
});

test('channel text goes once a loaded channel list lacks its channel; thread and New task drafts are not judged by it', async () => {
  const { channelDraftKey, dropRemovedChannelDrafts } = await import('../src/launch-restore.ts');
  const store = memory({
    [DRAFT_PREFIX + 'thread']: stored('mine'), [DRAFT_PREFIX + NEW_TASK_DRAFT + 'p']: stored('new'),
    [DRAFT_PREFIX + channelDraftKey('kept')]: stored('here'), [DRAFT_PREFIX + channelDraftKey('gone')]: stored('there'),
  });
  const drafts = new PersistedDrafts(store, () => NOW);
  dropRemovedChannelDrafts(drafts, ['kept', 'other']);
  assert.deepEqual([...drafts.keys()].sort(), [channelDraftKey('kept'), NEW_TASK_DRAFT + 'p', 'thread']);
  assert.equal(store.getItem(DRAFT_PREFIX + channelDraftKey('gone')), null);
  dropRemovedChannelDrafts(drafts, []);
  assert.deepEqual([...drafts.keys()].sort(), [NEW_TASK_DRAFT + 'p', 'thread']);
});

test('main.ts keeps shared channel text in the persisted drafts and drops it only after bot_shared_channels answered', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('sharedChannelDrafts'), 'no in-memory-only channel drafts');
  assert.match(source, /call<SharedChannelSummary\[\]>\('bot_shared_channels'\)\.then\(channels => \{[^]*?dropRemovedChannelDrafts\(state\.drafts[^]*?\}\)\.catch\(/);
});

test('clearing saved drafts removes every stored one, keeps only the shown composer text in memory, unstored until its next change', () => {
  const store = memory({ 'pandacode.other': 'x', [DRAFT_PREFIX + 'new:p2']: stored('kept for a project'), [DRAFT_PREFIX + 'channel:c1']: stored('channel text') });
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = id => id === 'n1' ? NEW_TASK_DRAFT + 'p' : undefined;
  drafts.set('t1', 'a pasted secret'); drafts.set('t2', 'shown'); drafts.set('n1', 'new task text');
  store.setItem(DRAFT_PREFIX + 'from-another-window', stored('elsewhere'));
  drafts.clearStored(id => id === 't2' || id === 'n1');
  assert.deepEqual([...store.data.keys()], ['pandacode.other'], 'nothing under the draft prefix is left');
  assert.equal(drafts.get('t1'), undefined, 'not shown: gone from memory too');
  assert.equal(drafts.get('channel:c1'), undefined);
  assert.equal(drafts.get('t2'), 'shown', 'the open composer keeps its text');
  assert.equal(drafts.get('n1'), 'new task text');
  drafts.set('t2', 'shown, edited'); drafts.set('n1', 'new task text, edited');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 't2')).text, 'shown, edited', 'stored again on its next change');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 'new:p')).text, 'new task text, edited', 'a New task under its project again');
  drafts.clearStored();
  assert.equal(drafts.size, 0);
  assert.deepEqual([...store.data.keys()], ['pandacode.other']);
});

test('Keep unsent drafts off: nothing is written, every stored draft goes at once, nothing is restored; on again, writes resume from the next edit', async () => {
  const { KEEP_DRAFTS_KEY, channelDraftKey } = await import('../src/launch-restore.ts');
  const store = memory({ 'pandacode.other': 'x', [DRAFT_PREFIX + 'old']: stored('a pasted secret'), [DRAFT_PREFIX + 'channel:c1']: stored('channel text') });
  const drafts = new PersistedDrafts(store, () => NOW);
  drafts.newTaskKey = id => id === 'n1' ? NEW_TASK_DRAFT + 'p' : undefined;
  drafts.set('t1', 'typed before');
  assert.equal(drafts.keepsDrafts, true, 'on by default');
  drafts.setKeeping(false);
  assert.equal(store.getItem(KEEP_DRAFTS_KEY), 'off');
  assert.deepEqual([...store.data.keys()].sort(), [KEEP_DRAFTS_KEY, 'pandacode.other'], 'every stored draft removed at once');
  assert.equal(drafts.get('t1'), 'typed before', 'text already typed stays in memory for this launch');
  store.writes.length = 0;
  drafts.set('t1', 'typed after'); drafts.set('n1', 'new task'); drafts.set(channelDraftKey('c2'), 'channel');
  assert.deepEqual(store.writes, [], 'thread, New task and channel text: no writes');
  assert.equal(drafts.get('t1'), 'typed after');
  // The next launch restores nothing, and removes a draft another window wrote.
  store.setItem(DRAFT_PREFIX + 'elsewhere', stored('x'));
  const next = new PersistedDrafts(store, () => NOW);
  assert.equal(next.size, 0);
  assert.equal(next.keepsDrafts, false);
  assert.deepEqual([...store.data.keys()].sort(), [KEEP_DRAFTS_KEY, 'pandacode.other']);
  // On again: stored from the next edit, and read back at the next launch.
  next.setKeeping(true);
  assert.equal(store.getItem(KEEP_DRAFTS_KEY), null);
  next.set('t1', 'kept again');
  assert.equal(decodeDraft(store.getItem(DRAFT_PREFIX + 't1')).text, 'kept again');
  assert.equal(new PersistedDrafts(store, () => NOW).get('t1'), 'kept again');
});
