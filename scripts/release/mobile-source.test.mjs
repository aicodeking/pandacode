import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUNDLE_ID, SOURCE_ID, mobileSource } from './mobile-source.mjs';

const ROOT = fileRoot();
const SOURCE_FILE = resolve(ROOT, 'appstore/source.json');
const SCRIPT = resolve(ROOT, 'scripts/release/mobile-source.mjs');

function fileRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

const SOURCE_KEYS = ['name', 'identifier', 'apps'];
const APP_KEYS = [
  'name', 'bundleIdentifier', 'developerName', 'localizedDescription', 'iconURL',
  'versions', 'subtitle', 'tintColor', 'screenshotURLs',
];
const VERSION_KEYS = ['version', 'date', 'downloadURL', 'size'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assertKeys(object, allowed, label) {
  for (const key of Object.keys(object)) assert.ok(allowed.includes(key), `${label} has unexpected key ${key}`);
  for (const key of allowed) {
    if (['subtitle', 'tintColor', 'screenshotURLs', 'localizedDescription'].includes(key)) continue;
    assert.ok(key in object, `${label} is missing ${key}`);
  }
}

function assertSource(source, repository = 'aicodeking/pandacode') {
  assertKeys(source, SOURCE_KEYS, 'source');
  assert.equal(source.name, 'PandaCode');
  assert.equal(source.identifier, SOURCE_ID);
  assert.ok(Array.isArray(source.apps) && source.apps.length >= 1);
  for (const app of source.apps) {
    assertKeys(app, APP_KEYS, 'app');
    assert.equal(app.bundleIdentifier, BUNDLE_ID);
    assert.ok(typeof app.name === 'string' && app.name.length > 0);
    assert.ok(typeof app.developerName === 'string' && app.developerName.length > 0);
    assert.ok(typeof app.localizedDescription === 'string' && app.localizedDescription.length > 0);
    assert.match(app.iconURL, new RegExp(`^https://raw\\.githubusercontent\\.com/${repository}/main/`));
    assert.ok(app.screenshotURLs.every(url => url.startsWith(`https://raw.githubusercontent.com/${repository}/main/`)));
    assert.ok(Array.isArray(app.versions) && app.versions.length >= 1);
    for (const version of app.versions) {
      assertKeys(version, VERSION_KEYS, 'version');
      assert.match(version.version, SEMVER);
      assert.match(version.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isSafeInteger(version.size) && version.size >= 0, 'size must be a non-negative integer');
      assert.equal(
        version.downloadURL,
        `https://github.com/${repository}/releases/download/ios-v${version.version}/PandaCode.ipa`,
      );
    }
  }
}

test('mobileSource builds a schema-shaped source', () => {
  const source = mobileSource({ repository: 'hongkongkiwi/pandacode', version: '1.0.0', date: '2026-11-26', size: 1234 });
  assertSource(source, 'hongkongkiwi/pandacode');
  assert.equal(source.apps[0].tintColor, '#111111');
  assert.equal(source.apps[0].versions[0].size, 1234);
  assert.equal(source.apps[0].versions[0].version, '1.0.0');
});

test('mobileSource uses the tag and repository in the download URL', () => {
  const source = mobileSource({ repository: 'aicodeking/pandacode', version: '2.3.4', date: '2026-01-02', size: 1 });
  assert.equal(
    source.apps[0].versions[0].downloadURL,
    'https://github.com/aicodeking/pandacode/releases/download/ios-v2.3.4/PandaCode.ipa',
  );
  assert.match(source.apps[0].iconURL, /^https:\/\/raw\.githubusercontent\.com\/aicodeking\/pandacode\/main\//);
});

test('mobileSource rejects bad input', () => {
  const base = { repository: 'owner/repo', version: '1.0.0', date: '2026-11-26', size: 1 };
  assert.throws(() => mobileSource({ ...base, repository: 'nope' }), /repository/);
  assert.throws(() => mobileSource({ ...base, version: 'v1' }), /version/);
  assert.throws(() => mobileSource({ ...base, date: '26-11-2026' }), /date/);
  assert.throws(() => mobileSource({ ...base, size: -1 }), /size/);
  assert.throws(() => mobileSource({ ...base, size: 1.5 }), /size/);
});

test('the checked-in source file is schema-shaped', async () => {
  const source = JSON.parse(await readFile(SOURCE_FILE, 'utf8'));
  assertSource(source);
});

test('the CLI writes the source file', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'pandacode-mobile-source-'));
  const output = resolve(directory, 'source.json');
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT, '--repository', 'hongkongkiwi/pandacode', '--version', '1.2.3',
      '--date', '2026-02-03', '--size', '4096', '--output', output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assertSource(written, 'hongkongkiwi/pandacode');
    assert.deepEqual(written, mobileSource({ repository: 'hongkongkiwi/pandacode', version: '1.2.3', date: '2026-02-03', size: 4096 }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the CLI rejects missing arguments', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--version', '1.0.0'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
