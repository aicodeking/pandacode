import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';

// M10 compatibility corpus: every shipped fixture/example manifest, the supported API-1 range
// spellings, the negative corpus categories and the E01-E31 evidence map stay valid together.
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const text = path => readFileSync(new URL(path, root), 'utf8');
const corpus = read('tests/fixtures/extensions/compatibility-corpus.json');
const contracts = read('tests/fixtures/extensions/contracts-v1.json');
const scale = read('tests/fixtures/extensions/performance-scale.json');
const sample = read('tests/fixtures/extensions/sample-project-helper/extension.json');

// Fixtures that are deliberately not installable packages: each is a test-only slice read by one runtime spec or native
// test (a bare service entry, a band icon token, a manifest without code). They must keep failing validation, so the
// list cannot rot; remove an entry when its fixture becomes a valid package.
const PARTIAL = new Map([
  ['tests/fixtures/extensions/runtime-composer-band/extension.json', 'band item icon is a display token, not a declared icon id'],
  ['tests/fixtures/extensions/runtime-document-editors/extension.json', 'editor slice: code folders only, no main.cjs entrypoint'],
  ['tests/fixtures/extensions/runtime-new-file-templates/extension.json', 'template slice: code folders only, no main.cjs entrypoint'],
  ['tests/fixtures/extensions/runtime-held-credentials/extension.json', 'connections are bound to commands by the spec, not declared as runnable commands'],
  ['tests/fixtures/extensions/runtime-model-call/extension.json', 'service slice without manifestVersion (driven by cases.json)'],
  ['tests/fixtures/extensions/runtime-preview/extension.json', 'preview service slice with a service.mjs entrypoint'],
  ['tests/fixtures/extensions/runtime-rich-channel/extension.json', 'channel service slice with a service.mjs entrypoint'],
]);

function manifests() {
  const found = [];
  for (const [base, nested] of [['tests/fixtures/extensions/', ''], ['examples/extensions/', 'package/']]) {
    for (const entry of readdirSync(new URL(base, root), { withFileTypes: true })) {
      const path = `${base}${entry.name}/${nested}extension.json`;
      if (entry.isDirectory() && existsSync(new URL(path, root))) found.push(path);
    }
  }
  return found.sort();
}

function nativeSources() {
  const sources = [];
  const visit = url => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, url);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.rs')) sources.push(readFileSync(child, 'utf8'));
    }
  };
  visit(new URL('src-tauri/src/extensions/', root));
  return sources.join('\n');
}

