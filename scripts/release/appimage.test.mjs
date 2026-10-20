import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mksquashfsArguments, parseSquashfsHeader, repackAppImage, waylandLibraries } from './appimage.mjs';

const OFFSET = 100;

function header({ blockSize = 131072, compression = 6, magic = 0x73717368 } = {}) {
  const buffer = Buffer.alloc(96);
  buffer.writeUInt32LE(magic, 0);
  buffer.writeUInt32LE(blockSize, 12);
  buffer.writeUInt16LE(compression, 20);
  return buffer;
}

async function fakeAppImage(directory, { wayland = true } = {}) {
  const path = join(directory, 'PandaCode_1.2.3_amd64.AppImage');
  const bytes = Buffer.alloc(200, 1);
  header().copy(bytes, OFFSET);
  await writeFile(path, bytes);
  const calls = [];
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args, options });
    if (args[0] === '--appimage-offset') return { stdout: `${OFFSET}\n`, stderr: '' };
    if (args[0] === '--appimage-extract') {
      const lib = join(options.cwd, 'squashfs-root/usr/lib');
      await mkdir(lib, { recursive: true });
      await writeFile(join(lib, 'libgtk-3.so.0'), 'gtk');
      if (wayland) for (const name of ['libwayland-client.so.0', 'libwayland-server.so.0']) await writeFile(join(lib, name), 'wayland');
      return { stdout: '', stderr: '' };
    }
    if (executable === 'mksquashfs') {
      await writeFile(args[1], Buffer.alloc(16, 7));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };
  return { path, calls, command };
}

test('removes only the Wayland libraries copied from the build host', () => {
  assert.deepEqual(
    waylandLibraries(['libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libwayland-server.so.0.20.0', 'libwayland-client.so', 'libgtk-3.so.0', 'libwayland-extra.so.0', 'libwayland-client-extra.so.0']),
    ['libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libwayland-server.so.0.20.0', 'libwayland-client.so'],
  );
});

test('reads the compression and block size from the squashfs superblock', () => {
  assert.deepEqual(parseSquashfsHeader(header()), { blockSize: 131072, compression: 'zstd' });
  assert.deepEqual(parseSquashfsHeader(header({ blockSize: 4096, compression: 1 })), { blockSize: 4096, compression: 'gzip' });
  assert.throws(() => parseSquashfsHeader(header({ magic: 0 })), /squashfs/);
  assert.throws(() => parseSquashfsHeader(header({ compression: 9 })), /compression id 9/);
  assert.throws(() => parseSquashfsHeader(header({ blockSize: 1000 })), /block size/);
  assert.throws(() => parseSquashfsHeader(Buffer.alloc(8)), /truncated/);
});

test('mksquashfs keeps the original image settings', () => {
  assert.deepEqual(mksquashfsArguments('/tmp/root', '/tmp/image.squashfs', { blockSize: 131072, compression: 'zstd' }), [
    '/tmp/root', '/tmp/image.squashfs', '-noappend', '-root-owned', '-quiet', '-no-progress', '-comp', 'zstd', '-b', '131072',
  ]);
  assert.throws(() => mksquashfsArguments('/tmp/root', '/tmp/image', { blockSize: 131072, compression: 'brotli' }), /Unsupported/);
});

test('rebuilds the AppImage with the same runtime and without Wayland libraries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-appimage-test-'));
  try {
    const { path, calls, command } = await fakeAppImage(directory);
    assert.equal(await repackAppImage(path, { command }), true);
    const rebuilt = await readFile(path);
    assert.equal(rebuilt.length, OFFSET + 16);
    assert.deepEqual(rebuilt.subarray(0, OFFSET), Buffer.alloc(OFFSET, 1), 'the runtime is unchanged');
    const squash = calls.find(call => call.executable === 'mksquashfs');
    assert.ok(squash.args.includes('-comp') && squash.args.includes('zstd'));
    assert.ok(squash.args.includes('-b') && squash.args.includes('131072'));
    // Windows has no executable bits; the release script only rebuilds Linux images.
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o111, 0o111, 'the rebuilt AppImage stays executable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('leaves an AppImage alone when it has no bundled Wayland libraries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-appimage-test-'));
  try {
    const { path, calls, command } = await fakeAppImage(directory, { wayland: false });
    const before = await readFile(path);
    assert.equal(await repackAppImage(path, { command }), false);
    assert.equal(calls.some(call => call.executable === 'mksquashfs'), false);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports a missing squashfs-tools installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-appimage-test-'));
  try {
    const { path, command } = await fakeAppImage(directory);
    const missing = async (executable, args, options) => {
      if (executable === 'mksquashfs') throw Object.assign(new Error('spawn mksquashfs ENOENT'), { code: 'ENOENT' });
      return command(executable, args, options);
    };
    await assert.rejects(() => repackAppImage(path, { command: missing }), /squashfs-tools/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
