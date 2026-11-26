import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPlan, builtArtifact, checksumLine, macosSigning, notarizeDmg, notarytoolArgs, resignAppImage, verifyMacArtifacts } from './build.mjs';
import { appImageBundleOptions } from './common.mjs';

const env = { PANDACODE_LICENSE_PUBLIC_KEY: 'stale', PANDACODE_UPDATE_PUBLIC_KEY: 'stale', TAURI_SIGNING_PRIVATE_KEY: 'stale', APPLE_ID: 'someone', APPLE_SIGNING_IDENTITY: 'Developer ID Application: Someone', PATH: 'test-path' };
const config = plan => JSON.parse(plan.args.at(-1));

test('builds require the native host and never forward old license keys or Apple variables to Windows and Linux', () => {
  for (const [target, platform] of [['windows-x86_64', 'win32'], ['windows-aarch64', 'win32'], ['linux-x86_64', 'linux']]) {
    const arch = target === 'windows-aarch64' ? 'arm64' : 'x64';
    const plan = buildPlan(target, env, platform, arch);
    for (const name of ['APPLE_ID', 'APPLE_SIGNING_IDENTITY', 'PANDACODE_LICENSE_PUBLIC_KEY', 'PANDACODE_UPDATE_PUBLIC_KEY']) assert.equal(plan.env[name], undefined, name);
    assert.equal(plan.env.PATH, 'test-path');
    assert.equal(plan.signing.mode, 'unsigned');
    // The update signing key is the one secret a build needs: it signs the in-app update file.
    assert.equal(plan.env.TAURI_SIGNING_PRIVATE_KEY, 'stale');
    assert.equal(config(plan).bundle.createUpdaterArtifacts, true);
    assert.equal(config(buildPlan(target, { PATH: 'p' }, platform, arch)).bundle.createUpdaterArtifacts, false);
    assert.equal(config(plan).plugins, undefined);
    assert.throws(() => buildPlan(target, env, 'darwin', 'arm64'), /native/);
  }
  assert.throws(() => buildPlan('darwin-aarch64', env, 'darwin', 'x64'), /native/);
  assert.throws(() => buildPlan('darwin-x86_64', env, 'darwin', 'arm64'), /native/);
  assert.ok(buildPlan('darwin-x86_64', { PATH: 'p' }, 'darwin', 'x64').args.includes('x86_64-apple-darwin'));
  assert.equal(env.APPLE_ID, 'someone', 'the caller environment is unchanged');
});

