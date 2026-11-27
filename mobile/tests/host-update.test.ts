/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canInstall, CHECKING, markRestarting, normalizeStatus, restartInFlight, RESTARTING, restartWarning, updateLine, updateReady, updateTone, wentOffline,
} from '../src/store/host-update.ts';

const status = (extra: Record<string, unknown> = {}) => normalizeStatus({
  currentVersion: '0.3.161', update: { version: '0.3.162' }, installable: true, restarting: false, error: null, ...extra,
});

test('a status reply decodes to its five fields, with unknown ones reading as absent', () => {
  assert.deepEqual(status(), { currentVersion: '0.3.161', update: { version: '0.3.162' }, installable: true, restarting: false, error: null });
  // Up to date: no update, nothing to install.
  assert.deepEqual(status({ update: null, installable: false }), { currentVersion: '0.3.161', update: null, installable: false, restarting: false, error: null });
});

test('a malformed or partial reply still draws a card instead of throwing', () => {
  const empty = { currentVersion: '', update: null, installable: false, restarting: false, error: null };
  for (const junk of [null, undefined, 'junk', 42, []]) assert.deepEqual(normalizeStatus(junk), empty, String(junk));
  // A version with a leading v and padding reads the same; non-strings are dropped.
  assert.equal(normalizeStatus({ currentVersion: '  v0.4.0 ' }).currentVersion, '0.4.0');
  assert.equal(normalizeStatus({ currentVersion: 4 }).currentVersion, '');
  // An update without a usable version is no update; other flags read strictly as true.
  assert.equal(normalizeStatus({ update: {} }).update, null);
  assert.equal(normalizeStatus({ update: '0.4.0' }).update, null);
  assert.deepEqual(normalizeStatus({ update: { version: '0.4.0', extra: 'x' } }).update, { version: '0.4.0' });
  assert.equal(normalizeStatus({ installable: 'yes' }).installable, false);
  assert.equal(normalizeStatus({ restarting: 1 }).restarting, false);
  // A blank error is no error; a long one is bounded.
  assert.equal(normalizeStatus({ error: '   ' }).error, null);
  assert.equal(normalizeStatus({ error: 'x'.repeat(2000) }).error!.length, 500);
});

test('the state line says what matters: restarting, then the error, then the update, then the version', () => {
  assert.equal(updateLine(null), CHECKING);
  assert.equal(updateLine(status()), 'Update to 0.3.162 available');
  assert.equal(updateLine(status({ update: null, installable: false })), 'Up to date (0.3.161)');
  assert.equal(updateLine(status({ currentVersion: '', update: null, installable: false })), 'Up to date', 'no version to name');
  assert.equal(updateLine(status({ error: 'PandaCode could not reach GitHub.' })), 'PandaCode could not reach GitHub.');
  // A restart outranks a stale error and the release it is installing.
  assert.equal(updateLine(status({ restarting: true, error: 'dropped' })), RESTARTING);
  assert.equal(updateLine(markRestarting(status())), RESTARTING);
  // A host that installs by hand: the release is named but not offered as a button.
  assert.equal(updateLine(status({ installable: false })), 'Update to 0.3.162 available');
});

test('the line is toned: a restart is news, a failure is bad, an update is worth a tap', () => {
  assert.equal(updateTone(null), undefined);
  assert.equal(updateTone(status()), 'info');
  assert.equal(updateTone(status({ error: 'no' })), 'danger');
  assert.equal(updateTone(status({ restarting: true })), 'warning');
  assert.equal(updateTone(status({ update: null, installable: false })), undefined);
});

test('the update button needs a release the computer can install, and waits out a restart', () => {
  assert.equal(updateReady(null), false);
  assert.equal(updateReady(status()), true);
  assert.equal(canInstall(status()), true);
  // Installable but up to date: nothing to install.
  assert.equal(updateReady(status({ update: null })), false);
  // Waiting for a download: named, but not offered.
  assert.equal(updateReady(status({ installable: false })), false);
  // Restarting: the button stays shown (updateReady) but is disabled.
  const restarting = status({ restarting: true });
  assert.equal(updateReady(restarting), true);
  assert.equal(restartInFlight(restarting), true);
  assert.equal(canInstall(restarting), false);
});

