import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASSETS, PUBKEY, assetFor, desktopEntry, supportedPlatforms, verifyMinisign } from './installer.mjs';
import { targets } from '../../scripts/release/common.mjs';

/** Every build a release publishes, named for people. */
const PUBLISHED = ['Apple silicon', 'Intel', 'Windows x64', 'Windows arm64', 'Linux x64', 'Linux arm64'];

const b64 = b => Buffer.from(b).toString('base64');

function fixture(alg = 'ED', keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pk = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const pubkey = b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, pk]))}\n`);
  const data = randomBytes(1000);
  const raw = sign(null, alg === 'ED' ? createHash('blake2b512').update(data).digest() : data, privateKey);
  const comment = 'timestamp:1 file:x';
  const global = sign(null, Buffer.concat([raw, Buffer.from(comment)]), privateKey);
  const sigFile = b64(`untrusted comment: signature\n${b64(Buffer.concat([Buffer.from(alg), keyId, raw]))}\ntrusted comment: ${comment}\n${b64(global)}\n`);
  return { pubkey, data, sigFile };
}

for (const alg of ['ED', 'Ed']) {
  test(`verifies a ${alg} signature`, () => {
    const { pubkey, data, sigFile } = fixture(alg);
    verifyMinisign(data, sigFile, pubkey);
  });
}

test('rejects a tampered byte', () => {
  const { pubkey, data, sigFile } = fixture();
  data[5] ^= 1;
  assert.throws(() => verifyMinisign(data, sigFile, pubkey), /does not match/);
});

test('rejects a different key id', () => {
  const a = fixture();
  const b = fixture();
  assert.throws(() => verifyMinisign(a.data, a.sigFile, b.pubkey), /different key/);
});

test('rejects a tampered trusted comment', () => {
  const { pubkey, data, sigFile } = fixture();
  const text = Buffer.from(sigFile, 'base64').toString().replace('timestamp:1', 'timestamp:2');
  assert.throws(() => verifyMinisign(data, b64(text), pubkey), /comment/);
});

test('picks the asset per platform', () => {
  assert.equal(assetFor('darwin', 'arm64'), 'PandaCode-macOS-arm64.app.tar.gz');
  assert.equal(assetFor('win32', 'x64'), 'PandaCode-Windows-x64-setup.exe');
  assert.equal(assetFor('linux', 'x64'), 'PandaCode-Linux-x86_64.AppImage');
  assert.equal(assetFor('darwin', 'x64'), 'PandaCode-macOS-x64.app.tar.gz');
  assert.throws(() => assetFor('darwin', 'ia32'), /no build/);
  assert.equal(assetFor('linux', 'arm64'), 'PandaCode-Linux-aarch64.AppImage');
  assert.equal(assetFor('win32', 'arm64'), 'PandaCode-Windows-arm64-setup.exe');
});

test('writes a desktop entry', () => {
  const text = desktopEntry('/h/.local/bin/pandacode', '/h/icon.png');
  assert.match(text, /^\[Desktop Entry\]\n/);
  assert.match(text, /\nExec=\/h\/\.local\/bin\/pandacode\n/);
  assert.match(text, /\nIcon=\/h\/icon\.png\n/);
});

test('the no-build error names every published build', () => {
  let message = '';
  try { assetFor('darwin', 'ia32'); } catch (error) { message = error.message; }
  assert.match(message, /no build/);
  for (const name of PUBLISHED) assert.ok(message.includes(name), `${name} is missing from the error`);
});

test('the help text names every published build', () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL('./bin/pandacode.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  for (const name of PUBLISHED) assert.ok(help.includes(name), `${name} is missing from the help`);
});

test('every published build has a name', () => {
  assert.equal(supportedPlatforms().length, Object.keys(ASSETS).length);
  for (const name of supportedPlatforms()) {
    assert.ok(PUBLISHED.some(published => name.includes(published)), `${name} is not a known platform`);
  }
});

test('the installer covers every published build', () => {
  const missing = [];
  for (const [target, config] of Object.entries(targets)) {
    const key = `${config.platform}-${config.arch}`;
    if (!ASSETS[key]) missing.push(`${target}: no asset for ${key}`);
    else if (ASSETS[key] !== config.asset && ASSETS[key] !== config.updaterAsset) {
      missing.push(`${target}: ${ASSETS[key]} is neither ${config.asset} nor ${config.updaterAsset}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('embedded pubkey matches tauri.conf.json', () => {
  const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url)));
  assert.equal(PUBKEY, conf.plugins.updater.pubkey);
});