test('Windows installs per user, bootstraps WebView2 and links the C++ runtime statically', () => {
  const plan = buildPlan('windows-x86_64', { ...env, STATIC_VCRUNTIME: 'false' }, 'win32', 'x64');
  assert.equal(plan.env.STATIC_VCRUNTIME, 'true');
  assert.deepEqual(config(plan).bundle.windows.webviewInstallMode, { type: 'downloadBootstrapper', silent: true });
  assert.equal(config(plan).bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(buildPlan('linux-x86_64', { STATIC_VCRUNTIME: 'false' }, 'linux', 'x64').env.STATIC_VCRUNTIME, 'false');
});

test('Linux bundles the external-link helper without changing Mac or Windows bundles', () => {
  const expected = { linux: { appimage: { files: { '/usr/bin/xdg-open': '/usr/bin/xdg-open' } } } };
  assert.deepEqual(appImageBundleOptions('linux-x86_64'), expected);
  assert.deepEqual(appImageBundleOptions('linux-aarch64'), expected);
  assert.deepEqual(config(buildPlan('linux-x86_64', env, 'linux', 'x64')).bundle.linux, expected.linux);
  assert.deepEqual(appImageBundleOptions('darwin-aarch64'), {});
  assert.equal(config(buildPlan('windows-x86_64', env, 'win32', 'x64')).bundle.linux, undefined);
});

test('macOS falls back to an ad-hoc signature and drops partial Apple credentials', () => {
  const plan = buildPlan('darwin-aarch64', { APPLE_ID: 'someone', PATH: 'p' }, 'darwin', 'arm64');
  assert.equal(plan.signing.mode, 'adhoc');
  assert.equal(plan.env.APPLE_SIGNING_IDENTITY, '-');
  assert.equal(plan.env.APPLE_ID, undefined);
  assert.equal(config(plan).bundle.macOS.signingIdentity, '-');
  assert.ok(plan.args.includes('app,dmg'));
});

test('Developer ID signing requires a real identity and notarization credentials', () => {
  const identity = 'Developer ID Application: Example (TEAM123)';
  assert.throws(() => macosSigning({ APPLE_SIGNING_IDENTITY: 'Apple Development: Someone' }), /Developer ID/);
  assert.throws(() => macosSigning({ APPLE_SIGNING_IDENTITY: identity }), /notarized/);
  assert.deepEqual(macosSigning({ APPLE_SIGNING_IDENTITY: identity, APPLE_API_KEY: 'k', APPLE_API_ISSUER: 'i', APPLE_API_KEY_PATH: '/k.p8' }), { mode: 'developer-id', identity });
  const plan = buildPlan('darwin-aarch64', { APPLE_SIGNING_IDENTITY: identity, APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 't' }, 'darwin', 'arm64');
  assert.equal(plan.signing.mode, 'developer-id');
  assert.equal(plan.env.APPLE_ID, 'a');
});

test('the build selects the exact versioned bundle Tauri produced', () => {
  for (const [target, file] of [['windows-x86_64', 'PandaCode_1.2.3_x64-setup.exe'], ['linux-x86_64', 'PandaCode_1.2.3_amd64.AppImage'], ['darwin-aarch64', 'PandaCode_1.2.3_aarch64.dmg'], ['darwin-x86_64', 'PandaCode_1.2.3_x64.dmg']]) {
    assert.equal(builtArtifact([file, file.replace('1.2.3', '1.2.2')], '1.2.3', target), file);
    assert.throws(() => builtArtifact([file], '1.2.4', target), /did not produce/);
  }
});

test('checksum sidecars use the sha256sum format', () => {
  assert.equal(checksumLine('a'.repeat(64), 'PandaCode-Linux-x86_64.AppImage'), `${'a'.repeat(64)}  PandaCode-Linux-x86_64.AppImage\n`);
  assert.throws(() => checksumLine('nothex', 'x'), /SHA-256/);
});

test('notarytool uses App Store Connect API keys first, then an Apple ID', () => {
  const apiKey = { APPLE_API_KEY: ' KEY ', APPLE_API_ISSUER: 'issuer ', APPLE_API_KEY_PATH: ' /k.p8', APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 't' };
  assert.deepEqual(notarytoolArgs('/x.dmg', apiKey), ['notarytool', 'submit', '/x.dmg', '--key', '/k.p8', '--key-id', 'KEY', '--issuer', 'issuer', '--wait']);
  const appleId = { APPLE_API_KEY: 'KEY', APPLE_API_ISSUER: ' ', APPLE_ID: ' me@example.com', APPLE_PASSWORD: 'secret ', APPLE_TEAM_ID: 'TEAM' };
  assert.deepEqual(notarytoolArgs('/x.dmg', appleId), ['notarytool', 'submit', '/x.dmg', '--apple-id', 'me@example.com', '--password', 'secret', '--team-id', 'TEAM', '--wait']);
  for (const partial of [{}, { APPLE_ID: 'me', APPLE_PASSWORD: 'hunter2' }, { APPLE_API_KEY: 'key-secret', APPLE_API_ISSUER: 'issuer-secret', APPLE_API_KEY_PATH: 7 }]) {
    assert.throws(() => notarytoolArgs('/x.dmg', partial), error => /Notarizing the disk image/.test(error.message) && !/hunter2|secret/.test(error.message));
  }
});

test('the disk image is submitted for notarization, then stapled', async () => {
  const calls = [];
  await notarizeDmg('/x.dmg', { APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 't' }, { run: async (command, args) => { calls.push([command, ...args]); } });
  assert.deepEqual(calls, [
    ['/usr/bin/xcrun', 'notarytool', 'submit', '/x.dmg', '--apple-id', 'a', '--password', 'p', '--team-id', 't', '--wait'],
    ['/usr/bin/xcrun', 'stapler', 'staple', '/x.dmg'],
  ]);
  const failing = [];
  await assert.rejects(notarizeDmg('/x.dmg', {}, { run: async (...args) => { failing.push(args); } }), /Notarizing/);
  assert.equal(failing.length, 0, 'nothing runs without credentials');
  await assert.rejects(notarizeDmg('/x.dmg', { APPLE_ID: 'a', APPLE_PASSWORD: 'p', APPLE_TEAM_ID: 't' }, { run: async (command, args) => { failing.push(args); if (args[0] === 'notarytool') throw new Error('Invalid'); } }), /Invalid/);
  assert.equal(failing.length, 1, 'a rejected submission is never stapled');
});

test('macOS validates the app inside each Developer ID download and cleans up on failure', { skip: process.platform === 'win32' }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'pandacode-release-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const releaseVersion = '1.2.3';
  const app = join(scratch, 'PandaCode.app');
  const dmg = join(scratch, 'PandaCode.dmg');
  const updater = join(scratch, 'PandaCode.app.tar.gz');
  const makeApp = async (path, binary = 'current binary') => {
    await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(path, 'Contents/MacOS/pandacode'), binary);
  };
  await makeApp(app);

  for (const [name, badPayload, failure, expectedError] of [
    ['valid'],
    ['missing DMG container ticket', 'container', 'ticket', /missing ticket/],
    ['DMG container Gatekeeper rejection', 'container', 'assessment', /assessment failed/],
    ['missing DMG ticket', 'dmg', 'ticket', /missing ticket/],
    ['missing updater ticket', 'updater', 'ticket', /missing ticket/],
    ['wrong DMG binary', 'dmg', 'binary', /disk image contains a different app build/],
    ['wrong updater version', 'updater', 'version', /updater archive contains a different app build/],
    ['Gatekeeper rejection', 'updater', 'assessment', /assessment failed/],
    ['extraction failure', 'updater', 'extraction', /extraction failed/],
    ['no updater'],
  ]) {
    await t.test(name, async () => {
      const payloads = new Map([[dmg, { kind: 'container' }]]);
      const checks = [];
      const unpack = async (dir, kind) => {
        const path = join(dir, 'PandaCode.app');
        payloads.set(path, { kind, dir });
        await makeApp(path, badPayload === kind && failure === 'binary' ? 'stale binary' : undefined);
      };
      const commands = {
        async run(command, args) {
          const path = args.at(-1);
          if (command === '/usr/bin/hdiutil') {
            if (args[0] === 'verify') assert.equal(args[1], dmg);
            if (args[0] === 'attach') {
              assert.equal(args[1], dmg);
              assert.ok(args.includes('-readonly'));
              const mount = args[args.indexOf('-mountpoint') + 1];
              await unpack(mount, 'dmg');
              await symlink('/Applications', join(mount, 'Applications'));
            }
            if (args[0] === 'detach') {
              await rm(join(args[1], 'PandaCode.app'), { recursive: true });
              await rm(join(args[1], 'Applications'));
            }
          } else if (command === '/usr/bin/tar') {
            assert.equal(args[1], updater);
            await unpack(path, 'updater');
            if (failure === 'extraction') throw new Error('extraction failed');
          } else if (command === '/usr/bin/xcrun' || command === '/usr/sbin/spctl') {
            const { kind } = payloads.get(path);
            if (command === '/usr/bin/xcrun') assert.deepEqual(args.slice(0, -1), ['stapler', 'validate']);
            else if (kind === 'container') assert.deepEqual(args.slice(0, -1), ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', '--ignore-cache', '--no-cache']);
            else assert.deepEqual(args.slice(0, 4), ['--assess', '--type', 'execute', '--verbose']);
            const check = command === '/usr/bin/xcrun' ? 'ticket' : 'assessment';
            checks.push([kind, check]);
            if (kind === badPayload && check === failure) throw new Error(check === 'ticket' ? 'missing ticket' : 'assessment failed');
          } else {
            assert.equal(command, '/usr/bin/codesign');
            assert.ok(payloads.has(path));
            checks.push([payloads.get(path).kind, 'signature']);
          }
        },
        execFileSync(command, args) {
          assert.equal(command, '/usr/libexec/PlistBuddy');
          if (args[1] === 'Print :CFBundleExecutable') return 'pandacode\n';
          assert.equal(args[1], 'Print :CFBundleShortVersionString');
          const path = args.at(-1);
          const { kind } = payloads.get(join(path, '../..'));
          return badPayload === kind && failure === 'version' ? '1.2.2\n' : `${releaseVersion}\n`;
        },
      };
      const verify = () => verifyMacArtifacts({ dmg, app, releaseVersion, mode: 'developer-id', updater: name === 'no updater' ? undefined : updater }, commands);
      if (expectedError) {
        await assert.rejects(verify, expectedError);
      } else {
        await verify();
        const kinds = name === 'no updater' ? ['dmg'] : ['dmg', 'updater'];
        assert.deepEqual(checks, [['container', 'ticket'], ['container', 'assessment'], ...kinds.flatMap(kind => ['signature', 'ticket', 'assessment'].map(check => [kind, check]))]);
      }
      for (const { dir } of payloads.values()) {
        if (!dir) continue;
        await assert.rejects(lstat(dir), { code: 'ENOENT' });
      }
    });
  }
});

test('re-signing a repacked Linux AppImage binds the signature to the release version', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'pandacode-resign-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const keyFile = join(scratch, 'updater.key');
  await writeFile(keyFile, 'key-contents\n');

  const calls = [];
  const source = '/tmp/PandaCode_1.2.3_amd64.AppImage';
  await resignAppImage(source, '1.2.3', { TAURI_SIGNING_PRIVATE_KEY: keyFile, PATH: 'test-path' }, {
    tauriCli: '/fake/tauri.js',
    async run(command, args, options) { calls.push({ command, args, options }); },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['/fake/tauri.js', 'signer', 'sign', '--app-version', '1.2.3', source]);
  assert.equal(calls[0].options.env.TAURI_SIGNING_PRIVATE_KEY, 'key-contents');
  await assert.rejects(() => resignAppImage(source, 'not-a-version', {}, { run() {} }), /Release version must be a stable SemVer/);
});