test('the status right after asking keeps the version and release and turns restarting on', () => {
  const next = markRestarting(status({ error: 'stale' }));
  assert.deepEqual(next, { currentVersion: '0.3.161', update: { version: '0.3.162' }, installable: true, restarting: true, error: null });
  assert.equal(updateLine(next), RESTARTING);
  // With no read yet (the tap beat the first status), it is still a calm restarting state.
  assert.deepEqual(markRestarting(null), { currentVersion: '', update: null, installable: false, restarting: true, error: null });
});

test('the confirm spells out what a restart does on the computer and to this phone', () => {
  const body = restartWarning('Mac Studio');
  assert.match(body, /restarts on Mac Studio/);
  assert.match(body, /install the update/);
  assert.match(body, /disconnects/);
  assert.match(body, /agents running there stop/);
  assert.match(body, /resumed/);
});

test('the host API registers the three methods and decodes defensively through normalizeStatus', () => {
  const api = readFileSync(new URL('../src/connect/api/host.ts', import.meta.url), 'utf8');
  assert.match(api, /registerMethods\(\['host\.updateStatus', 'host\.checkUpdate', 'host\.updateAndRestart'\] as const\)/);
  // Every wrapper decodes through the pure helper, so a half reply never throws at the card.
  for (const fn of ['hostUpdateStatus', 'checkHostUpdate']) assert.match(api, new RegExp(`${fn} = \\(deviceId: string\\): Promise<HostUpdateStatus>`), fn);
  assert.equal((api.match(/\.then\(normalizeStatus\)/g) ?? []).length, 2);
  // Checking hits the release feed, so it waits longer than the default 20 s.
  assert.match(api, /hostCall<unknown>\(deviceId, 'host\.checkUpdate', \{\}, \{ timeoutMs: CHECK_TIMEOUT_MS \}\)/);
});

