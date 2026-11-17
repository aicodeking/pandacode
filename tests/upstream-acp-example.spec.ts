import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { declared, permissionChoice, resolveLaunch, updateEvents, type Json } from '../src/extensions/runtime-provider-launch';
// S07A: the installable `sample.upstream-acp` author package (a declared ACP launch, no code) exercised against the
// reusable B5-backed Node fake agent over real stdio. No second protocol state machine: the agent is
// tests/fixtures/extensions/backends/fake-agent.mjs. The browser preview starts no package process; the host rules
// (placeholders, readiness, event translation, permission choice) are the preview twin of R0801.
// The gaps this example found are recorded in docs/extensions/examples/upstream-acp.md (G1-G8) for S07C.
const manifest = JSON.parse(readFileSync(new URL('../examples/extensions/upstream-acp/package/extension.json', import.meta.url), 'utf8'));
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const provider = manifest.contributes.providers[0];
const places = { node: process.execPath, data: '/data/sample' };
// The manifest's `__FAKE_AGENT__` stands for the real fake agent path, exactly as in the R0801 fixture.
const withAgent = (launch: any) => ({ ...launch, command: launch.command.map((part: string) => (part === '__FAKE_AGENT__' ? agentPath : part)) });

type Frame = any;
async function agent() {
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  await new Promise<void>((resolve, reject) => { createInterface({ input: child.stderr }).once('line', () => resolve()); child.once('error', reject); });
  const received: Frame[] = []; const waiting = new Map<number, (frame: Frame) => void>(); let serial = 0;
  createInterface({ input: child.stdout }).on('line', line => { const frame = JSON.parse(line); received.push(frame); if (frame.id !== undefined && !frame.method) waiting.get(frame.id)?.(frame); });
  const send = (value: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const call = (method: string, params: unknown) => { const id = ++serial; return new Promise<Frame>(resolve => { waiting.set(id, resolve); send({ id, method, params }); }); };
  const events = (sessionId: string) => received.filter(frame => frame.method === 'session/update' && frame.params.sessionId === sessionId).flatMap(frame => updateEvents(frame.params.update as Json));
  const close = async () => { child.stdin.end(); return Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))]); };
  const open = async () => { const init = await call('initialize', { protocolVersion: 1 }); const session = (await call('session/new', { cwd: '.', mcpServers: [] })).result.sessionId as string; return { init, session }; };
  return { call, send, received, events, close, open };
}
const prompt = (client: Awaited<ReturnType<typeof agent>>, sessionId: string, text: string) => client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

test('upstream acp example: the package validates as a launch provider with models, efforts and speed tiers, and holds no code', () => {
  const checked = validateContract('packages', [structuredClone(manifest)]);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(manifest.runtime).toBeUndefined();
  expect(provider.models.map((model: any) => model.id)).toEqual(['quick', 'deep']);
  expect(provider.models[1].speedTiers.map((tier: any) => tier.id)).toEqual(['standard', 'fast']);
  const broken = structuredClone(manifest); broken.runtime = { kind: 'node', entrypoint: 'main.cjs', activationEvents: [provider.id] };
  expect(validateContract('packages', [broken]).ok, 'a launch provider is not an executable activation').toBe(false);
});

test('upstream acp example: the launch resolves, and a missing executable or placeholder is an explicit readiness error', () => {
  const launch = declared(provider as Json)!;
  const resolved = resolveLaunch(withAgent(launch), places, () => true);
  expect(resolved.program).toBe(process.execPath);
  expect(resolved.arguments).toEqual([agentPath]);
  expect(resolved.env).toEqual({ FAKE_AGENT_LOG: '/data/sample/frames.log' });
  expect(() => resolveLaunch(withAgent(launch), places, () => false)).toThrow(/^ExecutableMissing/);
  expect(() => resolveLaunch(withAgent(launch), {}, () => true)).toThrow(/^UnsupportedRuntime/);
  // Gap G4: a script shipped inside the package needs runtime.files, which a runtime-free launch package does not have.
  expect(() => resolveLaunch({ protocol: 'acp', command: ['{node}', '{package}/agent.mjs'] }, places)).toThrow(/runtime\.files/);
});

