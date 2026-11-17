import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import {
  beginRun, declared, forgetState, overlayReadiness, permissionChoice, recordHandshake, resolveLaunch, snapshotState,
  stateCount, updateEvents, CHUNK, type Json,
} from '../src/extensions/runtime-provider-launch';
// Preview column of R0801 (declared ACP harnesses). The browser preview starts no process: these check the webview twin
// (src/extensions/runtime-provider-launch.ts) of the native rules against the fixture manifest, and run the reusable Node
// fake agent (tests/fixtures/extensions/backends/fake-agent.mjs, backed by the adopted B5 state machine) over real stdio.
// The installed package launching that agent through the native declared-harness path is the native test
// `runtime_provider_launch::tests::installed` (feature extension-runtime-native-tests).
const fixture = new URL('./fixtures/extensions/runtime-provider-launch/', import.meta.url);
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('extension.json', fixture), 'utf8'));
const OWNER = 'sample.launch-agent';
const provider = manifest.contributes.providers[0];
const places = { node: process.execPath, data: '/data/sample' };

const packages = (overrides: (value: any) => void = () => {}) => {
  const copy = structuredClone(manifest); overrides(copy);
  return validateContract('packages', [copy]);
};

test('provider launch: a launch provider with an empty model list is a valid package that needs no handler or runtime', () => {
  const checked = packages();
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(provider.models).toEqual([]);
  expect(manifest.runtime).toBeUndefined();
  // Both alternatives stay closed: a handler provider keeps its catalog, a launch provider has no activation event.
  expect(packages(value => { delete value.contributes.providers[0].launch; }).ok, 'no launch and no models').toBe(false);
  expect(packages(value => { value.runtime = { kind: 'node', entrypoint: 'main.cjs', activationEvents: [value.contributes.providers[0].id] }; }).ok, 'launch is not an executable activation').toBe(false);
  for (const launch of [
    { protocol: 'mcp', command: ['x'] }, { protocol: 'acp', command: [] }, { protocol: 'acp', command: ['{node}', '{nope}'] },
    { protocol: 'acp', command: ['x'], env: { A: 1 } }, { protocol: 'acp', command: ['x'], extra: true }, { command: ['x'] },
  ]) expect(packages(value => { value.contributes.providers[0].launch = launch; }).ok, JSON.stringify(launch)).toBe(false);
});

test('provider launch: placeholders resolve and a missing protocol, executable or placeholder is an explicit readiness error', () => {
  const launch = declared(provider as Json)!;
  const resolved = resolveLaunch(launch, places, () => true);
  expect(resolved.program).toBe(process.execPath);
  expect(resolved.arguments).toEqual(['__FAKE_AGENT__']);
  expect(resolved.env).toEqual({ FAKE_AGENT_LOG: '/data/sample/frames.log' });
  expect(() => resolveLaunch(launch, {}, () => true)).toThrow(/^UnsupportedRuntime/);
  expect(() => resolveLaunch({ protocol: 'acp', command: ['{node}', '{package}/agent.mjs'] }, places)).toThrow(/runtime\.files/);
  expect(() => resolveLaunch({ protocol: 'mcp', command: ['x'] }, places)).toThrow(/^UnsupportedCapability/);
  expect(() => resolveLaunch({ command: ['x'] }, places)).toThrow(/^InvalidShape/);
  expect(() => resolveLaunch(launch, places, () => false)).toThrow(/^ExecutableMissing/);

  forgetState(OWNER);
  const metadata = provider.metadata;
  expect(overlayReadiness(OWNER, provider, metadata, places, () => false)).toMatchObject({ readiness: { state: 'unavailable', reason: expect.stringMatching(/^ExecutableMissing/) } });
  expect(overlayReadiness(OWNER, provider, metadata, places, () => false).readiness).toMatchObject({ state: 'unavailable' });
  expect(overlayReadiness(OWNER, provider, metadata, places, () => true)).toEqual(metadata);
  const signedOut = { ...metadata, readiness: { state: 'signedOut', reason: 'Sign in.' } };
  expect(overlayReadiness(OWNER, provider, signedOut, places, () => true)).toEqual(signedOut);
  expect(snapshotState(OWNER).readiness, 'consecutive duplicates collapse').toEqual(['unavailable', 'ready', 'signedOut']);
  forgetState(OWNER);
});

