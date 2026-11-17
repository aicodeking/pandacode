import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
// Preview column of R0501 (hook fixtures and the provenance of recorded frames). The browser preview starts no
// process, so this spec runs in the test runner's Node: it checks the provenance ledger
// (tests/fixtures/extensions/runtime-hook-fixtures/provenance.json) and drives the canonical Node fake agent
// (tests/fixtures/extensions/backends/fake-agent.mjs, B5) over real stdio with the scripted hook scenarios. The same
// scenarios through PandaCode's declared ACP transport on Windows are the native test
// `runtime_hook_fixtures::tests::windows_transport` (feature extension-runtime-native-tests). No real harness runs here.
const repo = new URL('../', import.meta.url);
const fixtures = new URL('./fixtures/extensions/runtime-hook-fixtures/', import.meta.url);
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const ledger = JSON.parse(readFileSync(new URL('provenance.json', fixtures), 'utf8'));
const scenarios = JSON.parse(readFileSync(new URL('synthetic/scenarios.json', fixtures), 'utf8'));
const FIXTURE_DIR = 'tests/fixtures/extensions/runtime-hook-fixtures/';
const LIVE_DIR = `${FIXTURE_DIR}live/`;
const KINDS = ['harness-capture', 'sdk-derived', 'synthetic'];

type Frame = Record<string, any>;
const jsonl = (text: string): Frame[] => text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
const header = (location: string, text: string) => location.endsWith('.jsonl') ? jsonl(text)[0]?._fixture : JSON.parse(text)._fixture;
const read = (location: string) => readFileSync(new URL(location, repo), 'utf8');
const prompt = (id: string) => scenarios.scenarios.find((scenario: any) => scenario.id === id).prompt as string;
const loose = (frame: Frame) => { const rest: Frame = { ...frame }; delete rest.id; return { ...rest, params: { ...rest.params, sessionId: '<session>' } }; };

test('extensions hook fixtures: every recorded input keeps its provenance and the Claude callback gate stays pending', () => {
  expect(ledger.schema).toBe(1);
  expect(Object.keys(ledger.kinds).sort()).toEqual([...KINDS].sort());
  const seen = new Set<string>();
  for (const input of ledger.inputs) {
    expect(KINDS, input.id).toContain(input.provenance);
    seen.add(input.provenance);
    expect(existsSync(new URL(input.location, repo)), input.location).toBe(true);
    const text = read(input.location);
    if (input.location.startsWith(FIXTURE_DIR)) {
      const own = header(input.location, text);
      expect(own?.provenance, `${input.id}: the file's own header names the same kind`).toBe(input.provenance);
      expect(own?.liveCapture, `${input.id}: only an authorized live capture says liveCapture`).toBe(input.provenance === 'harness-capture' && input.capture?.form === 'live');
    }
    if (input.location.startsWith(LIVE_DIR)) expect(input.capture?.form, input.id).toBe('live');
    if (input.provenance === 'harness-capture') {
      expect(['live', 'transcribed'], input.id).toContain(input.capture?.form);
      if (input.capture.form === 'transcribed') {
        expect(input.location.startsWith(FIXTURE_DIR), 'a transcription points at its existing recording').toBe(false);
        expect(text).toContain(input.marker);
        expect(input.capture.origin).toBeTruthy();
      } else {
        expect(input.capture.authorization, 'a live capture names the user authorization').toBeTruthy();
      }
    } else {
      expect(input.capture, `${input.id}: a ${input.provenance} input carries no capture details`).toBeUndefined();
      expect(input.source).toBeTruthy();
    }
  }
  expect([...seen].sort(), 'all three kinds are recorded and told apart').toEqual([...KINDS].sort());
  // Nothing was captured live in this task: live/ holds only its README.
  expect(readdirSync(new URL(LIVE_DIR, repo)).filter(name => name !== 'README.md')).toEqual([]);
  const gate = ledger.gates.find((entry: any) => entry.id === 'claude-hook-callback-capture');
  expect(gate).toMatchObject({ harness: 'claude-code', status: 'pending', authorization: null, requires: ['initialize.hooks', 'hook_callback'] });
  expect(gate.alsoBlocks).toEqual(['glm', 'mimo']);
  expect(gate.reason).toMatch(/authorization/);
  const [doc, anchor] = gate.procedure.split('#');
  expect(read(doc)).toContain('## Claude hook-callback capture gate');
  expect(anchor).toBe('claude-hook-callback-capture-gate');
});

test('extensions hook fixtures: SDK-derived Claude frames carry the callback shape yet are never a live capture', () => {
  const sdk = ledger.inputs.find((input: any) => input.id === 'claude-sdk-hook-callback');
  const frames = jsonl(read(sdk.location));
  expect(frames[0]._fixture).toMatchObject({ provenance: 'sdk-derived', liveCapture: false, harness: 'claude-code' });
  const initialize = frames.find(frame => frame.type === 'control_request' && frame.request?.subtype === 'initialize');
  const registered = Object.values(initialize!.request.hooks as Record<string, any[]>).flat().flatMap(matcher => matcher.hookCallbackIds);
  const callback = frames.find(frame => frame.type === 'control_request' && frame.request?.subtype === 'hook_callback');
  expect(registered).toContain(callback!.request.callback_id);
  expect(frames.some(frame => frame.type === 'control_response' && frame.response.request_id === callback!.request_id)).toBe(true);
  // The shape is complete, and still the gate is pending: provenance, not shape, decides qualification.
  expect(ledger.gates[0].status).toBe('pending');
});

