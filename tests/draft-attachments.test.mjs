import test from 'node:test';
import assert from 'node:assert/strict';

// Draft attachments are copied into a plain JSON shape on the way into storage and validated,
// field by field, on the way back out: local storage is user-writable.
const { MAX_STORED_ATTACHMENTS, MAX_STORED_ATTACHMENT_BYTES, toStored, fromStored, attachmentsBytes } = await import('../src/draft-attachments.ts');

const image = (id, extra = {}) => ({ kind: 'image', id, name: `${id}.png`, width: 2, height: 3, thumbnail: `data:image/png;base64,${id}`, source: 'file', ...extra });
const documentAttachment = (id, extra = {}) => ({ kind: 'document', id, path: `/tmp/${id}.txt`, name: `${id}.txt`, size: 12, text: 'file text', truncated: false, method: 'text', ...extra });
const folderAttachment = (id, extra = {}) => ({ kind: 'folder', id, path: `/tmp/${id}`, name: id, files: 2, folders: 1, listing: 'a.txt\nb/', truncated: false, ...extra });

test('the composer’s caps are 12 attachments and 200 KB each', () => {
  assert.equal(MAX_STORED_ATTACHMENTS, 12);
  assert.equal(MAX_STORED_ATTACHMENT_BYTES, 200_000);
});

test('toStored copies only the known fields, dropping unknown ones such as missing', () => {
  const dirty = { ...image('i1'), missing: true, note: 'x' };
  const [clean] = toStored([dirty]);
  assert.deepEqual(clean, image('i1'));
  assert.notEqual(clean, dirty, 'a fresh plain object');
  const [cleanDocument] = toStored([{ ...documentAttachment('d1'), note: 'x' }]);
  assert.deepEqual(cleanDocument, documentAttachment('d1'));
  assert.deepEqual(toStored([{ ...folderAttachment('f1'), note: 'x' }]), [folderAttachment('f1')]);
});

test('toStored caps the count, keeping the first MAX_STORED_ATTACHMENTS that survive', () => {
  const many = Array.from({ length: MAX_STORED_ATTACHMENTS + 5 }, (_, index) => image(`i${index}`));
  assert.deepEqual(toStored(many).map(item => item.id), many.slice(0, MAX_STORED_ATTACHMENTS).map(item => item.id));
  assert.equal(toStored([{ kind: 'video' }, ...many]).length, MAX_STORED_ATTACHMENTS, 'invalid entries do not use up the count');
});

test('toStored skips an attachment over the per-item byte cap and keeps the ones that fit', () => {
  const prefix = 'data:image/png;base64,';
  const shape = image('fits', { thumbnail: prefix });
  const fits = image('fits', { thumbnail: prefix + 'x'.repeat(MAX_STORED_ATTACHMENT_BYTES / 2 - JSON.stringify(shape).length) });
  assert.equal(JSON.stringify(fits).length * 2, MAX_STORED_ATTACHMENT_BYTES, 'exactly at the cap is kept');
  const overShape = image('too-big', { thumbnail: prefix });
  const tooBig = image('too-big', { thumbnail: prefix + 'x'.repeat(MAX_STORED_ATTACHMENT_BYTES / 2 - JSON.stringify(overShape).length + 1) });
  assert.ok(JSON.stringify(tooBig).length * 2 > MAX_STORED_ATTACHMENT_BYTES);
  assert.deepEqual(toStored([tooBig, fits]), [fits]);
  assert.equal(toStored([tooBig]), undefined);
});

test('toStored returns undefined when nothing survives', () => {
  assert.equal(toStored([]), undefined);
  assert.equal(toStored([{ kind: 'video' }]), undefined);
  assert.equal(toStored([{ ...image('a'), width: -1 }]), undefined);
  assert.deepEqual(toStored([{ kind: 'video' }, image('i1')]), [image('i1')]);
});

test('fromStored accepts only an array', () => {
  for (const value of [null, undefined, 'text', 42, true, {}, { length: 1 }, new Map()]) assert.deepEqual(fromStored(value), []);
});

