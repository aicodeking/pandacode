import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, root, run } from './common.mjs';

export const runtimeDirectoryName = 'panda-router-runtime';
export const runtimeVersion = '1.31.0';
export const bundleSource = `target/panda-router-bundle/${runtimeVersion}`;
const packageName = `microsoft.ml.onnxruntime.${runtimeVersion}.nupkg`;
export const packagePin = Object.freeze({
  url: `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${runtimeVersion}/${packageName}`,
  size: 159626085,
  sha256: '7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b',
});

// El paquete oficial solo se usa para los binarios CPU win-x64 y sus avisos.
const native = 'runtimes/win-x64/native';
export const runtimePins = Object.freeze({
  'onnxruntime.dll': Object.freeze({
    entry: `${native}/onnxruntime.dll`, size: 17253176,
    sha256: '0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c',
  }),
  'onnxruntime_providers_shared.dll': Object.freeze({
    entry: `${native}/onnxruntime_providers_shared.dll`, size: 21816,
    sha256: 'e45d471ea2a842b268c51291b96d53568b0dae10807f43d1fb7dc0eb84e83723',
  }),
  LICENSE: Object.freeze({
    entry: 'LICENSE', size: 1094,
    sha256: 'c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674',
  }),
  'ThirdPartyNotices.txt': Object.freeze({
    entry: 'ThirdPartyNotices.txt', size: 344457,
    sha256: 'c53a76501ef60db6f865f20599f220761201ac4057683acefdab37d861b86622',
  }),
});

export function windowsRouterBundleResources(target) {
  if (target !== 'windows-x86_64') return {};
  return { resources: Object.fromEntries(Object.keys(runtimePins).map(name => [
    `${bundleSource}/${name}`, `${runtimeDirectoryName}/${name}`,
  ])) };
}

export function assertAmd64Dll(bytes, name) {
  const pe = bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d ? bytes.readUInt32LE(0x3c) : 0;
  if (pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550 ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 || !(bytes.readUInt16LE(pe + 22) & 0x2000) ||
      bytes.readUInt16LE(pe + 24) !== 0x20b) {
    throw new Error(`${name} no es una DLL PE32+ AMD64.`);
  }
}

async function assertFileSize(path, size) {
  const file = await lstat(path);
  if (!file.isFile() || file.size !== size) throw new Error(`Tamaño o tipo incorrecto: ${path}`);
}

export async function verifyNugetPackage(path) {
  await assertFileSize(path, packagePin.size);
  if (await digest(path) !== packagePin.sha256) throw new Error(`SHA-256 incorrecto: ${path}`);
}

export async function verifyWindowsRouterRuntime(directory, { exact = false } = {}) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`No es un directorio de ONNX Runtime: ${directory}`);
  if (exact && (await readdir(directory)).some(name => !Object.hasOwn(runtimePins, name))) {
    throw new Error(`El instalador contiene archivos de ONNX Runtime inesperados: ${directory}`);
  }
  for (const [name, pin] of Object.entries(runtimePins)) {
    const path = join(directory, name);
    await assertFileSize(path, pin.size);
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`SHA-256 incorrecto: ${path}`);
    if (name.endsWith('.dll')) assertAmd64Dll(bytes, name);
  }
}

async function fetchRuntime(scratch) {
  const archive = join(scratch, packageName);
  const system = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32');
  await run(join(system, 'curl.exe'), [
    '-q', '--fail', '--silent', '--show-error', '--proto', '=https', '--retry', '2',
    '--retry-max-time', '180', '--connect-timeout', '15', '--max-time', '120',
    '--max-filesize', String(packagePin.size), '--output', archive, packagePin.url,
  ]);
  await verifyNugetPackage(archive);
  const unpacked = join(scratch, 'unpacked');
  await mkdir(unpacked);
  await run(join(system, 'tar.exe'), [
    '-xf', archive, '-C', unpacked, '--', ...Object.values(runtimePins).map(({ entry }) => entry),
  ]);
  return unpacked;
}

export async function stageWindowsRouterRuntime(directory) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('ONNX Runtime requiere un host Windows x64.');
  try {
    await verifyWindowsRouterRuntime(directory);
    return;
  } catch {
    // Solo se reutiliza el staging si vuelve a pasar todas las comprobaciones.
  }
  const scratch = await mkdtemp(join(tmpdir(), 'pandacode-onnx-'));
  try {
    const unpacked = await fetchRuntime(scratch);
    const verified = join(scratch, 'verified');
    await mkdir(verified);
    for (const [name, { entry }] of Object.entries(runtimePins)) {
      await copyFile(join(unpacked, entry), join(verified, name));
    }
    await verifyWindowsRouterRuntime(verified, { exact: true });

    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory()) throw new Error(`No es un directorio de ONNX Runtime: ${directory}`);
    const pending = await mkdtemp(join(directory, '.staging-'));
    try {
      for (const name of Object.keys(runtimePins)) await copyFile(join(verified, name), join(pending, name));
      // La DLL principal queda disponible al final.
      for (const name of Object.keys(runtimePins).reverse()) await rename(join(pending, name), join(directory, name));
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await verifyWindowsRouterRuntime(directory);
}

async function main(args) {
  if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Uso: node scripts/release/windows-router-runtime.mjs [directorio-del-exe]');
  const exeDirectory = args[0] ?? resolve(root, 'src-tauri/target/debug');
  const directory = resolve(exeDirectory, runtimeDirectoryName);
  await stageWindowsRouterRuntime(directory);
  console.log(`ONNX Runtime CPU ${runtimeVersion} verificado en ${directory}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