test('upstream acp example: a conversation reaches the trace in order, a queued turn waits, and history keeps both turns', async () => {
  const client = await agent();
  try {
    const { init, session } = await client.open();
    expect(init.result.protocolVersion).toBe(1);
    const first = prompt(client, session, '#script [{"say":"one"},{"sleep":150},{"tool":{"name":"Bash","kind":"shell","input":{"command":"pwd"}},"output":"/tmp"}]');
    // The queue is the core's: a prompt sent while a turn runs is refused by the agent, so the host holds it and sends it afterwards.
    const early = await prompt(client, session, 'queued early');
    expect(early.error, 'concurrent prompts fail explicitly').toBeTruthy();
    expect((await first).result.stopReason).toBe('end_turn');
    expect((await prompt(client, session, 'queued turn')).result.stopReason).toBe('end_turn');
    const events = client.events(session);
    expect(events.filter(event => event.kind === 'text').map((event: any) => event.text)).toEqual(['one', 'ran: {"command":"pwd"}', 'echo: queued turn']);
    expect(events.some(event => event.kind === 'tool')).toBe(true);
    expect(client.received.every(frame => frame.jsonrpc === '2.0'), 'stdout carries ACP JSON-RPC only').toBe(true);
  } finally { expect(await client.close()).toBe(0); }
});

test('upstream acp example: permission answers pick the allow or reject option and the turn explains the outcome', async () => {
  const client = await agent();
  try {
    const { session } = await client.open();
    const script = '#script [{"tool":{"name":"Bash","kind":"shell","input":{"command":"ls"}},"ask":true}]';
    for (const approved of [true, false]) {
      const turn = prompt(client, session, script);
      const asked = await new Promise<Frame>(resolve => { const timer = setInterval(() => { const found = client.received.filter(frame => frame.method === 'session/request_permission').at(approved ? 0 : 1); if (found) { clearInterval(timer); resolve(found); } }, 20); });
      const choice = permissionChoice(asked.params.options as Json[], approved) as any;
      client.send({ id: asked.id, result: { outcome: { outcome: 'selected', optionId: choice.optionId } } });
      expect((await turn).result.stopReason).toBe('end_turn');
    }
    const texts = client.events(session).filter(event => event.kind === 'text').map((event: any) => event.text);
    expect(texts[0]).toBe('ran: {"command":"ls"}');
    expect(texts[1]).toMatch(/^denied:/);
  } finally { expect(await client.close()).toBe(0); }
});

test('upstream acp example: model selection is declared and not forwarded, resume is refused by the capability rule, steering is unavailable', async () => {
  const client = await agent();
  try {
    const { init, session } = await client.open();
    // Gap G2: the host resumes only when the agent advertises it; this agent advertises neither, so the host reports "cannot resume".
    const capabilities = init.result.agentCapabilities;
    expect(capabilities.sessionCapabilities.resume).toBeUndefined();
    expect(capabilities.loadSession).not.toBe(true);
    // Gap G1: nothing of the picker's model, effort, speed tier or mode is a frame the agent receives, only the prompt.
    expect((await prompt(client, session, '#reply picked')).result.stopReason).toBe('end_turn');
    expect(client.events(session)).toEqual([{ kind: 'text', text: 'picked' }]);
    const unknown = await client.call('session/set_model', { sessionId: session, modelId: 'deep' });
    expect(unknown.error, 'the agent has no model capability to forward to').toBeTruthy();
  } finally { expect(await client.close()).toBe(0); }
});

test('upstream acp example: cancel ends a running turn as cancelled and a scripted failure is an error that leaves the session usable', async () => {
  const client = await agent();
  try {
    const { session } = await client.open();
    const slow = prompt(client, session, '#script [{"say":"working"},{"sleep":30000}]');
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (client.events(session).length) { clearInterval(timer); resolve(); } }, 20); });
    client.send({ method: 'session/cancel', params: { sessionId: session } });
    expect((await slow).result.stopReason).toBe('cancelled');
    const failed = await prompt(client, session, '#script [{"fail":"boom"}]');
    expect(failed.error?.message).toMatch(/boom/);
    expect((await prompt(client, session, 'after the error')).result.stopReason).toBe('end_turn');
    expect(client.events(session).at(-1)).toEqual({ kind: 'text', text: 'echo: after the error' });
  } finally { expect(await client.close()).toBe(0); }
});
