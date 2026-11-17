import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  CompanionError, CompanionLifetime, negotiateCompanion,
  type CompanionManifest, type CompanionProfile, type CompanionResources, type InstalledCompanionApi, type StopReason,
} from '../src/extensions/runtime-companion-lifetime';

// Node/preview column only. No browser, installed service or real harness is exercised by this spec.
const directory = new URL('./fixtures/extensions/runtime-companion-lifetime/', import.meta.url);
const scenario: {
  evidence: string; profile: CompanionProfile; installed: InstalledCompanionApi;
  negotiation: { installed: InstalledCompanionApi; noProfile?: boolean; state: string }[]; stopReasons: StopReason[];
} = JSON.parse(readFileSync(new URL('scenarios.json', directory), 'utf8'));
const companionSource = readFileSync(new URL('companion.cjs', directory), 'utf8');
const harness = fileURLToPath(new URL('fake-harness.cjs', directory));
interface FixtureResources extends CompanionResources {
  directory: string; descriptor: string; closes: number;
  attach(child: ChildProcessWithoutNullStreams): void;
  failNextClose(): void;
}
const prepare = createRequire(import.meta.url)(fileURLToPath(new URL('resources.cjs', directory))) as
  (root: string, manifest: CompanionManifest, source: string) => FixtureResources;
const key = (runId: string, taskId = 'task-a') => ({ taskId, runId });
function refuses(action: () => unknown, code: CompanionError['code']) {
  try { action(); throw new Error(`Expected ${code}`); }
  catch (error) { expect(error).toBeInstanceOf(CompanionError); expect((error as CompanionError).code).toBe(code); }
}

function fake(env: Record<string, string>, taskId: string, runId: string) {
  const childEnv = { ...process.env };
  // An inherited descriptor must never accidentally make an uninjected child a companion run.
  delete childEnv.PANDACODE_COMPANION_MANIFEST;
  const child = spawn(process.execPath, [harness, taskId, runId], { env: { ...childEnv, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const frames: Record<string, unknown>[] = [];
  type Waiter = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  const waiting: Waiter[] = [];
  let ended = false;
  child.once('close', () => { ended = true; for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('Fixture exited before frame.')); } });
  child.on('error', error => { for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } });
  // Drain stderr; assertions use the structured frames rather than logging paths or process environments.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const value = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiting.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(value); } else frames.push(value);
  });
  const next = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const value = frames.shift(); if (value) { resolve(value); return; }
    if (ended) { reject(new Error('Fixture already exited.')); return; }
    const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
      const index = waiting.indexOf(waiter); if (index >= 0) waiting.splice(index, 1);
      reject(new Error('Fixture frame timed out.'));
    }, 5000) };
    waiting.push(waiter);
  });
  return { child, exit, next, async stop() { if (!child.stdin.destroyed) child.stdin.end(); await exit; lines.close(); } };
}

test('extensions companion lifetime: exact version/API failures retain ordinary approval coverage', () => {
  expect(scenario.evidence).toBe('synthetic');
  for (const row of scenario.negotiation) {
    const result = negotiateCompanion(row.installed, row.noProfile ? null : scenario.profile);
    expect(result.state).toBe(row.state); expect(result.ordinaryApprovals).toBe('unchanged');
    if (row.state === 'unsupported') { expect(result.code).toBe('UnsupportedCapability'); expect(result.reason).toBeTruthy(); }
  }
  expect(negotiateCompanion(scenario.installed, { ...scenario.profile, protocol: 2 }).code).toBe('UnsupportedCapability');
  const lifetime = new CompanionLifetime('host-one'); const before = lifetime.report().revision;
  refuses(() => lifetime.begin(key('r1'), ['sample.guard'], { ...scenario.installed, apis: [] }, scenario.profile, () => { throw new Error('Must not prepare unsupported API'); }), 'UnsupportedCapability');
  expect(lifetime.report().revision).toBeGreaterThan(before);
  expect(lifetime.capability('fixture')).toMatchObject({ code: 'UnsupportedCapability', ordinaryApprovals: 'unchanged' });
});

