import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateContract } from '../src/extensions/contracts.ts';
import { packageHarnesses } from '../src/extensions/harnesses.ts';
const require = createRequire(import.meta.url);
const { adapt, recording, recordedTransport, providers } = require('../examples/extensions/acp-recorded/package/main.cjs');
const manifest = JSON.parse(readFileSync('examples/extensions/acp-recorded/package/extension.json', 'utf8'));
const parity = JSON.parse(readFileSync('tests/fixtures/extensions/builtin-provider-parity.json', 'utf8'));
const run = { model: 'recorded', mode: 'ask', prompt: 'literal; $(not-a-shell)', instructions: 'Captured instructions' };
function harness(approved = false, mutate = () => {}) {
  const events = [], requests = [], responses = [];
  const recorded = recordedTransport();
  const transport = {
    async request(request, receive) {
      requests.push(request);
      const response = await recorded.request(request, receive && (async frame => { mutate(frame); await receive(frame); }));
      mutate(response);
      return response;
    },
    async respond(response) { responses.push(response); await recorded.respond(response); },
  };
  return { events, requests, responses, transport, core: {
    async emit(event) { events.push(event); },
    async nextInput() { return { kind: 'approval', approved }; },
  } };
}
test('ACP example: installable public package, constrained identity, zero/untrusted/safe-mode recovery', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.deepEqual(Object.keys(providers), [manifest.contributes.providers[0].id]);
  const snapshot = { safeMode: false, packages: [{ manifest, enabled: true, executable: { trusted: true }, icons: {} }] };
  assert.equal(packageHarnesses(snapshot)[0].id, 'sample.acp-recorded/acp');
  snapshot.packages[0].enabled = false;
  assert.deepEqual(packageHarnesses(snapshot), []);
  snapshot.packages[0].enabled = true;
  snapshot.packages[0].executable.trusted = false;
  assert.deepEqual(packageHarnesses(snapshot), []);
  snapshot.safeMode = true;
  assert.deepEqual(packageHarnesses(snapshot), []);
  assert.deepEqual(packageHarnesses({ safeMode: false, packages: [] }), []);
  const source = readFileSync('examples/extensions/acp-recorded/package/main.cjs', 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s|\bfetch\s*\(|child_process|tauri|sqlite/i);
  assert.match(readFileSync('src/types.ts', 'utf8'), /export type ProviderId = BuiltinProviderId \| ExtensionProviderId;/);
});
test('ACP example: all replay frames match existing native protocol characterization, not invented capabilities', () => {
  assert.deepEqual(recording, [0, 2, 5, 6, 7].map(index => parity.frames.acp[index]));
  assert.deepEqual(manifest.contributes.providers[0].metadata.modes, ['ask']);
  assert.equal(manifest.contributes.providers[0].metadata.teams, false);
  assert.equal(manifest.contributes.providers[0].metadata.usage.context, false);
});
for (const approved of [false, true]) for (const resumed of [false, true]) {
  test(`ACP example: ${resumed ? 'resume' : 'start'}, ${approved ? 'approve' : 'decline'} preserves protocol/core ownership`, async () => {
    const h = harness(approved);
    await adapt({ ...run, ...(resumed ? { resumeId: 'saved' } : {}) }, h.core, h.transport);
    assert.deepEqual(h.events, [{ kind: 'session', id: 'saved' }, { kind: 'text', text: 'Hello' }, { kind: 'approval', text: 'pwd' }]);
    assert.deepEqual(h.requests.map(request => request.method), ['initialize', resumed ? 'session/resume' : 'session/new', 'session/prompt']);
    assert.equal(h.requests[1].params.cwd, process.cwd());
    assert.deepEqual(h.requests[1].params.mcpServers, []);
    assert.deepEqual(h.requests[2].params.prompt, [{ type: 'text', text: `${run.instructions}\n\n${run.prompt}` }]);
    assert.deepEqual(h.responses, [{ jsonrpc: '2.0', id: 44, result: { outcome: { outcome: 'selected', optionId: approved ? 'allow' : 'deny' } } }]);
  });
}
test('ACP example: installed export uses only recording; unknown resume never starts fresh', async () => {
  const h = harness();
  await providers['sample.acp-recorded/acp'](run, h.core);
  assert.equal(h.events[0].id, 'saved');
  const unknown = harness();
  await assert.rejects(adapt({ ...run, resumeId: 'missing' }, unknown.core, unknown.transport), /Unknown recorded session/);
  assert.equal(unknown.events.length, 0);
  assert.equal(unknown.requests.some(request => request.method === 'session/new'), false);
});
test('ACP example: unsupported negotiation, requests, updates and permission choices fail closed', async () => {
  for (const [mutate, expected] of [
    [frame => { if (frame.id === 1) frame.result.protocolVersion = 2; }, /protocol version/],
    [frame => { if (frame.id === 1) delete frame.result.agentCapabilities.sessionCapabilities.resume; }, /ACP resume/],
    [frame => { if (frame.id === 2) frame.error = { code: -1 }; }, /session\/resume failed/],
    [frame => { if (frame.method) frame.params.sessionId = 'foreign'; }, /Foreign ACP session/],
    [frame => { if (frame.method === 'session/update') frame.params.update.sessionUpdate = 'usage_update'; }, /ACP update/],
    [frame => { if (frame.method === 'session/update') frame.method = 'fs/read_text_file'; }, /ACP request/],
    [frame => { if (frame.id === 44) frame.params.options[0].kind = 'allow_always'; }, /permission options/],
    [frame => { if (frame.id === 3) frame.result.stopReason = 'max_tokens'; }, /stop reason/],
  ]) {
    const h = harness(true, mutate);
    await assert.rejects(adapt({ ...run, resumeId: 'saved' }, h.core, h.transport), expected);
    assert.equal(h.events.some(event => event.kind === 'done'), false);
  }
  for (const extra of [{ model: 'other' }, { mode: 'full' }, { effort: 'high' }]) {
    const h = harness();
    await assert.rejects(adapt({ ...run, ...extra }, h.core, h.transport), /configuration/);
    assert.equal(h.requests.length, 0);
  }
  const h = harness();
  h.core.nextInput = async () => ({ kind: 'steer', text: 'unsupported' });
  await assert.rejects(adapt(run, h.core, h.transport), /live input/);
  assert.equal(h.responses.length, 0);
});
test('ACP example: host cancellation/error propagates without permission or synthetic completion', async () => {
  const h = harness();
  h.core.nextInput = async () => { throw new Error('Cancelled'); };
  await assert.rejects(adapt(run, h.core, h.transport), /Cancelled/);
  assert.equal(h.responses.length, 0);
  assert.equal(h.events.some(event => event.kind === 'done'), false);
});
