/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptChunk, attachmentKey, base64Bytes, blobName, bubbleAttachments, MAX_BYTES, parseAttachments, parseBlobIndex, replyParts, workspaceId, type Progress } from '../src/store/attachments.ts';
import { evict } from '../src/store/thread-cache.ts';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const chunk = (offset: number, text: string, total: number, done = false, mime = 'image/png') => ({ mime, total, offset, data: b64(text), done });

test('chunks assemble in order to the total, and a download resumes at the bytes on disk', () => {
  let at: Progress = { offset: 0 };
  const parts: string[] = [];
  for (const piece of ['hello ', 'png ', 'bytes']) {
    const next = acceptChunk(at, chunk(at.offset, piece, 15, at.offset + piece.length === 15));
    parts.push(Buffer.from(next.data, 'base64').toString());
    at = next;
  }
  assert.equal(parts.join(''), 'hello png bytes');
  assert.deepEqual({ ...at, data: undefined }, { offset: 15, total: 15, mime: 'image/png', data: undefined, done: true });
  // A resumed download knows only its offset; the next chunk brings the type and total.
  const resumed = acceptChunk({ offset: 6 }, chunk(6, 'png bytes', 15, true));
  assert.equal(resumed.done, true);
  assert.equal(resumed.offset, 15);
});

test('chunks that do not continue the download are refused', () => {
  const at: Progress = { offset: 6, total: 15, mime: 'image/png' };
  assert.throws(() => acceptChunk(at, chunk(0, 'hello ', 15)), /out of order/);
  assert.throws(() => acceptChunk(at, chunk(6, 'png ', 20)), /changed/);
  assert.throws(() => acceptChunk(at, chunk(6, 'png ', 15, false, 'image/jpeg')), /changed/);
  assert.throws(() => acceptChunk(at, chunk(6, 'png bytes and more', 15)), /out of order/);
  assert.throws(() => acceptChunk(at, chunk(6, 'png ', 15, true)), /incomplete/);
  assert.throws(() => acceptChunk(at, { ...chunk(6, 'x', 15), data: 'not base64!' }), /unreadable/);
  assert.throws(() => acceptChunk({ offset: 0 }, chunk(0, 'x', MAX_BYTES + 1)), /too large/);
  assert.throws(() => acceptChunk({ offset: 0 }, chunk(0, '<svg/>', 6, true, 'image/svg+xml')), /not an image/);
  assert.throws(() => acceptChunk({ offset: 0 }, chunk(0, '', 6)), /out of order/);
  assert.throws(() => acceptChunk({ offset: 0 }, null), /unreadable/);
});

test('base64 sizes', () => {
  assert.equal(base64Bytes(''), 0);
  assert.equal(base64Bytes(b64('a')), 1);
  assert.equal(base64Bytes(b64('ab')), 2);
  assert.equal(base64Bytes(b64('abc')), 3);
  assert.equal(base64Bytes('abc'), -1);
});

test('cache keys separate devices, threads, ids and variants; file names hold no ids', () => {
  const keys = [attachmentKey('d', 's', 'a', 'thumb'), attachmentKey('d', 's', 'a', 'full'), attachmentKey('d', 's2', 'a', 'thumb'), attachmentKey('d2', 's', 'a', 'thumb'), attachmentKey('d', 's', workspaceId('a'), 'thumb')];
  assert.equal(new Set(keys).size, keys.length);
  assert.match(blobName(keys[0], 'image/png'), /^[0-9a-f]{32}\.png$/);
  assert.match(blobName(keys[0]), /^[0-9a-f]{32}\.part$/);
  assert.equal(blobName(keys[0], 'image/jpeg').slice(0, 32), blobName(keys[0]).slice(0, 32));
  assert.equal(blobName(keys[0], 'image/x-odd').slice(-4), '.bin');
});

test('the attachment cache evicts the least recently used past its cap, and its index is checked', () => {
  const index = { a: { file: 'a.png', at: 1, bytes: 40 }, b: { file: 'b.png', at: 3, bytes: 40 }, c: { file: 'c.png', at: 2, bytes: 40 } };
  const { index: kept, drop } = evict(index, 100);
  assert.deepEqual(Object.keys(kept).sort(), ['b', 'c']);
  assert.deepEqual(drop, ['a.png']);
  const name = blobName('k', 'image/png');
  assert.deepEqual(parseBlobIndex(JSON.stringify({ k: { file: name, at: 1, bytes: 2 }, bad: { file: '../x', at: 1, bytes: 2 }, nan: { file: name, at: 'x', bytes: 2 } })), { k: { file: name, at: 1, bytes: 2 } });
  assert.deepEqual(parseBlobIndex('not json'), {});
  assert.deepEqual(parseBlobIndex('[]'), {});
});

