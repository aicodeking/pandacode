import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageTrustedRuntime, trustedRuntime } from '../scripts/extensions-runtime.mjs';
import { buildPlan } from '../scripts/release/build.mjs';

test('trusted runtime packaging: unsupported targets retain declarative builds without reading runtime inputs', () => {
  for (const target of ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64', 'windows-aarch64', 'aarch64-pc-windows-msvc']) {
    assert.deepEqual(stageTrustedRuntime({ target, binary: '/must-not-read', licensePath: '/must-not-read' }), {});
  }
});

test('trusted runtime packaging: missing and corrupt local inputs fail before changing the stage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pandacode-runtime-package-'));
  try {
    const stage = join(directory, 'stage');
    writeFileSync(join(directory, 'LICENSE'), 'An incomplete MIT header is not the complete upstream notice');
    for (const target of ['win32-x64', 'windows-x86_64', 'x86_64-pc-windows-msvc']) {
      assert.throws(() => stageTrustedRuntime({ target, directory: stage, licensePath: '' }), /requires PANDACODE_EXTENSION_NODE_LICENSE/);
      assert.throws(() => stageTrustedRuntime({ target, directory: stage, licensePath: join(directory, 'LICENSE'), binary: '/must-not-read' }), /SHA-256 mismatch/);
      assert.equal(existsSync(stage), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('trusted runtime packaging: default local and release entrypoints carry app-owned resources, never activation downloads', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.package, 'node scripts/package.mjs');
  assert.equal(packageJson.scripts['package:fast'], 'node scripts/package.mjs -- --profile fast-release');
  const resources = { '/build/node.exe': 'extension-runtime/node.exe', '/build/LICENSE': 'extension-runtime/LICENSE', '/build/manifest.json': 'extension-runtime/manifest.json' };
  const plan = buildPlan('windows-x86_64', {}, 'win32', 'x64', resources);
  assert.deepEqual(JSON.parse(plan.args[plan.args.indexOf('--config') + 1]).bundle.resources, resources);
  const native = readFileSync(new URL('../src-tauri/src/extensions/supervisor.rs', import.meta.url), 'utf8');
  for (const pin of Object.values(trustedRuntime)) assert.ok(native.includes(`"${pin}"`), `native and packaging pin ${pin}`);
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("matrix.target == 'windows-x86_64' && '26.1.0' || '22'"));
  assert.ok(workflow.includes('https://raw.githubusercontent.com/nodejs/node/v26.1.0/LICENSE'));
  assert.ok(workflow.includes('PANDACODE_EXTENSION_NODE_LICENSE='));
});

test('trusted runtime CI: single-line run commands quote YAML colon-space sequences', () => {
  const workflow = readFileSync(new URL('../.github/workflows/extensions-runtime.yml', import.meta.url), 'utf8');
  for (const line of workflow.split(/\r?\n/)) {
    const command = /^\s*- run: (.+)$/.exec(line)?.[1];
    if (command && !['\'', '"', '|', '>'].includes(command[0])) {
      assert.doesNotMatch(command, /:\s/, 'A Rust test filter ending in :: must be quoted as a YAML scalar.');
    }
  }
});
