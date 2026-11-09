import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/web-http.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
globalThis.window = { setTimeout, clearTimeout };
globalThis.location = new URL('https://panda.example/workspace');
const { webJson } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('JSON transport rejects foreign origins before sending credentials', async () => {
  globalThis.fetch = async () => { throw Error('must not send'); };
  await assert.rejects(() => webJson('https://other.example/'), /current origin/);
});
test('pairing accepts a successful empty 204 without parsing a JSON body', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const result = await webJson('/api/pandacode/session');
  assert.equal(result.response.status, 204); assert.equal(result.value, null);
});
test('bounds streamed JSON even when Content-Length understates the response', async () => {
  let cancelled = false;
  globalThis.fetch = async () => ({ ok: true, headers: new Map([['content-length','1']]), body: { getReader: () => ({ read: async () => ({done:false,value:new Uint8Array(9)}), cancel: async () => {cancelled=true;} }) } });
  await assert.rejects(() => webJson('/api/pandacode/preferences', {}, { maxBytes: 8 }), /exceeds limit/);
  assert.equal(cancelled,true);
});
test('deadline covers a stalled response body and caller cancellation', async () => {
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
    if (init.signal.aborted) controller.error(Error('aborted'));
    else init.signal.addEventListener('abort', () => controller.error(Error('aborted')));
  } }));
  await assert.rejects(() => webJson('/api/pandacode/preferences', {}, { timeoutMs: 10 }), /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => webJson('/api/pandacode/preferences', {signal:controller.signal}), /cancelled/);
});