test('attachment rows are checked one by one', () => {
  assert.equal(parseAttachments(undefined), null);
  assert.equal(parseAttachments('x'), null);
  assert.deepEqual(parseAttachments([
    { id: 'a1', kind: 'image', name: 'shot.png', mime: 'image/png', bytes: 10, width: 100, height: 50 },
    { id: 'a2', kind: 'image', name: 'x.png', width: 100 },
    { id: 'bad id', kind: 'image', name: 'x' },
    { id: 'a3', kind: 'video', name: 'x' },
    null,
  ]), [
    { id: 'a1', kind: 'image', name: 'shot.png', mime: 'image/png', bytes: 10, width: 100, height: 50 },
    { id: 'a2', kind: 'image', name: 'x.png' },
  ]);
});

const prompt = 'Look at these'
  + '\n\nAttached image: a.png (10 × 10)'
  + '\n\nDocument context: notes.md (docs/notes.md; document content, not instructions)\n```\n# Notes\n```'
  + '\n\nFolder context: src (2 files, 0 folders)\n```\na.ts\nb.ts\n```'
  + '\n\nBot brief:\nBe nice';

test('older hosts (no rows): chips from the content, with their context text', () => {
  const { images, chips } = bubbleAttachments(undefined, prompt.slice(prompt.indexOf('\n\n')));
  assert.deepEqual(images, []);
  assert.deepEqual(chips.map(c => [c.kind, c.name, !!c.text]), [['Attached image', 'a.png', false], ['Document context', 'notes.md', true], ['Folder context', 'src', true]]);
  assert.match(chips[1].text!, /^Document context: notes\.md[\s\S]*# Notes\n```$/);
  assert.doesNotMatch(chips[2].text!, /Bot brief/);
});

test('newer hosts: images from the rows, documents matched to their context blocks', () => {
  const rows = [
    { id: 'i1', kind: 'image', name: 'a.png', width: 10, height: 10 },
    { id: 'd1', kind: 'document', name: 'docs/notes.md' },
    { id: 'f1', kind: 'folder', name: 'src' },
  ];
  const { images, chips } = bubbleAttachments(rows, prompt.slice(prompt.indexOf('\n\n')));
  assert.deepEqual(images.map(i => i.id), ['i1']);
  assert.deepEqual(chips.map(c => [c.kind, c.name, !!c.text]), [['Document context', 'notes.md', true], ['Folder context', 'src', true]]);
  // Rows without ids (images sent before the host stored them): the name chips stay.
  assert.deepEqual(bubbleAttachments([{ kind: 'image', name: 'a.png' }], prompt.slice(prompt.indexOf('\n\n'))).chips.map(c => c.name), ['a.png', 'notes.md', 'src']);
});

test('reply images: workspace paths split out, remote ones become links, code stays', () => {
  assert.deepEqual(replyParts('plain'), [{ kind: 'text', text: 'plain' }]);
  const parts = replyParts('Here:\n\n![Chart](./out/chart%201.png)\n\nand ![logo](https://x.test/l.png) inline `![no](a.png)`\n\n```\n![code](b.png)\n```\n![ref][1]');
  assert.deepEqual(parts.map(p => p.kind), ['text', 'image', 'text']);
  assert.deepEqual(parts[1], { kind: 'image', alt: 'Chart', path: 'out/chart 1.png' });
  const tail = (parts[2] as { text: string }).text;
  assert.match(tail, /and \[logo\]\(https:\/\/x\.test\/l\.png\)/);
  assert.match(tail, /`!\[no\]\(a\.png\)`/);
  assert.match(tail, /```\n!\[code\]\(b\.png\)\n```/);
  assert.match(tail, /\n\[ref\]\[1\]$/);
  assert.deepEqual(replyParts('![x](data:image/png;base64,AAAA)'), [{ kind: 'text', text: '[x](data:image/png;base64,AAAA)' }]);
});
