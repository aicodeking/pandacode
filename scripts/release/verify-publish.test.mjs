import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { targets, updaterManifest } from './common.mjs';
import { verifyPublishAssets } from './verify-publish.mjs';

const releaseVersion = '1.2.3';
const repository = 'example/pandacode';
const notes = '## Fixes\n\n- Something.\n';
const b64 = value => Buffer.from(value).toString('base64');

// A real minisign key in Tauri's format (base64 of the minisign text files).
function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const pubkey = b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, raw]))}\n`);
  const signFile = data => {
    const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const comment = 'timestamp:1\tfile:update';
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return b64(`untrusted comment: signature\n${b64(Buffer.concat([Buffer.from('ED'), keyId, signature]))}\ntrusted comment: ${comment}\n${b64(global)}\n`);
  };
  return { pubkey, signFile };
}

const key = minisignKey();

async function release(t, { signed = true, sbom = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-publish-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = (name, data) => writeFile(join(directory, name), data);
  const signatures = {};
  for (const [target, { asset, updaterAsset }] of Object.entries(targets)) {
    const data = `installer for ${target}`;
    await write(asset, data);
    await write(`${asset}.sha256`, `${createHash('sha256').update(data).digest('hex')}  ${asset}\n`);
    if (!signed) continue;
    if (updaterAsset !== asset) await write(updaterAsset, `update for ${target}`);
    signatures[target] = key.signFile(await readFile(join(directory, updaterAsset)));
    await write(`${updaterAsset}.sig`, signatures[target]);
  }
  if (signed) await write('latest.json', JSON.stringify(updaterManifest(releaseVersion, notes, signatures, '2026-01-01T00:00:00Z', repository)));
  if (sbom) await write('SBOM-COVERAGE.json', '{}');
  const warnings = [];
  const verify = ({ requireSigned } = {}) => verifyPublishAssets({
    directory, releaseVersion, notes, pubkey: key.pubkey, repository, requireSigned,
    warn: message => warnings.push(message),
  });
  const editManifest = async edit => {
    const manifest = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
    edit(manifest);
    await write('latest.json', JSON.stringify(manifest));
  };
  return { directory, write, verify, warnings, editManifest };
}

const mac = targets['darwin-aarch64'];
const linux = targets['linux-x86_64'];

test('a complete signed release for all six platforms passes', async (t) => {
  const { verify, warnings } = await release(t);
  assert.deepEqual(await verify(), { signed: true });
  assert.deepEqual(warnings, []);
});

test('a missing platform installer fails', async (t) => {
  const { directory, verify } = await release(t);
  await unlink(join(directory, targets['windows-aarch64'].asset));
  await assert.rejects(verify, /Installer PandaCode-Windows-arm64-setup.exe is missing/);
});

test('a missing or mismatched checksum fails', async (t) => {
  const { directory, write, verify } = await release(t);
  await write(mac.asset, 'tampered');
  await assert.rejects(verify, /PandaCode-macOS-arm64.dmg does not match its SHA-256 sidecar/);
  await unlink(join(directory, `${mac.asset}.sha256`));
  await assert.rejects(verify, /PandaCode-macOS-arm64.dmg.sha256 is missing/);
});

test('a partial set of updater signatures fails', async (t) => {
  const { directory, verify } = await release(t);
  await unlink(join(directory, `${linux.updaterAsset}.sig`));
  await assert.rejects(verify, /PandaCode-Linux-x86_64.AppImage.sig is missing/);
});

test('a missing updater file fails', async (t) => {
  const { directory, verify } = await release(t);
  await unlink(join(directory, mac.updaterAsset));
  await assert.rejects(verify, /Updater file PandaCode-macOS-arm64.app.tar.gz is missing/);
});

test('a tampered update file or a signature from another key fails', async (t) => {
  const { write, verify } = await release(t);
  await write(mac.updaterAsset, 'tampered update');
  await assert.rejects(verify, /PandaCode-macOS-arm64.app.tar.gz.sig does not verify: Signature does not match/);
  await write(mac.updaterAsset, 'update for darwin-aarch64');
  await write(`${mac.updaterAsset}.sig`, minisignKey().signFile(Buffer.from('update for darwin-aarch64')));
  await assert.rejects(verify, /does not verify: Signature was made with a different key/);
});

test('latest.json must exist and match the version, notes, URLs and signatures', async (t) => {
  for (const [name, edit, expected] of [
    ['version', manifest => { manifest.version = '1.2.2'; }, /names version 1.2.2, not 1.2.3/],
    ['notes', manifest => { manifest.notes = 'Other notes'; }, /notes differ/],
    ['url', manifest => { manifest.platforms['linux-aarch64'].url = 'https://example.com/x'; }, /URL for linux-aarch64/],
    ['signature', manifest => { manifest.platforms['windows-x86_64'].signature = 'c2ln'; }, /signature for windows-x86_64 differs/],
    ['platform', manifest => { delete manifest.platforms['darwin-x86_64']; }, /no entry for darwin-x86_64/],
  ]) {
    await t.test(name, async (t) => {
      const { verify, editManifest } = await release(t);
      await editManifest(edit);
      await assert.rejects(verify, expected);
    });
  }
  await t.test('missing', async (t) => {
    const { directory, verify } = await release(t);
    await unlink(join(directory, 'latest.json'));
    await assert.rejects(verify, /latest.json is missing/);
  });
  await t.test('invalid JSON', async (t) => {
    const { write, verify } = await release(t);
    await write('latest.json', '{');
    await assert.rejects(verify, /latest.json is not valid JSON/);
  });
});

test('a latest.json without any signatures still requires the signed update files', async (t) => {
  const { write, verify } = await release(t, { signed: false });
  await write('latest.json', '{}');
  await assert.rejects(verify, /Updater file PandaCode-macOS-arm64.app.tar.gz is missing/);
});

test('updater archives without any signatures or manifest fail even when signing is optional', async (t) => {
  const { directory, verify } = await release(t);
  for (const { updaterAsset } of Object.values(targets)) {
    await unlink(join(directory, `${updaterAsset}.sig`));
  }
  await unlink(join(directory, 'latest.json'));
  await assert.rejects(() => verify({ requireSigned: false }), /Updater signature PandaCode-macOS-arm64\.app\.tar\.gz\.sig is missing/);
});

test('required signing fails when all updater archives, signatures and the manifest are missing', async (t) => {
  const { verify } = await release(t, { signed: false });
  await assert.rejects(() => verify({ requireSigned: true }), /Updater file PandaCode-macOS-arm64\.app\.tar\.gz is missing/);
});

test('an unsigned fork release publishes without updater files and warns about a missing SBOM', async (t) => {
  const { verify, warnings } = await release(t, { signed: false, sbom: false });
  assert.deepEqual(await verify({ requireSigned: false }), { signed: false });
  assert.deepEqual(warnings, ['::warning::SBOM-COVERAGE.json is missing from publish assets.']);
});

test('the CLI requires updater artifacts when passed --require-signed', async (t) => {
  const { directory, write } = await release(t, { signed: false });
  await write('notes.md', notes);
  const script = fileURLToPath(new URL('./verify-publish.mjs', import.meta.url));
  const args = [directory, releaseVersion, join(directory, 'notes.md')];
  const unsigned = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(unsigned.status, 0, unsigned.stderr);
  assert.match(unsigned.stdout, /Verified 6 installers \(unsigned/);

  const required = spawnSync(process.execPath, [script, '--require-signed', ...args], { encoding: 'utf8' });
  assert.equal(required.status, 1, required.stderr);
  assert.match(required.stderr, /Updater file PandaCode-macOS-arm64\.app\.tar\.gz is missing/);
});

test('signatures are checked against the app updater key by default', async (t) => {
  const { directory } = await release(t);
  await assert.rejects(verifyPublishAssets({ directory, releaseVersion, notes, repository, warn() {} }), /different key/);
});