test('provider launch: concurrent conversations share one package state and one token manager', () => {
  forgetState(OWNER);
  const first = beginRun(OWNER); recordHandshake(OWNER);
  const second = beginRun(OWNER); recordHandshake(OWNER);
  expect(second.token).not.toBe(first.token);
  expect(stateCount(OWNER)).toBe(1);
  expect(snapshotState(OWNER)).toMatchObject({ tokensIssued: 2, handshakes: 2, active: 2, peak: 2 });
  first.end(); first.end(); second.end();
  expect(snapshotState(OWNER)).toMatchObject({ active: 0, peak: 2, finished: 2, tokensIssued: 2 });
  forgetState(OWNER);
});

test('provider launch: ACP updates become bounded core events and permission answers pick the matching option', () => {
  const long = 'x'.repeat(CHUNK * 2 + 5);
  const texts = updateEvents({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: long } });
  expect(texts).toHaveLength(3);
  expect(texts.every(event => event.kind === 'text' && event.text.length <= CHUNK)).toBe(true);
  expect(updateEvents({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hm' } })).toEqual([{ kind: 'thinking', text: 'hm' }]);
  expect(updateEvents({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Bash', status: 'completed', rawInput: { command: 'x' }, content: [{ content: { text: 'out' } }] }))
    .toEqual([{ kind: 'tool', tool: { id: 't1', name: 'Bash', status: 'completed', input: '{"command":"x"}', output: 'out' } }]);
  expect(updateEvents({ sessionUpdate: 'usage_update', used: 64, size: 128 })).toEqual([{ kind: 'usage', usedTokens: 64, contextWindow: 128 }]);
  expect(updateEvents({ sessionUpdate: 'plan' })).toEqual([]);
  const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }];
  expect(permissionChoice(options, true)).toMatchObject({ optionId: 'a' });
  expect(permissionChoice(options, false)).toMatchObject({ optionId: 'r' });
  expect(permissionChoice([], true)).toBeNull();
});

test('provider launch: the Node fake agent entry speaks ACP only on stdout over real stdio and stops on stdin EOF', async () => {
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  try {
    const ready = await new Promise<any>((resolve, reject) => {
      const lines = createInterface({ input: child.stderr });
      lines.once('line', line => resolve(JSON.parse(line))); child.once('error', reject);
    });
    expect(ready).toMatchObject({ ready: true, transport: 'stdio-acp' });
    const frames = createInterface({ input: child.stdout });
    const received: any[] = []; const waiting = new Map<number, (frame: any) => void>();
    frames.on('line', line => { const frame = JSON.parse(line); received.push(frame); waiting.get(frame.id)?.(frame); });
    const call = (id: number, method: string, params: unknown) => new Promise<any>(resolve => { waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    expect((await call(1, 'initialize', { protocolVersion: 1 })).result.protocolVersion).toBe(1);
    const session = (await call(2, 'session/new', { cwd: '.', mcpServers: [] })).result.sessionId;
    expect(session).toBeTruthy();
    const done = await call(3, 'session/prompt', { sessionId: session, prompt: [{ type: 'text', text: 'hello launch' }] });
    expect(done.result.stopReason).toBe('end_turn');
    expect(received.some(frame => frame.method === 'session/update' && frame.params.update.content?.text === 'echo: hello launch')).toBe(true);
    expect(received.every(frame => frame.jsonrpc === '2.0'), 'stdout carries ACP JSON-RPC only').toBe(true);
  } finally {
    child.stdin.end();
    expect(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])).toBe(0);
  }
});