function queue() {
  const values: Frame[] = []; const all: Frame[] = []; const waiting: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  return {
    values, all,
    push(frame: Frame) {
      all.push(frame);
      const at = waiting.findIndex(item => item.match(frame));
      if (at < 0) values.push(frame); else waiting.splice(at, 1)[0].resolve(frame);
    },
    next(match: (frame: Frame) => boolean, ms = 10_000): Promise<Frame> {
      const at = values.findIndex(match);
      if (at >= 0) return Promise.resolve(values.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const item = { match, resolve: (frame: Frame) => { clearTimeout(timer); resolve(frame); } };
        const timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('fake agent frame timeout')); }, ms);
        waiting.push(item);
      });
    },
  };
}

test('extensions hook fixtures: the fake agent scripts approval, denial, a structured question, a cancelled tool and a late answer over real stdio', async () => {
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  const out = queue();
  try {
    const ready = await new Promise<any>((resolve, reject) => { createInterface({ input: child.stderr }).once('line', line => resolve(JSON.parse(line))); child.once('error', reject); });
    expect(ready).toMatchObject({ ready: true, transport: 'stdio-acp' });
    createInterface({ input: child.stdout }).on('line', line => out.push(JSON.parse(line)));
    const send = (frame: Frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    expect((await out.next(frame => frame.id === 1)).result.protocolVersion).toBe(1);
    send({ id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } });
    const sessionId = (await out.next(frame => frame.id === 2)).result.sessionId;
    const run = (id: number, text: string) => send({ id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });
    const said = (text: string) => out.next(frame => frame.method === 'session/update' && frame.params.update.content?.text === text);
    const permission = () => out.next(frame => frame.method === 'session/request_permission');
    const answer = (id: unknown, outcome: Frame) => send({ id, result: { outcome } });
    const recorded = jsonl(read(`${FIXTURE_DIR}synthetic/fake-agent-acp.jsonl`));
    expect(recorded[0]._fixture).toMatchObject({ provenance: 'synthetic', liveCapture: false });

    // Approval: the recorded synthetic request matches a fresh run, and allow runs the tool.
    run(10, prompt('approval-allow'));
    const allow = await permission();
    expect(loose(allow)).toEqual(loose(recorded[1]));
    answer(allow.id, { outcome: 'selected', optionId: 'allow' });
    await said('ran: {"command":"echo fixture"}'); await said('after-allow');
    expect((await out.next(frame => frame.id === 10)).result.stopReason).toBe('end_turn');

    // Denial: the tool fails and the agent says no reason was supplied (standard ACP carries none).
    run(11, prompt('approval-deny'));
    const deny = await permission();
    answer(deny.id, { outcome: 'selected', optionId: 'deny' });
    expect((await out.next(frame => frame.params?.update?.sessionUpdate === 'tool_call_update' && frame.params.update.status === 'failed')).params.update.title).toBe('Bash');
    await said('denied: permission rejected (ACP supplied no reason)');
    expect((await out.next(frame => frame.id === 11)).result.stopReason).toBe('end_turn');

    // Structured question: answer options, not a tool approval; a chosen answer and a cancelled one.
    run(12, prompt('structured-question'));
    const question = await permission();
    expect(loose(question)).toEqual(loose(recorded[2]));
    answer(question.id, { outcome: 'selected', optionId: 'q0_opt_1' });
    await said('answer: SQLite'); await said('after-question');
    expect((await out.next(frame => frame.id === 12)).result.stopReason).toBe('end_turn');
    run(13, prompt('structured-question'));
    answer((await permission()).id, { outcome: 'cancelled' });
    await said('answer: {"cancelled":true}');
    expect((await out.next(frame => frame.id === 13)).result.stopReason).toBe('end_turn');

    // A tool cancelled while it waits for approval, then the late answer to that request.
    run(14, prompt('cancel-pending-tool'));
    const pending = await permission();
    send({ method: 'session/cancel', params: { sessionId } });
    expect((await out.next(frame => frame.id === 14)).result.stopReason).toBe('cancelled');
    const before = out.all.length;
    answer(pending.id, { outcome: 'selected', optionId: 'allow' });
    // The late answer is not applied (no tool runs, no turn resumes) and not answered (no error frame back).
    run(15, '#reply settled');
    await said('settled');
    expect((await out.next(frame => frame.id === 15)).result.stopReason).toBe('end_turn');
    expect(out.all.slice(before).some(frame => frame.id === pending.id || frame.params?.update?.content?.text === 'never-after-cancel')).toBe(false);
    const log = await (await fetch(`${ready.control}/control/log`)).json();
    expect(log.some((entry: any) => entry.late === pending.id), 'the late answer is recorded as late').toBe(true);

    // A late duplicate answer after an approval was already applied is ignored the same way.
    run(16, prompt('late-answer'));
    const first = await permission();
    answer(first.id, { outcome: 'selected', optionId: 'allow' });
    await said('ran: {"path":"fixture"}');
    answer(first.id, { outcome: 'selected', optionId: 'deny' });
    await said('after-late');
    expect((await out.next(frame => frame.id === 16)).result.stopReason).toBe('end_turn');
    const after = await (await fetch(`${ready.control}/control/log`)).json();
    expect(after.filter((entry: any) => entry.late === first.id)).toHaveLength(1);
    expect(out.all.every(frame => frame.jsonrpc === '2.0'), 'stdout carries ACP JSON-RPC only').toBe(true);
  } finally {
    child.stdin.end();
    expect(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])).toBe(0);
  }
});