test('extensions companion lifetime: one intended process loads once and both config files remain byte identical', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pandacode-companion-fixture-'));
  const lifetime = new CompanionLifetime('host-one'); const children: ReturnType<typeof fake>[] = [];
  try {
    mkdirSync(join(root, 'user')); mkdirSync(join(root, 'project')); mkdirSync(join(root, 'runs'));
    const user = join(root, 'user', 'config.json'); const project = join(root, 'project', 'config.json');
    const original = Buffer.from('{\r\n  "plugins": ["keep-user-plugin"], "theme": "unchanged"\r\n}\r\n');
    writeFileSync(user, original); writeFileSync(project, original);
    let resource!: FixtureResources;
    const launch = lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, manifest => resource = prepare(join(root, 'runs'), manifest, companionSource));
    refuses(() => lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, () => { throw new Error('Must not create twice'); }), 'Conflict');
    const intended = fake(launch.env, 'task-a', 'r1'); children.push(intended); resource.attach(intended.child);
    expect(await intended.next()).toEqual({ type: 'ready', loaded: 1, ordinaryApprovals: true });
    intended.child.stdin.write('probe\n'); expect(await intended.next()).toMatchObject({ loaded: 1, current: true });
    intended.child.stdin.write('probe\n'); expect(await intended.next()).toMatchObject({ loaded: 1, current: true });
    for (const [env, taskId, runId] of [[{}, 'task-a', 'r2'], [launch.env, 'task-a', 'r2'], [launch.env, 'task-b', 'r1']] as const) {
      const other = fake(env, taskId, runId); children.push(other);
      expect(await other.next()).toEqual({ type: 'ready', loaded: 0, ordinaryApprovals: true }); await other.stop();
    }
    lifetime.end(key('r1')); expect(lifetime.current(key('r1'), launch.lease)).toBe(false);
    expect(existsSync(resource.descriptor)).toBe(false); expect(lifetime.report().cleanupPending).toBe(1);
    expect(await intended.next()).toEqual({ type: 'closed', handlers: 0 }); await intended.exit;
    lifetime.retryCleanup(); expect(existsSync(resource.directory)).toBe(false); expect(lifetime.report().cleanupPending).toBe(0);
    const stale = fake(launch.env, 'task-a', 'r1'); children.push(stale);
    expect(await stale.next()).toMatchObject({ loaded: 0, ordinaryApprovals: true }); await stale.stop();
    expect(readFileSync(user)).toEqual(original); expect(readFileSync(project)).toEqual(original);
    const report = JSON.stringify(lifetime.report()); expect(report).not.toContain(launch.lease.leaseId); expect(report).not.toContain(root);
  } finally {
    lifetime.stop(); await Promise.all(children.map(child => child.stop())); lifetime.retryCleanup();
    // Every path here was created by this test under this exact fresh root.
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of scenario.stopReasons) {
  test(`extensions companion lifetime: ${reason} withdraws injection and drains its process`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pandacode-companion-fixture-'));
    const lifetime = new CompanionLifetime('host-one'); let processRun: ReturnType<typeof fake> | undefined;
    try {
      let resource!: FixtureResources;
      const launch = lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, manifest => resource = prepare(root, manifest, companionSource));
      processRun = fake(launch.env, 'task-a', 'r1'); resource.attach(processRun.child);
      expect(await processRun.next()).toMatchObject({ loaded: 1 });
      const revision = lifetime.report().revision;
      if (reason === 'runEnded') lifetime.end(key('r1'));
      else if (reason === 'safeMode') lifetime.setSafeMode(true);
      else if (reason === 'hostShutdown') lifetime.stop();
      else lifetime.endOwner('sample.guard', reason);
      expect(lifetime.report().revision).toBeGreaterThan(revision);
      expect(lifetime.current(key('r1'), launch.lease)).toBe(false);
      refuses(() => lifetime.injection(launch.lease), 'StaleContext');
      expect(existsSync(resource.descriptor)).toBe(false);
      expect(await processRun.next()).toEqual({ type: 'closed', handlers: 0 }); await processRun.exit;
      lifetime.retryCleanup(); expect(existsSync(resource.directory)).toBe(false); expect(resource.closes).toBe(1);
      resource.close(); expect(resource.closes).toBe(1);
      lifetime.end(key('r1')); expect(resource.closes).toBe(1);
      lifetime.setSafeMode(false);
      refuses(() => lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, () => resource), reason === 'hostShutdown' ? 'HostUnavailable' : 'Conflict');
    } finally { lifetime.stop(); if (processRun) await processRun.stop(); lifetime.retryCleanup(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('extensions companion lifetime: cross-host identities, early cancellation, cleanup failures and independent owners', () => {
  const one = new CompanionLifetime('one'); const two = new CompanionLifetime('two');
  let fail = true; let closed = 0;
  const create = () => ({ env: {}, close() { if (fail) { fail = false; throw new Error('synthetic'); } closed++; } });
  const first = one.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, create);
  const second = two.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, () => ({ env: {}, close() {} }));
  const independent = one.begin(key('r2'), ['sample.other'], scenario.installed, scenario.profile, () => ({ env: {}, close() {} }));
  expect(two.current(key('r1'), first.lease)).toBe(false); expect(one.current(key('r2'), first.lease)).toBe(false);
  expect(first.lease.leaseId).not.toBe(second.lease.leaseId);
  one.endOwner('sample.guard', 'revoked'); expect(one.report().cleanupPending).toBe(1);
  expect(one.current(key('r2'), independent.lease)).toBe(true); expect(one.current(key('r1'), first.lease)).toBe(false);
  one.retryCleanup(); expect(closed).toBe(1); expect(one.report().cleanupPending).toBe(0);
  one.end(key('late')); refuses(() => one.begin(key('late'), ['sample.guard'], scenario.installed, scenario.profile, create), 'Conflict');
  one.stop(); two.stop();
});

test('extensions companion lifetime: preparation failure admits nothing and retries with a fresh identity', () => {
  const lifetime = new CompanionLifetime('host-one'); const attempted: string[] = [];
  refuses(() => lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, manifest => {
    attempted.push(manifest.leaseId); throw new Error('Synthetic factory failure after its own rollback.');
  }), 'HostUnavailable');
  expect(lifetime.report().activeRuns).toBe(0);
  const launch = lifetime.begin(key('r1'), ['sample.guard'], scenario.installed, scenario.profile, manifest => {
    attempted.push(manifest.leaseId); return { env: {}, close() {} };
  });
  expect(new Set(attempted).size).toBe(2); expect(lifetime.current(key('r1'), launch.lease)).toBe(true);
  lifetime.end(key('r1'));
  expect(lifetime.capability('fixture')).toMatchObject({ state: 'ended', reason: 'runEnded', ordinaryApprovals: 'unchanged' });
});
