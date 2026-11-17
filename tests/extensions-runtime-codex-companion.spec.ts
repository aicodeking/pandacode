import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CompanionLifetime } from '../src/extensions/runtime-companion-lifetime';
import { CodexCompanion, codexProfile, CODEX_EVENTS, codexCommand, codexReply } from '../src/extensions/runtime-codex-companion';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-codex-companion/inventory.json', import.meta.url), 'utf8'));
function setup() {
  const host = new CompanionLifetime('codex-fixture'); const installed = { harness: 'codex', version: codexProfile.versions[0]!, apis: [codexProfile.api] };
  const key = { taskId: 'task', runId: 'run' };
  const launch = host.begin(key, ['guard'], installed, codexProfile, () => ({ env: {}, close() {} }));
  return { host, key, session: new CodexCompanion(host, launch.lease, installed, '/fixture', 'node forward.mjs') };
}
test('extensions codex companion: declarations inventory targeted trust and fresh resume', () => {
  expect(fixture.provenance).toBe('synthetic'); expect(fixture.liveCapture).toBe(false);
  const { session } = setup(); const declarations = session.declarations();
  expect(declarations['features.hooks']).toBe(true);
  for (const event of CODEX_EVENTS) expect(declarations[`hooks.${event}`]).toBeTruthy();
  const inventory = session.inventory(); expect(inventory.method).toBe('hooks/list');
  session.acceptInventory(inventory.id, fixture.result);
  const start = session.thread(undefined, { model_reasoning_effort: 'high' });
  expect(start.method).toBe('thread/start');
  const config = start.params.config;
  expect(config['hooks.state']).toEqual(Object.fromEntries(CODEX_EVENTS.map(event => [`session:${event}.0`, { enabled: true, trusted_hash: `hash-${event}` }])));
  expect(config.model_reasoning_effort).toBe('high');
  expect(JSON.stringify(config)).not.toContain('unrelated');
  expect(() => session.thread('resume')).toThrow('Inventory required');
  const next = session.inventory(); const changed = structuredClone(fixture.result);
  changed.data[0].hooks[0].currentHash = 'changed'; session.acceptInventory(next.id, changed);
  const resumed = session.thread('intended-thread');
  expect(resumed.params.threadId).toBe('intended-thread');
  expect((resumed.params.config['hooks.state'] as Record<string, unknown>)['session:PreToolUse.0']).toEqual({ enabled: true, trusted_hash: 'changed' });
});
test('extensions codex companion: stale inventory ambiguous matches and withdrawn lease fail closed', () => {
  const { host, key, session } = setup(); const old = session.inventory(); const current = session.inventory();
  expect(() => session.acceptInventory(old.id, fixture.result)).toThrow('StaleContext');
  const ambiguous = structuredClone(fixture.result); ambiguous.data[0].hooks.push(ambiguous.data[0].hooks[0]);
  expect(() => session.acceptInventory(current.id, ambiguous)).toThrow('ambiguous');
  expect(() => session.thread()).toThrow('Inventory required');
  host.end(key, 'revoked'); expect(() => session.inventory()).toThrow('StaleContext');
});
test('extensions codex companion: approval powers and Windows quoting are explicit', () => {
  expect(codexReply('PreToolUse', { decision: 'approve' })).toEqual({});
  expect(codexReply('PreToolUse', { decision: 'rewrite', input: { command: 'new' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'new' } } });
  expect(codexReply('PermissionRequest', { decision: 'approve' })).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
  expect(codexReply('PermissionRequest', { decision: 'deny', reason: 'guard' })).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny', message: 'guard' } } });
  expect(codexReply('PermissionRequest', { decision: 'rewrite', input: {} })).toEqual({});
  expect(codexCommand('C:\\Program Files\\node.exe', 'C:\\run\\forward.mjs', 'cmd')).toBe('"C:\\Program Files\\node.exe" "C:\\run\\forward.mjs"');
  expect(() => codexCommand('C:\\%TEMP%\\node.exe', 'x', 'cmd')).toThrow('Unsupported Windows');
});
test('extensions codex companion: shipped forwarder preserves ordinary approval on disconnect and deadline', async ({}, testInfo) => {
  const source = readFileSync('src-tauri/src/extensions/runtime_codex_companion.rs', 'utf8');
  const script = source.match(/pub const FORWARDER: &str = r#"([\s\S]*?)"#;/)![1]!;
  // Only an owned loopback fixture and a synthetic descriptor; never an installed harness.
  let disconnect = false; let calls = 0;
  const server = createServer((request, response) => {
    calls++; expect(request.headers.authorization).toBe('Bearer fixture-canary');
    if (disconnect) response.destroy();
    // Otherwise deliberately leave the request pending to exercise the shipped deadline.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener');
  const descriptor = testInfo.outputPath('run.json');
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ taskId: 'task', runId: 'run', leaseId: 'fixture' }));
  const run = (endpoint: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { windowsHide: true,
      env: { ...process.env, PANDACODE_COMPANION_ENDPOINT: endpoint, PANDACODE_COMPANION_CREDENTIAL: 'fixture-canary', PANDACODE_COMPANION_MANIFEST: descriptor }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`forwarder exit ${code}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest' }));
  });
  try {
    expect(JSON.parse(await run(`http://127.0.0.1:${address.port}/companion`))).toEqual({});
    disconnect = true;
    expect(JSON.parse(await run(`http://127.0.0.1:${address.port}/companion`))).toEqual({});
    expect(calls).toBe(2);
  }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
