import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPlan } from './build.mjs';
import { targets } from './common.mjs';
import { assertAmd64Dll, packagePin, runtimePins, verifyNugetPackage, verifyWindowsRouterRuntime } from './windows-router-runtime.mjs';

test('pins the official CPU NuGet archive and only the win-x64 runtime and notices', () => {
  assert.deepEqual(packagePin, {
    url: 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.0/microsoft.ml.onnxruntime.1.31.0.nupkg',
    size: 159626085,
    sha256: '7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b',
  });
  assert.deepEqual(Object.values(runtimePins).map(({ entry, sha256 }) => [entry, sha256]), [
    ['runtimes/win-x64/native/onnxruntime.dll', '0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c'],
    ['runtimes/win-x64/native/onnxruntime_providers_shared.dll', 'e45d471ea2a842b268c51291b96d53568b0dae10807f43d1fb7dc0eb84e83723'],
    ['LICENSE', 'c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674'],
    ['ThirdPartyNotices.txt', 'c53a76501ef60db6f865f20599f220761201ac4057683acefdab37d861b86622'],
  ]);
});

test('only the Windows x64 release maps ONNX files next to the exe in the installer', () => {
  for (const [target, { platform, arch }] of Object.entries(targets)) {
    const { args } = buildPlan(target, {}, platform, arch);
    const { bundle } = JSON.parse(args.at(-1));
    assert.deepEqual(bundle.resources, target === 'windows-x86_64' ? {
      'target/panda-router-bundle/1.31.0/onnxruntime.dll': 'panda-router-runtime/onnxruntime.dll',
      'target/panda-router-bundle/1.31.0/onnxruntime_providers_shared.dll': 'panda-router-runtime/onnxruntime_providers_shared.dll',
      'target/panda-router-bundle/1.31.0/LICENSE': 'panda-router-runtime/LICENSE',
      'target/panda-router-bundle/1.31.0/ThirdPartyNotices.txt': 'panda-router-runtime/ThirdPartyNotices.txt',
    } : undefined, target);
  }
});

function dllHeader() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x2022, 86);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}

test('PE validation requires a real AMD64 DLL header, not just a DLL filename', () => {
  assert.doesNotThrow(() => assertAmd64Dll(dllHeader(), 'good.dll'));
  assert.throws(() => assertAmd64Dll(Buffer.alloc(2), 'truncated.dll'), /PE32\+ AMD64/);
  for (const [offset, wrong] of [[0, 0], [0x3c, 127], [64, 0], [68, 0xaa64], [68, 0x14c], [86, 0x22], [88, 0x10b]]) {
    const bytes = dllHeader();
    bytes.writeUInt16LE(wrong, offset);
    assert.throws(() => assertAmd64Dll(bytes, 'wrong.dll'), /PE32\+ AMD64/);
  }
});

test('rejects a truncated archive, unlisted installed files, and a tampered DLL of the right size', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-onnx-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unexpected = join(directory, 'other.dll');
  await writeFile(unexpected, '');
  await assert.rejects(verifyNugetPackage(unexpected), /Tamaño o tipo incorrecto/);
  await assert.rejects(verifyWindowsRouterRuntime(directory, { exact: true }), /archivos de ONNX Runtime inesperados/);
  await rm(unexpected);
  await assert.rejects(verifyWindowsRouterRuntime(directory, { exact: true }), { code: 'ENOENT' });
  const dll = join(directory, 'onnxruntime.dll');
  await writeFile(dll, dllHeader());
  await truncate(dll, runtimePins['onnxruntime.dll'].size);
  await assert.rejects(verifyWindowsRouterRuntime(directory, { exact: true }), /SHA-256 incorrecto/);
});
