import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/attachments.ts', import.meta.url), 'utf8');
const helper = source.match(/export async function uploadWebClipboardImage[\s\S]*?\n}\n/)[0];
const js = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { uploadWebClipboardImage } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const item = (type, blob = new Blob(['png'], { type })) => ({ types: [type], getType: async () => blob });
const clipboard = (...items) => async () => items;

test('web clipboard uploads the bounded blob and returns its opaque grant', async () => {
  let uploaded;
  const result = await uploadWebClipboardImage(clipboard(item('image/png')), async file => { uploaded = file; return { grant: 'upload_opaque', name: 'Pasted image.png' }; });
  assert.equal(result.path, 'upload_opaque'); assert.equal(uploaded.type, 'image/png'); assert.equal((await uploaded.arrayBuffer()).byteLength, 3);
});
test('web clipboard preserves image filename extensions', async () => {
  for (const [type, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
    let uploaded;
    await uploadWebClipboardImage(clipboard(item(type)), async file => { uploaded = file; return { grant: 'opaque', name: file.name }; });
    assert.equal(uploaded.name, `Pasted image.${extension}`);
    assert.equal(uploaded.type, type);
  }
});
test('web clipboard rejects unsupported images before upload', async () => {
  let uploads = 0;
  await assert.rejects(() => uploadWebClipboardImage(clipboard(item('image/gif')), async () => { uploads++; return { grant: 'bad', name: 'bad' }; }), /No supported image/);
  assert.equal(uploads, 0);
});
test('web clipboard propagates browser permission denial without attempting upload', async () => {
  let uploads = 0;
  await assert.rejects(() => uploadWebClipboardImage(async () => { throw new DOMException('denied', 'NotAllowedError'); }, async () => { uploads++; return { grant: 'bad', name: 'bad' }; }), /denied/);
  assert.equal(uploads, 0);
});
test('web clipboard rejects oversized images before upload', async () => {
  let uploads = 0; const blob = new Blob([new Uint8Array(12 * 1024 * 1024 + 1)], { type: 'image/png' });
  await assert.rejects(() => uploadWebClipboardImage(clipboard(item('image/png', blob)), async () => { uploads++; return { grant: 'bad', name: 'bad' }; }), /exceeds the 12 MiB limit/);
  assert.equal(uploads, 0);
});

test('handlePaste binds the imported image to the task active when paste began', async () => {
  const attachmentsSource = source
    .replace(/^import[^\n]*\n/gm, '')
    .replace('export type ', 'type ')
    .replace('export ', '')
    .replace('const alreadyAttached', 'const web = true; const preview = false; const webFiles = globalThis.__webFiles; const call = globalThis.__call; const chooseAttachmentFolder = async () => null; const chooseAttachments = async () => []; const escape = String; const icon = () => ""; const isMac = false;\nconst alreadyAttached');
  const bundled = await (await import('esbuild')).transform(attachmentsSource, { loader: 'ts', format: 'esm', target: 'es2022' });
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { read: async () => [item('image/png')] } });
  globalThis.__webFiles = { upload: async () => ({ grant: 'opaque-image', name: 'sample.png' }) };
  const calls = []; globalThis.__call = async (command, args) => { calls.push([command, args]); return { id: 'image-1', name: 'cache-token.png', width: 1, height: 1, thumbnail: 'data:image/png;base64,eA==' }; };
  const { mountPromptAttachments } = await import(`data:text/javascript,${encodeURIComponent(bundled.code)}`);
  let task = 'task-a'; const reports = []; const host = { taskId: () => task, blocked: () => null, otherImages: () => 0, notify: () => {}, report: error => reports.push(String(error)), insertText: () => false, rerender: () => {}, menu: async () => {}, projectFiles: () => {}, sketch: () => {} };
  const mounted = mountPromptAttachments(host);
  const event = { clipboardData: { files: [], types: [] }, preventDefault() { this.prevented = true; } };
  assert.equal(mounted.handlePaste(event), false); task = 'task-b'; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(event.prevented, true); assert.equal(calls[0][0], 'import_prompt_image'); assert.equal(calls[0][1].path, 'opaque-image'); assert.equal(mounted.list('task-a')[0].id, 'image-1'); assert.equal(mounted.list('task-a')[0].name, 'sample.png'); assert.equal(mounted.list('task-b').length, 0); assert.equal(calls.some(([command]) => command === 'read_clipboard_image'), false); assert.deepEqual(reports, []);
});
