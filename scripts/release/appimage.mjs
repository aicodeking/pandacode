// Tauri's AppImage bundler copies the Ubuntu build host's Wayland libraries into
// usr/lib. Hosts with Mesa 25+ load their own libEGL_mesa against that older
// copy and fail on `wl_fixes_interface`, so WebKit's web process aborts with
// "Could not create default EGL display: EGL_BAD_PARAMETER" and the window never
// renders. Tauri has no way to exclude libraries (tauri-apps/tauri#15665), so the
// finished image is unpacked, those four libraries are dropped, and the image is
// rebuilt with the same runtime, compression and block size. Hosts then use their
// own Wayland/EGL stack, as they already do for libGL and their GPU drivers.
//
// The same pass makes linuxdeploy-plugin-gtk's hook keep a GDK_BACKEND the user set
// (it forces x11), so a host whose Xwayland can't present the window can run the
// AppImage on GTK's Wayland backend with GDK_BACKEND=wayland.
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const SQUASHFS_MAGIC = 0x73717368;
const HEADER_SIZE = 96;

// The build host's copies of these are older than current Mesa EGL stacks.
const WAYLAND_LIBRARY = /^libwayland-(?:client|cursor|egl|server)\.so(?:\.|$)/;

// squashfs superblock compression ids; mksquashfs accepts these names.
export const SQUASHFS_COMPRESSIONS = Object.freeze({ 1: 'gzip', 2: 'lzma', 3: 'lzo', 4: 'xz', 5: 'lz4', 6: 'zstd' });

// Every Tauri AppImage carries this hook; AppRun sources it before starting the app.
export const GTK_HOOK = 'apprun-hooks/linuxdeploy-plugin-gtk.sh';
// The plugin writes `export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland`.
const FORCED_BACKEND = /^([ \t]*)export GDK_BACKEND=x11(?=[ \t]*(?:#.*)?$)/gm;
const DEFAULT_BACKEND = 'export GDK_BACKEND="${GDK_BACKEND:-x11}"';

/** The GTK hook with X11 as a default instead of forced. Throws if the hook changed shape. */
export function respectGdkBackend(script) {
  const rewritten = script.replace(FORCED_BACKEND, (_, indent) => `${indent}${DEFAULT_BACKEND}`);
  if (rewritten !== script || script.includes(DEFAULT_BACKEND)) return rewritten;
  throw new Error(`${GTK_HOOK} no longer contains "export GDK_BACKEND=x11"; update respectGdkBackend in scripts/release/appimage.mjs.`);
}

async function rewriteGtkHook(root) {
  const hook = join(root, GTK_HOOK);
  let script;
  try {
    script = await readFile(hook, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`The AppImage has no ${GTK_HOOK}; GDK_BACKEND could not be made overridable.`);
    throw error;
  }
  const rewritten = respectGdkBackend(script);
  if (rewritten === script) return false;
  await writeFile(hook, rewritten);
  return true;
}

export function waylandLibraries(names) {
  return names.filter(name => WAYLAND_LIBRARY.test(name));
}

export function parseSquashfsHeader(header) {
  if (header.length < HEADER_SIZE) throw new Error('The AppImage squashfs header is truncated.');
  if (header.readUInt32LE(0) !== SQUASHFS_MAGIC) throw new Error('The AppImage does not contain a squashfs image.');
  const blockSize = header.readUInt32LE(12);
  const id = header.readUInt16LE(20);
  const compression = SQUASHFS_COMPRESSIONS[id];
  if (!compression) throw new Error(`Unsupported squashfs compression id ${id}.`);
  if (blockSize < 4096 || blockSize > 1024 * 1024 || (blockSize & (blockSize - 1)) !== 0) throw new Error(`Invalid squashfs block size ${blockSize}.`);
  return { blockSize, compression };
}

export function mksquashfsArguments(root, output, { blockSize, compression }) {
  if (!Object.values(SQUASHFS_COMPRESSIONS).includes(compression)) throw new Error(`Unsupported squashfs compression ${compression}.`);
  return [root, output, '-noappend', '-root-owned', '-quiet', '-no-progress', '-comp', compression, '-b', String(blockSize)];
}

/** The byte offset where the AppImage runtime ends and its squashfs begins. */
export async function appImageOffset(appImage, command = execute) {
  let stdout;
  try {
    ({ stdout } = await command(appImage, ['--appimage-offset'], { maxBuffer: 4096 }));
  } catch (error) {
    throw new Error(`Could not read the AppImage runtime offset: ${error.stderr?.trim() || error.message}`);
  }
  const offset = Number(stdout.trim());
  if (!Number.isSafeInteger(offset) || offset <= 0) throw new Error(`Invalid AppImage runtime offset "${stdout.trim()}".`);
  return offset;
}

async function readHeader(appImage, offset) {
  const handle = await open(appImage, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, offset);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Rebuild an AppImage without the Wayland libraries copied from the build host and
 * with an overridable GDK_BACKEND. Returns false when there was nothing to change.
 */
export async function repackAppImage(appImage, { command = execute, log = () => {} } = {}) {
  const offset = await appImageOffset(appImage, command);
  const header = parseSquashfsHeader(await readHeader(appImage, offset));
  const work = await mkdtemp(join(tmpdir(), 'pandacode-appimage-'));
  const rebuilt = `${appImage}.rebuild`;
  try {
    try {
      await command(appImage, ['--appimage-extract'], { cwd: work, maxBuffer: MAX_OUTPUT });
    } catch (error) {
      throw new Error(`Could not unpack ${appImage}: ${error.stderr?.trim() || error.message}`);
    }
    const root = join(work, 'squashfs-root');
    const removed = [];
    for (const directory of ['usr/lib', 'usr/lib64', 'usr/lib/x86_64-linux-gnu', 'usr/lib/aarch64-linux-gnu']) {
      let names;
      try {
        names = await readdir(join(root, directory));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const name of waylandLibraries(names)) {
        await rm(join(root, directory, name), { force: true });
        removed.push(`${directory}/${name}`);
      }
    }
    const hookRewritten = await rewriteGtkHook(root);
    if (!removed.length && !hookRewritten) {
      log('No bundled Wayland libraries and GDK_BACKEND already overridable; leaving the AppImage unchanged.');
      return false;
    }
    const squashfs = join(work, 'appimage.squashfs');
    try {
      await command('mksquashfs', mksquashfsArguments(root, squashfs, header), { maxBuffer: MAX_OUTPUT });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('mksquashfs is required to rebuild the Linux AppImage; install squashfs-tools.');
      throw new Error(`Could not rebuild the AppImage squashfs: ${error.stderr?.trim() || error.message}`);
    }
    // Keep the original runtime (and its update information) and append the new image.
    await pipeline(createReadStream(appImage, { start: 0, end: offset - 1 }), createWriteStream(rebuilt));
    await pipeline(createReadStream(squashfs), createWriteStream(rebuilt, { flags: 'a' }));
    await chmod(rebuilt, 0o755);
    if (await appImageOffset(rebuilt, command) !== offset) throw new Error('The rebuilt AppImage does not start at the same runtime offset.');
    await rename(rebuilt, appImage);
    if (removed.length) log(`Removed ${removed.join(', ')}; the AppImage now uses the host's Wayland libraries.`);
    if (hookRewritten) log(`${GTK_HOOK} now keeps a GDK_BACKEND set by the user (default x11).`);
    return true;
  } finally {
    await rm(rebuilt, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}