test('the card words the version through versionLine and gates the two writes', () => {
  const card = readFileSync(new URL('../src/ui/hub/HostUpdate.tsx', import.meta.url), 'utf8');
  // The version says "PandaCode 0.3.161" through the shared helper, never a second wording.
  assert.match(card, /versionLine\(caps, shown\?\.currentVersion\)/);
  assert.doesNotMatch(card, /PandaCode \$\{/);
  // Both actions sit inside the allowed branch; a refusal lists both methods in one note.
  assert.match(card, /useHostAllows\(device, 'host\.checkUpdate'\)/);
  assert.match(card, /useAccessNote|AccessNote device=\{device\} methods=\{\['host\.checkUpdate', 'host\.updateAndRestart'\]\}/);
  // The restart is confirmed before it is asked, with the plain warning.
  assert.match(card, /Alert\.alert\('Update and restart\?', restartWarning\(computer\)/);
});

test('the demo offers a release, restarts (calls then fail offline), and comes back updated', async () => {
  const { demoCall, DEMO_RELEASE, DEMO_RESTART_MS, DEMO_VERSION } = await import('../src/demo-host.ts');
  const { OFFLINE } = await import('../src/connect/rpc.ts');
  const { normalizeStatus, updateLine, canInstall, restartInFlight } = await import('../src/store/host-update.ts');
  let state: any = { ready: true, signedIn: true, connected: true, demo: true, deviceId: 'phone', devices: [{ id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }] };
  const timers: { run: () => void; ms: number }[] = [];
  let now = 1000;
  const host = { get: () => state, set: (update: (s: any) => any) => { state = { ...state, ...update(state) }; }, later: (run: () => void, ms: number) => { timers.push({ run, ms }); }, now: () => now };
  const answer = async (method: string) => normalizeStatus(await demoCall(host, 'studio', method, {}));

  const waiting = await answer('host.updateStatus');
  assert.equal(waiting.currentVersion, DEMO_VERSION);
  assert.equal(waiting.update?.version, DEMO_RELEASE);
  assert.equal(canInstall(waiting), true);
  assert.equal(updateLine(waiting), `Update to ${DEMO_RELEASE} available`);
  assert.deepEqual(await answer('host.checkUpdate'), waiting, 'checking answers the same shape');

  // Update and restart: the computer goes down to install, so calls to it fail at once with OFFLINE
  // rather than waiting out a timeout, and presence would list it offline.
  assert.deepEqual(await demoCall(host, 'studio', 'host.updateAndRestart', {}), { restarting: true });
  assert.equal((state.devices[0] as { online: boolean }).online, false, 'down to install');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, DEMO_RESTART_MS);
  await assert.rejects(demoCall(host, 'studio', 'host.updateStatus', {}), { message: OFFLINE });

  // It comes back on the new version, up to date.
  now += DEMO_RESTART_MS;
  timers[0].run();
  assert.equal((state.devices[0] as { online: boolean }).online, true, 'back online');
  const after = await answer('host.updateStatus');
  assert.equal(after.currentVersion, DEMO_RELEASE);
  assert.equal(after.update, null);
  assert.equal(canInstall(after), false);
  assert.equal(restartInFlight(after), false);
  assert.equal(updateLine(after), `Up to date (${DEMO_RELEASE})`);
});

// ---- The disconnect after a restart ----

test('the computers that went offline are the ones online before and not online now', () => {
  const before = new Set(['studio', 'laptop']);
  // Update and restart: the computer is gone from presence, or listed offline while it restarts.
  assert.deepEqual(wentOffline(before, [{ id: 'laptop', online: true }]), ['studio']);
  assert.deepEqual(wentOffline(new Set(['studio']), [{ id: 'studio', online: false }]), ['studio']);
  // Still online, or joined since: nothing to fail.
  assert.deepEqual(wentOffline(before, [{ id: 'studio', online: true }, { id: 'laptop', online: true }]), []);
  assert.deepEqual(wentOffline(before, [{ id: 'studio', online: true }, { id: 'laptop', online: true }, { id: 'new', online: true }]), []);
  assert.deepEqual(wentOffline(new Set(), [{ id: 'studio', online: false }]), []);
});

test('client.ts fails a host\'s waiting calls when presence shows it go offline, and asks it host.hello again', () => {
  const client = readFileSync(new URL('../src/connect/client.ts', import.meta.url), 'utf8');
  // In-flight calls to a host that dropped (Update and restart) fail at once, not after a timeout.
  assert.match(client, /for \(const id of wentOffline\(onlineHosts, devices\)\) \{/);
  assert.match(client, /pending\.fail\(id, undefined, LOST\)/);
  // LOST, not OFFLINE: the request may have reached the host, so a prompt is not dropped as unsent.
  assert.match(client, /\n {2}\/\/ forwarded it\), so it would wait out its 20 s timeout\./);
  assert.doesNotMatch(client, /pending\.fail\(id, undefined, OFFLINE\)/);
  // The reconnect path is untouched: offline drops the cached host.hello, so it is asked again when
  // it is back, and the card's useLoad reloads on that same offline→online edge.
  assert.match(client, /if \(!d\.online\) \{ helloed\.delete\(d\.id\); forgetCapabilities\(d\.id\); \}/);
  assert.match(client, /onlineHosts\.clear\(\);/);
});

test('the hub reloads its status when the computer comes back online', () => {
  const card = readFileSync(new URL('../src/ui/hub/HostUpdate.tsx', import.meta.url), 'utf8');
  // useLoad (ui/hub/common.tsx) reloads on the offline→online edge through useReloadOnReconnect, so
  // once the restarted computer is back the card reads the version it restarted into.
  assert.match(card, /useLoad<HostUpdateStatus>\(served \? load : null, `\$\{device\}:host\.update`\)/);
  const common = readFileSync(new URL('../src/ui/hub/common.tsx', import.meta.url), 'utf8');
  assert.match(common, /useReloadOnReconnect\(device, run\);/);
});