test('fromStored drops malformed kinds, fields, numbers and strings', () => {
  const broken = [
    null, 1, 'x', [], {},
    { kind: 'video', id: 'v' },
    { ...image('a'), id: '' },
    { ...image('a'), name: '' },
    { ...image('a'), thumbnail: '' },
    { ...image('a'), width: -1 },
    { ...image('a'), height: Infinity },
    { ...image('a'), width: '2' },
    { ...image('a'), source: 'clipboard' },
    { ...image('a'), path: 4 },
    { ...image('a'), sketchId: {} },
    { ...image('a'), missing: 'yes' },
    { ...documentAttachment('d'), id: 5 },
    { ...documentAttachment('d'), path: null },
    { ...documentAttachment('d'), name: '' },
    { ...documentAttachment('d'), method: null },
    { ...documentAttachment('d'), size: NaN },
    { ...documentAttachment('d'), size: -1 },
    { ...documentAttachment('d'), text: 5 },
    { ...documentAttachment('d'), truncated: 'no' },
    { ...documentAttachment('d'), missing: 'yes' },
    { ...folderAttachment('f'), id: '' },
    { ...folderAttachment('f'), path: '' },
    { ...folderAttachment('f'), name: '' },
    { ...folderAttachment('f'), files: -1 },
    { ...folderAttachment('f'), folders: Infinity },
    { ...folderAttachment('f'), listing: null },
    { ...folderAttachment('f'), truncated: 1 },
    { ...folderAttachment('f'), missing: 'yes' },
  ];
  for (const value of broken) assert.deepEqual(fromStored([value]), [], JSON.stringify(value));
  assert.deepEqual(fromStored([{ ...documentAttachment('d'), path: '' }]), [{ ...documentAttachment('d'), path: '' }], 'a browser document may have an empty path');
});

test('fromStored keeps well-formed images, documents and folders in order, as fresh copies', () => {
  const items = [
    image('i1'),
    documentAttachment('d1', { path: '' }),
    folderAttachment('f1'),
    image('i2', { source: 'sketch', path: '/tmp/s.png', sketchId: 's1' }),
  ];
  const restored = fromStored(items);
  assert.deepEqual(restored, items);
  assert.deepEqual(restored.map(item => item.kind), ['image', 'document', 'folder', 'image']);
  for (const [index, item] of restored.entries()) assert.notEqual(item, items[index], 'a fresh plain object');
  // Unknown fields are validated where they matter and never kept.
  assert.deepEqual(fromStored([{ ...image('i1'), note: 'x', missing: true }]), [image('i1')]);
  assert.deepEqual(fromStored([{ ...documentAttachment('d1'), note: 'x' }]), [documentAttachment('d1')]);
  assert.deepEqual(fromStored([{ ...folderAttachment('f1'), note: 'x' }]), [folderAttachment('f1')]);
});

test('fromStored caps the count and the per-item bytes too', () => {
  const many = Array.from({ length: MAX_STORED_ATTACHMENTS + 4 }, (_, index) => folderAttachment(`f${index}`));
  assert.deepEqual(fromStored(many).map(item => item.id), many.slice(0, MAX_STORED_ATTACHMENTS).map(item => item.id));
  const huge = documentAttachment('huge', { text: 'x'.repeat(MAX_STORED_ATTACHMENT_BYTES / 2) });
  assert.deepEqual(fromStored([huge, image('small')]), [image('small')]);
});

test('attachmentsBytes counts the UTF-16 bytes of the list, and nothing for an empty one', () => {
  assert.equal(attachmentsBytes(undefined), 0);
  assert.equal(attachmentsBytes([]), 0);
  const items = [image('i1'), documentAttachment('d1')];
  assert.equal(attachmentsBytes(items), JSON.stringify(items).length * 2);
  assert.ok(attachmentsBytes(items) > 0);
});

test('fromStored and toStored drop image thumbnails that are not data:image/ URLs', () => {
  const unsafe = [
    'https://example.com/a.png',
    'http://example.com/a.png',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/plain;base64,QQ==',
    'file:///etc/passwd',
    'thumb:i1',
  ];
  for (const thumbnail of unsafe) {
    assert.deepEqual(fromStored([image('bad', { thumbnail })]), [], thumbnail);
    assert.equal(toStored([image('bad', { thumbnail })]), undefined, thumbnail);
  }
  const ok = image('ok', { thumbnail: 'data:image/jpeg;base64,/9j/4AAQ' });
  assert.deepEqual(fromStored([ok]), [ok]);
  assert.deepEqual(toStored([ok]), [ok]);
});

test('hostile values never throw and never leak unknown or prototype keys', () => {
  const nested = JSON.parse('{"kind":"folder","id":"f","path":"/p","name":"f","files":1,"folders":0,"listing":"","truncated":false,"__proto__":{"polluted":true}}');
  const hostile = [null, undefined, 'text', 42, true, [], {}, [null, 1, 'x', [], { kind: 'image' }], nested];
  assert.doesNotThrow(() => { for (const value of hostile) fromStored(value); });
  assert.deepEqual(fromStored(hostile[7]), []);
  assert.deepEqual(fromStored([nested]), [folderAttachment('f', { path: '/p', files: 1, folders: 0, listing: '' })]);
  assert.equal({}.polluted, undefined);
  const throwing = { get kind() { throw new Error('boom'); } };
  assert.doesNotThrow(() => fromStored([throwing]));
  assert.deepEqual(fromStored([throwing]), []);
  assert.doesNotThrow(() => toStored(hostile));
  assert.doesNotThrow(() => toStored([throwing]));
  assert.equal(toStored([hostile[7]]), undefined);
  assert.deepEqual(toStored([hostile[7], image('i1')]), [image('i1')]);
});
