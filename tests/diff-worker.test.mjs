import test from 'node:test';
import assert from 'node:assert/strict';
import { build, createServer } from 'vite';

test('production diff worker retains its message handlers despite package side-effect metadata', { timeout: 30000 }, async () => {
  // Exercise the real worker build, but never depend on a stale/untracked dist
  // directory or make npm test overwrite a developer's production artifacts.
  const result = await build({ logLevel: 'silent', build: { write: false, rollupOptions: { input: 'src/diff-viewer.ts' } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const workers = output.filter(entry => /^assets\/diff-highlight-worker-.*\.js$/.test(entry.fileName));
  assert.equal(workers.length, 1, 'the production build contains one real worker entry');
  const source = String(workers[0].type === 'asset' ? workers[0].source : workers[0].code);
  assert.match(source, /addEventListener\("message"/);
  assert.match(source, /case"initialize"/);
});

test('development diff workers enter the dependency optimizer instead of serving a raw dependency graph', { timeout: 30000 }, async () => {
  const server = await createServer({
    cacheDir: 'node_modules/.cache/pandacode-diff-worker-test',
    optimizeDeps: { noDiscovery: true, include: ['@pierre/diffs/worker/worker.js'] },
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  try {
    await server.listen();
    const viewer = await server.transformRequest('/src/diff-viewer.ts');
    assert.match(viewer.code, /\/src\/diff-highlight-worker(?:\.ts)?\?worker/);
    const worker = await server.transformRequest('/src/diff-highlight-worker.ts');
    assert.match(worker.code, /\/node_modules\/\.cache\/pandacode-diff-worker-test\/deps\/@pierre_diffs_worker_worker__js\.js/);
    assert.doesNotMatch(worker.code, /\/node_modules\/@pierre\/diffs\/dist\//);
  } finally { await server.close(); }
});
