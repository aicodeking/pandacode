import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUnzippedSize } from '../src/zip-limit.ts';

/** A stored (uncompressed) zip whose central directory claims each entry's unpacked size. */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data, claimed = data.length } of entries) {
    const file = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(claimed, 22); local.writeUInt16LE(file.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(claimed, 24); record.writeUInt16LE(file.length, 28); record.writeUInt32LE(offset, 42);
    parts.push(local, file, data); central.push(record, file);
    offset += 30 + file.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...parts, directory, end]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

test('ordinary Word and spreadsheet archives pass the unpacked-size check', () => {
  assert.doesNotThrow(() => checkUnzippedSize(zip([{ name: 'word/document.xml', data: Buffer.from('<w:document/>') }])));
});

test('an archive claiming more than 512 MB once unpacked is refused before parsing', () => {
  const bomb = zip([{ name: 'a.xml', data: Buffer.from('x'), claimed: 400 * 1024 * 1024 }, { name: 'b.xml', data: Buffer.from('x'), claimed: 400 * 1024 * 1024 }]);
  assert.throws(() => checkUnzippedSize(bomb), /512 MB/);
});

test('ZIP64 sizes and damaged directories are refused; non-zip files pass to their own parser', () => {
  assert.throws(() => checkUnzippedSize(zip([{ name: 'a.xml', data: Buffer.from('x'), claimed: 0xffffffff }])), /512 MB/);
  const damaged = new Uint8Array(zip([{ name: 'a.xml', data: Buffer.from('x') }]));
  damaged[damaged.length - 22 - 46 - 5] = 0; // first byte of the central directory signature
  assert.throws(() => checkUnzippedSize(damaged.buffer), /damaged/);
  assert.doesNotThrow(() => checkUnzippedSize(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer));
});