/** The same deterministic packages tests/extensions-performance.spec.ts and contracts.rs generate. */
function scalePackages() {
  const pad = (value, size) => String(value).padStart(size, '0');
  return Array.from({ length: scale.packages }, (_, p) => {
    const id = `${scale.publisher}.ext-${pad(p + 1, 2)}`;
    const commands = Array.from({ length: scale.perContextLocation }, (_, c) => ({ id: `${id}/run-${c + 1}`, title: `Perf ${pad(p + 1, 2)} action ${c + 1}`, action: { kind: 'showMessage', message: `Perf ${pad(p + 1, 2)} action ${c + 1}` } }));
    const menus = scale.visibleLocations.map((location, v) => ({ id: `${id}/visible-${v + 1}`, location, command: commands[0].id, presentation: 'button', text: `P${pad(p + 1, 2)}`, group: 'extensions', order: p }));
    for (const location of scale.contextLocations) for (const command of commands) menus.push({ id: `${id}/m-${pad(menus.length + 1, 3)}`, location, command: command.id, group: 'extensions', order: p });
    return { manifestVersion: 1, id, version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui', permissions: ['ui.contribute'], contributes: { commands, menus } };
  });
}

test('extensions compatibility: every shipped fixture and author example validates under the current API 1 contract', () => {
  const paths = manifests();
  assert.ok(paths.length >= 40, `expected the full fixture corpus, found ${paths.length}`);
  const byId = new Map(paths.map(path => [read(path).id, read(path)]));
  // A dependent package activates together with its declared providers, as the host requires.
  const batch = (manifest, seen = new Set()) => { if (seen.has(manifest.id)) return []; seen.add(manifest.id); return [...Object.keys(manifest.dependencies ?? {}).flatMap(id => byId.has(id) ? batch(byId.get(id), seen) : []), manifest]; };
  const failures = paths.filter(path => !PARTIAL.has(path)).map(path => [path, validateContract('packages', batch(read(path)))]).filter(([, result]) => !result.ok).map(([path, result]) => `${path}: ${result.error.code} ${result.error.path}`);
  assert.deepEqual(failures, []);
  for (const [path] of PARTIAL) { assert.ok(paths.includes(path), `${path} no longer exists: drop it from PARTIAL`); assert.equal(validateContract('packages', batch(read(path))).ok, false, `${path} is a valid package now: drop it from PARTIAL`); }
  for (const path of paths.filter(path => !PARTIAL.has(path))) assert.equal(read(path).manifestVersion, 1, path);
});

test('extensions compatibility: every fixture accepts each supported API 1 range spelling and refuses the rest with the same code', () => {
  // One range corpus (T58's examples-v1.json), applied here to the whole fixture corpus, not one sample.
  const { apiRanges } = read('tests/fixtures/extensions/examples-v1.json');
  const fixtures = manifests().filter(path => path.startsWith('tests/') && !PARTIAL.has(path)).map(read).filter(manifest => !manifest.dependencies);
  assert.ok(fixtures.length >= 40);
  const failures = [];
  for (const manifest of fixtures) {
    for (const range of apiRanges.accepted) { const result = validateContract('packages', [{ ...structuredClone(manifest), engines: { pandacodeApi: range } }]); if (!result.ok) failures.push(`${manifest.id} ${range}: ${result.error.code}`); }
    for (const { range, code } of apiRanges.rejected) { const result = validateContract('packages', [{ ...structuredClone(manifest), engines: { pandacodeApi: range } }]); if (result.error?.code !== code) failures.push(`${manifest.id} ${range}: ${result.error?.code ?? 'accepted'} instead of ${code}`); }
  }
  assert.deepEqual(failures, []);
  assert.equal(validateContract('packages', [{ ...structuredClone(sample), manifestVersion: 2 }]).ok, false, 'manifest version 2 is not silently accepted');
});

test('extensions compatibility: negative corpus keeps every required failure category in both validators', () => {
  const names = new Set(contracts.cases.map(item => `${item.kind} | ${item.name}`));
  for (const [category, name] of Object.entries(corpus.negativeCorpus)) assert.ok(names.has(name), `${category}: missing contracts-v1 case "${name}"`);
  const native = nativeSources();
  assert.ok(native.includes('tests/fixtures/extensions/contracts-v1.json'), 'the native validator executes the same corpus');
  for (const [category, functions] of Object.entries(corpus.nativeNegative)) for (const name of functions) assert.match(native, new RegExp(`fn ${name}\\(`), `${category}: ${name}`);
});

test('extensions compatibility: E01-E31 each name existing, registered automated evidence', () => {
  const ids = Object.keys(corpus.requirements);
  assert.deepEqual(ids, Array.from({ length: 31 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`));
  const native = nativeSources();
  const chromium = text('playwright.config.ts'), webkit = text('playwright.webkit.config.ts');
  const missing = [];
  for (const [id, row] of Object.entries(corpus.requirements)) {
    assert.ok(row.title && (row.browser?.length || row.node?.length || row.native?.length), `${id} has evidence`);
    for (const path of [...row.browser ?? [], ...row.node ?? []]) if (!existsSync(new URL(path, root))) missing.push(`${id}: ${path}`);
    for (const path of row.browser ?? []) {
      const name = path.split('/').pop();
      if (!chromium.includes(`**/${name}`)) missing.push(`${id}: ${name} not registered in playwright.config.ts`);
      if (!webkit.includes(`**/${name}`) && !chromium.includes(`**/${name}`)) missing.push(`${id}: ${name} not registered for WebKit`);
    }
    for (const name of row.native ?? []) if (!new RegExp(`fn ${name}\\(`).test(native)) missing.push(`${id}: native ${name}`);
  }
  assert.deepEqual(missing, []);
  assert.match(corpus.nativeQualification, /deferred/, 'installed/device qualification stays an explicit gap');
});

// The pre-M10 topological order re-sorted every remaining node per step (10 s at this size). The
// linear replacement must return exactly what that algorithm returned, including cycle errors.
function referenceOrder(nodes, edges, rank) {
  const remaining = new Set(nodes), result = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => !edges.some(([from, to]) => to === id && remaining.has(from))).sort(rank);
    if (!ready.length) return { cycle: [...remaining].sort() };
    remaining.delete(ready[0]); result.push(ready[0]);
  }
  return { order: result };
}

test('extensions compatibility: linear menu ordering equals the original order on random constraint graphs', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const locations = ['panda.workspace.header.actions', 'panda.sidebar.footer', 'panda.sidebar.task.context'];
  for (let round = 0; round < 200; round++) {
    const count = 2 + Math.floor(random() * 9);
    const menus = Array.from({ length: count }, (_, i) => ({ id: `sample.order/m-${i}`, location: locations[Math.floor(random() * locations.length)], command: 'sample.order/run', group: random() < .5 ? 'a' : 'b', order: Math.floor(random() * 3) }));
    const edges = [];
    for (const menu of menus) for (const key of ['before', 'after']) {
      const peers = menus.filter(other => other.location === menu.location && (random() < .3 || other === menu && random() < .05));
      if (peers.length) { menu[key] = peers.map(peer => peer.id); for (const peer of peers) edges.push(key === 'before' ? [menu.id, peer.id] : [peer.id, menu.id]); }
    }
    const manifest = { manifestVersion: 1, id: 'sample.order', version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui', permissions: ['ui.contribute'], contributes: { commands: [{ id: 'sample.order/run', title: 'Run', action: { kind: 'showMessage', message: 'Run' } }], menus } };
    const byId = new Map(menus.map(menu => [menu.id, menu]));
    const cmp = (x, y) => x < y ? -1 : x > y ? 1 : 0;
    const expected = referenceOrder(menus.map(menu => menu.id), edges, (a, b) => {
      const left = byId.get(a), right = byId.get(b);
      return cmp(left.location, right.location) || cmp(left.group, right.group) || left.order - right.order || cmp(a, b);
    });
    const actual = validateContract('packages', [manifest]);
    if (expected.cycle) assert.deepEqual([actual.error?.code, actual.error?.ids], ['OrderingCycle', expected.cycle], `round ${round}`);
    else assert.deepEqual(actual.value?.menuOrder, expected.order, `round ${round}`);
  }
});

test('extensions compatibility: 1,000 contributions across 20 packages validate in bounded time, independent of input order', () => {
  const packages = scalePackages();
  assert.equal(packages.reduce((sum, item) => sum + item.contributes.menus.length, 0), scale.packages * scale.contributionsPerPackage);
  const started = performance.now();
  const result = validateContract('packages', packages);
  const elapsed = performance.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.value.menuOrder.length, 1000);
  assert.equal(result.value.menuOrder[0], 'perf.ext-01/m-035', 'same first entry as the native twin');
  assert.deepEqual(validateContract('packages', [...packages].reverse()).value.menuOrder, result.value.menuOrder);
  // About 20 ms now; the cubic predecessor took about 10 s on the same machine.
  assert.ok(elapsed < 2000, `${elapsed} ms`);
});

test('validator fast paths keep code-point limits and the UTF-8 byte budget (Board scale)', () => {
  const presentation = (rows, title) => ({ contractVersion: 1, window: 'main', context: 'c', project: 'p', task: '', filter: '', revision: 1, visible: true, loading: false, busy: false, detail: false, importable: false, truncated: false,
    rows: Array.from({ length: rows }, (_, index) => ({ id: `row-${index}`, project: 'p', revision: 1, stage: 'pending', title, running: false, busy: false, archived: false })) });
  // maxLength counts code points: 200 astral characters (400 UTF-16 units) fit, 201 do not.
  assert.equal(validateContract('boardPresentation', presentation(1, '\u{1F600}'.repeat(200))).ok, true);
  assert.equal(validateContract('boardPresentation', presentation(1, '\u{1F600}'.repeat(201))).ok, false);
  assert.equal(validateContract('boardPresentation', presentation(1, '\u00e9'.repeat(200))).ok, true);
  // The byte budget counts UTF-8: 300 rows of 200 four-byte characters exceed 256 KiB although their
  // UTF-16 length would not; the same rows in ASCII fit.
  assert.equal(validateContract('boardPresentation', presentation(300, 'a'.repeat(200))).ok, true);
  const astral = validateContract('boardPresentation', presentation(300, '\u{1F600}'.repeat(200)));
  assert.equal(astral.ok, false);
  assert.equal(astral.error?.code ?? astral.errors?.[0]?.code ?? JSON.stringify(astral).match(/LimitExceeded/)?.[0], 'LimitExceeded');
  // Lone surrogates are still rejected.
  assert.equal(validateContract('boardPresentation', presentation(1, 'a\uD800b')).ok, false);
  // 500 rows (the Board cap) validate quickly enough for a per-render host path.
  const started = performance.now();
  for (let run = 0; run < 5; run++) assert.equal(validateContract('boardPresentation', presentation(500, 'Concurrent task title')).ok, true);
  assert.ok((performance.now() - started) / 5 < 250, 'a 500-row Board presentation validates in under 250 ms');
});
