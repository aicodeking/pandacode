import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/web-files.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
globalThis.window = { setTimeout, clearTimeout };
globalThis.location = new URL('https://panda.example/?web');
globalThis.document = { cookie: 'pandacode_csrf=fixture', documentElement: { dataset: {} } };
const { WebFiles } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test('multipart picker stops after the first failed upload and cleans up the native input', async () => {
  const previousDocument = document;
  const inputs = [];
  globalThis.document = {
    cookie: '', documentElement: { dataset: {} },
    body: { append(input) { inputs.push(input); } },
    createElement() {
      const listeners = {};
      return {
        files: [],
        addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
        dispatch(name) { for (const fn of listeners[name] ?? []) fn({}); },
        click() {},
        remove() { this.removed = true; },
      };
    },
  };
  try {
    const files = new WebFiles();
    const uploaded = [];
    files.upload = async file => {
      uploaded.push(file.name);
      if (file.name === 'second.txt') throw new Error('connection interrupted');
      return { grant: `grant-${file.name}`, name: file.name };
    };
    const pending = files.pickFiles('', true, 'attachment');
    const input = inputs[0];
    input.files = [new File(['one'], 'first.txt'), new File(['two'], 'second.txt'), new File(['three'], 'third.txt')];
    input.dispatch('change');
    await assert.rejects(pending, /connection interrupted/);
    assert.deepEqual(uploaded, ['first.txt', 'second.txt']);
    assert.equal(input.removed, true);
  } finally { globalThis.document = previousDocument; }
});

test('an upload that stalls after headers is aborted by the file request deadline', async () => {
  const files = new WebFiles();
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); });
  }}));
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = (fn, delay) => originalSetTimeout(fn, Math.min(delay, 10));
  try { await assert.rejects(() => files.upload(new File(['fixture'], 'slow.txt'), 'attachment'), /timed out/); }
  finally { window.setTimeout = originalSetTimeout; }
  assert.equal(aborted, true);
});
