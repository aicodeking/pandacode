import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { validateContract } from '../src/extensions/contracts.ts';

const source = readFileSync(new URL('../src/extensions/rich-view-channel.js', import.meta.url), 'utf8');
const accepts = runInNewContext(`${source}; richViewMessage`, { TextEncoder });
const ready = { schemaVersion: 1, kind: 'ready', session: 'session-a', sequence: 1 };
test('rich view channel rejects oversized, forged, stale and extra-field messages', () => {
  assert.equal(accepts(ready, 'session-a', 'ready', 1), true);
  for (const change of [{ schemaVersion: 2 }, { session: 'session-b' }, { kind: 'invoke' }, { sequence: 0 }, { sequence: 2 }, { command: 'read_file' }, { session: 'é'.repeat(32768) }]) assert.equal(accepts({ ...ready, ...change }, 'session-a', 'ready', 1), false);
  assert.equal(accepts(null, 'session-a', 'ready', 1), false);
});
test('rich view init accepts only the presentation DTO and finite theme schema', () => {
  const init = { ...ready, kind: 'init', dto: { schemaVersion: 1, owner: 'sample.rich-view', version: '1.0.0', viewId: 'sample.rich-view/report', windowId: 'extension-view-a', title: 'Report', text: 'Fallback' }, theme: { schemaVersion: 1, colorScheme: 'dark' } };
  assert.equal(accepts(init, 'session-a', 'init', 1), true);
  assert.equal(accepts({ ...init, dto: { ...init.dto, credentials: 'never' } }, 'session-a', 'init', 1), false);
  assert.equal(accepts({ ...init, theme: { schemaVersion: 1, colorScheme: 'url(remote)' } }, 'session-a', 'init', 1), false);
});
test('rich view host checks actual source and opaque origin, accepts once and disposes listeners', () => {
  for (const expire of [false, true]) {
  const listeners = new Map(), sent = [];
  const target = { postMessage: (...args) => sent.push(args) };
  let removed = false, signal, timeout;
  const frame = { contentWindow: target, setAttribute() {}, remove() { removed = true; } };
  const config = { session: 'session-a', document: '<p>isolated</p>', dto: { schemaVersion: 1, owner: 'sample.rich-view', version: '1.0.0', viewId: 'sample.rich-view/report', windowId: 'extension-view-a', title: 'Report', text: 'Fallback' }, theme: { schemaVersion: 1, colorScheme: 'dark' } };
  const document = { getElementById: () => ({ textContent: JSON.stringify(config) }), createElement: tag => tag === 'iframe' ? frame : { setAttribute() {} }, body: { replaceChildren() {} } };
  runInNewContext(`${source}\n${readFileSync(new URL('../src/extensions/rich-view-host.js', import.meta.url), 'utf8')}`, { TextEncoder, AbortController, document, addEventListener: (name, callback, options) => { listeners.set(name, callback); if (name === 'message') signal = options.signal; }, setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} });
  const message = listeners.get('message');
  for (const change of [{ source: {} }, { origin: 'https://forged.invalid' }, { data: { ...ready, session: 'session-b' } }, { data: { ...ready, schemaVersion: 2 } }, { data: { ...ready, extra: 'x'.repeat(32768) } }]) message({ source: target, origin: 'null', data: ready, ...change });
  assert.equal(sent.length, 0);
  if (expire) timeout();
  message({ source: target, origin: 'null', data: ready }); assert.equal(sent.length, expire ? 0 : 1);
  message({ source: target, origin: 'null', data: ready }); assert.equal(sent.length, expire ? 0 : 1);
  listeners.get('pagehide')(); assert.equal(signal.aborted, true); assert.equal(removed, true);
  message({ source: target, origin: 'null', data: ready }); assert.equal(sent.length, expire ? 0 : 1);
  }
});
test('rich views declare local assets and a separate required API grant', () => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/rich-view/extension.json', import.meta.url), 'utf8'));
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const missing = structuredClone(manifest); missing.permissions = ['ui.contribute'];
  assert.equal(validateContract('packages', [missing]).error.code, 'PermissionDenied');
  // Q048 (R0302): retained for `rich.html`, an archive path of the legacy inline form (a remote or query address is
  // not a file of the archive: predictability). The permissioned remote page is `rich.url` with its origin declared
  // in `rich.remote` (positive test below).
  for (const path of ['../view.html', 'assets/../view.html', 'https://remote/view.html', 'assets/view.html?x=1']) {
    const bad = structuredClone(manifest); bad.contributes.views[0].rich.html = path;
    assert.equal(validateContract('packages', [bad]).ok, false);
  }
});
test('rich views declare a panel folder or a remote page with declared origins (R0302)', () => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-assets/alpha/extension.json', import.meta.url), 'utf8'));
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const twin = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-assets/twin/extension.json', import.meta.url), 'utf8'));
  assert.equal(validateContract('packages', [manifest, twin]).ok, true);
  const view = rich => { const changed = structuredClone(manifest); changed.contributes.views[0].rich = rich; return validateContract('packages', [changed]); };
  assert.equal(view({ url: 'https://charts.example.test/a?b=1', remote: ['https://charts.example.test'], minSize: { width: 320, height: 200 }, placement: 'window' }).ok, true);
  for (const rich of [
    { html: 'assets/a.html', css: 'assets/a.css', script: 'assets/a.js', folder: 'panel' },
    { folder: 'panel', entry: 'index.html', url: 'https://charts.example.test/' },
    { folder: 'Panel', entry: 'index.html' },
    { folder: 'panel', entry: '../index.html' },
    { folder: 'panel', entry: '/index.html' },
    { folder: 'panel' },
    { url: 'http://charts.example.test/', remote: ['https://charts.example.test'] },
    { url: 'https://charts.example.test/' },
    { folder: 'panel', entry: 'index.html', remote: ['https://charts.example.test/path'] },
    { folder: 'panel', entry: 'index.html', remote: [] },
  ]) assert.equal(view(rich).ok, false, JSON.stringify(rich));
  // A remote page's origin must be listed in rich.remote (a semantic rule, both validators).
  assert.equal(view({ url: 'https://other.example.test/x', remote: ['https://charts.example.test'] }).error.code, 'InvalidShape');
  const missing = structuredClone(manifest); missing.permissions = ['ui.contribute'];
  assert.equal(validateContract('packages', [missing]).error.code, 'PermissionDenied');
});
