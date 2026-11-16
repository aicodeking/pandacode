import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// These modules import browser UI; exercise their real cache logic with inert imports.
function load(name, globals = {}) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  new Function('exports', 'require', ...Object.keys(globals), outputText)(exports, () => ({}), ...Object.values(globals));
  return exports;
}

test('a deferred Markdown builder does not retain its detached target or scroll container', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import ts from 'typescript';
    let build;
    const exports = {};
    const source = readFileSync('src/streaming-markdown.ts', 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    const require = name => name === './dom.ts' ? {
      markdownCache: { defer: (_, fn) => { build = fn; }, forgo() {} },
      markdownHtml: async text => '<p>' + text + '</p>',
    } : { captureFileLinkContext: () => undefined };
    new Function('exports', 'require', 'Text', outputText)(exports, require, class {});
    const refs = (() => {
      const target = { isConnected: false, firstChild: null }, scroll = {};
      exports.streamMarkdown(target, 'hello', scroll);
      return [new WeakRef(target), new WeakRef(scroll)];
    })();
    await new Promise(setImmediate);
    global.gc();
    await new Promise(setImmediate);
    global.gc();
    for (const ref of refs) assert.equal(ref.deref(), undefined);
    assert.equal(await build(), '<p>hello</p>');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
});

test('file cache counts UTF-16 text and binary bytes together, preserving the shown tab and office reader state', () => {
  const { trimDocumentCache } = load('file-tabs');
  const office = { aspectRatios: [0.75], anchor: { page: 4, fraction: 0.25 }, actual: true, imageScrollLeft: 120 };
  const shown = { content: 'shown'.repeat(100), used: 1 };
  const oldest = { content: 'abc', used: 2, office };
  const recent = { content: new ArrayBuffer(4), used: 3 };
  const newest = { content: '😀x', used: 4 };
  trimDocumentCache([shown, oldest, recent, newest], shown, 10);
  assert.equal(shown.content.length, 500);
  assert.equal(oldest.content, undefined);
  assert.equal(oldest.evictedBytes, 6);
  assert.equal(oldest.office, office);
  assert.equal(recent.content.byteLength, 4);
  assert.equal(newest.content, '😀x');
});

test('file cache evicts oversized text and tolerates empty and already evicted entries', () => {
  const { trimDocumentCache } = load('file-tabs');
  const tabs = [{ content: 'large', used: 3 }, { content: '' }, {}];
  trimDocumentCache(tabs, undefined, 4);
  assert.equal(tabs[0].content, undefined);
  assert.equal(tabs[1].content, '');
  trimDocumentCache(tabs, undefined, 4);
});

test('PR caches cap details and pending patches by count while protecting the mounted PR', () => {
  const { trimPullCaches } = load('github-pull');
  const details = new Map(Array.from({ length: 25 }, (_, i) => [`pr${i}`, {}]));
  const diffs = new Map(Array.from({ length: 25 }, (_, i) => [`pr${i}`, { bytes: 0 }]));
  trimPullCaches(details, diffs, 'pr0');
  assert.equal(details.size, 20);
  assert.equal(diffs.size, 20);
  for (const cache of [details, diffs]) {
    assert.ok(cache.has('pr0'));
    assert.ok(!cache.has('pr1'));
    assert.ok(cache.has('pr24'));
  }
});

test('PR patch bytes evict oldest entries and oversized mounted patches leave on disposal', () => {
  const { trimPullCaches } = load('github-pull');
  const mb = 1024 * 1024;
  const diffs = new Map([['mounted', { bytes: 20 * mb }], ['old', { bytes: mb }], ['new', { bytes: mb }]]);
  trimPullCaches(new Map(), diffs, 'mounted');
  assert.deepEqual([...diffs.keys()], ['mounted']);
  trimPullCaches(new Map(), diffs);
  assert.equal(diffs.size, 0);
  const fitting = new Map([['old', { bytes: 10 * mb }], ['new', { bytes: 8 * mb }]]);
  trimPullCaches(new Map(), fitting);
  assert.deepEqual([...fitting.keys()], ['new']);
});

test('elapsed clock stops for hidden or empty lists and catches up immediately on reveal', () => {
  const timers = new Map(), listeners = new Map(), observations = [];
  let sync, disconnected = false;
  let now = 3000;
  const age = { dataset: { started: '0' }, textContent: '' };
  const root = {
    visible: false, populated: true, parentElement: null,
    getClientRects() { return this.visible ? [{}] : []; },
    querySelector() { return this.populated ? age : null; },
    querySelectorAll() { return this.populated ? [age] : []; },
  };
  const document = { hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const { startElapsedTick } = load('agents-dock', { document, Date: { now: () => now },
    window: { setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) },
    getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class {
      constructor(fn) { sync = fn; }
      observe(node, options) { observations.push({ node, options }); }
      disconnect() { disconnected = true; }
    },
  });
  const stop = startElapsedTick(root);
  assert.equal(timers.size, 0);
  assert.ok(observations.some(({ node, options }) => node === root && options.childList && options.subtree && options.attributes));
  root.visible = true; sync();
  assert.equal(timers.size, 1);
  assert.match(age.textContent, /^3s$/);
  document.hidden = true; listeners.get('visibilitychange')();
  assert.equal(timers.size, 0);
  now = 12000;
  document.hidden = false; listeners.get('visibilitychange')();
  assert.match(age.textContent, /^12s$/);
  root.populated = false; sync();
  assert.equal(timers.size, 0);
  root.populated = true; sync();
  assert.equal(timers.size, 1);
  root.visible = false; sync();
  assert.equal(timers.size, 0);
  stop();
  assert.equal(disconnected, true);
  assert.equal(listeners.size, 0);
});


test('detached thread rows reuse ordinary windows and evict by count, markup size and widened history', () => {
  const { leftRowsCache } = load('transcript-view');
  const node = { parentNode: null, contains: other => other === node };
  const entry = (html, trimmed = new Map()) => ({ rows: [{ html, nodes: [node] }], trimmed, keys: ['1'] });
  const cache = leftRowsCache(2, 10, 3);
  const ordinary = entry('abc');
  cache.keep('first', ordinary);
  assert.equal(cache.holds(node), true);
  assert.equal(cache.take('first'), ordinary, 'a normal return reuses the same DOM');
  assert.equal(cache.take('first'), undefined, 'a return consumes the entry');
  for (const id of ['first', 'second', 'third']) cache.keep(id, entry('abc'));
  assert.equal(cache.take('first'), undefined, 'oldest thread leaves the count budget');
  cache.keep('big', entry('abcdefghij'));
  assert.equal(cache.take('second'), undefined, 'old markup leaves the size budget');
  assert.ok(cache.take('big'));
  cache.keep('oversized', entry('abcdefghijk'));
  assert.equal(cache.take('oversized'), undefined, 'one oversized transcript is not retained');
  cache.keep('wide', entry('', new Map([['a', {}], ['b', {}], ['c', {}]])));
  assert.equal(cache.take('wide'), undefined, 'trimmed reader state also counts toward the row budget');
  const attached = { parentNode: {} };
  cache.keep('attached', { rows: [{ html: '', nodes: [attached] }], trimmed: new Map(), keys: ['1'] });
  assert.equal(cache.take('attached'), undefined, 'nodes already adopted elsewhere are not reused');
});
