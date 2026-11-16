import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { runScenario, parseScenario } from '../core/scenario.mjs';
import { body, json, listen, listener } from '../common.mjs';
import { program, control, evidence } from '../test-support.mjs';

test('B5 shared core covers every step, reason/rewrite, questions, compaction and fixed reply', async () => {
  const events = [], compact = [], sleeps = [];
  const io = {
    emit: value => events.push(value), permission: async () => ({ approved: true, input: { command: 'rewritten' } }),
    question: async () => 'chosen', listTools: async () => [{ name: 'memory' }], callTool: async () => ({ success: true }),
    compact: async () => compact.push(true), sleep: async value => sleeps.push(value),
  };
  const prompt = `#script ${JSON.stringify([{ say: 'hello' }, { tool: { name: 'Bash', kind: 'shell', input: { command: 'original' } }, ask: true, output: 'recorded' }, { question: { id: 'q', question: '?' } }, { listTools: true }, { callTool: { name: 'memory' } }, { callTool: { name: 'absent' } }, { echoPrompt: true }, { usage: { usedTokens: 50, contextWindow: 100 } }, { compact: true }, { sleep: 3 }])}`;
  await runScenario(prompt, io);
  assert(events.some(x => x.text === 'ran: {"command":"rewritten"}'));
  assert(events.some(x => x.text === 'answer: chosen')); assert(events.some(x => x.text === 'memory'));
  assert(events.some(x => x.text === 'tool-missing')); assert(events.some(x => x.text === prompt));
  assert(events.some(x => x.kind === 'usage' && x.usedTokens === 50)); assert.equal(compact.length, 1); assert.deepEqual(sleeps, [3]);
  await runScenario('#reply fixed summary', io); assert.equal(events.at(-1).text, 'fixed summary');
  await runScenario('ordinary', io); assert.equal(events.at(-1).text, 'echo: ordinary');
  await runScenario('#script [{"tool":{"input":{}},"ask":true}]', { ...io, permission: async () => ({ approved: false, reason: 'guard.rule' }) });
  assert.equal(events.at(-1).text, 'denied: guard.rule');
  await runScenario('#script [{"callTool":{"name":"memory"}}]', { ...io, callTool: async () => { throw new Error('service stopped'); } });
  assert.equal(events.at(-1).text, 'tool-error: service stopped');
  await assert.rejects(runScenario('#script [{"fail":"failed turn"}]', io), /failed turn/);
  for (const value of ['#script {}', '#script [null]', '#script [{"sleep":-1}]', '#script [{"say":"x","fail":"y"}]']) assert.throws(() => parseScenario(value));
});

async function agent(t, servers = []) {
  const logFile = await evidence('agent-frames.jsonl');
  const child = program(t, './fake-agent/fake-agent.mjs', [], { FAKE_AGENT_LOG: logFile });
  const ready = await child.err.next(x => x.ready);
  child.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  assert.equal((await child.out.next(x => x.id === 1)).result.protocolVersion, 1);
  child.send({ id: 2, method: 'session/new', params: { cwd: '.', mcpServers: servers } });
  const sessionId = (await child.out.next(x => x.id === 2)).result.sessionId;
  const prompt = (id, value) => child.send({ id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: value }] } });
  const text = value => child.out.next(x => x.method === 'session/update' && x.params.update.content?.text === value);
  return { ...child, ready, sessionId, prompt, text, logFile };
}

test('B5 Windows stdio ACP text, permission allow/rewrite/deny and usage', async t => {
  const a = await agent(t);
  a.prompt(3, '#script [{"say":"hello"},{"tool":{"name":"Bash","kind":"shell","input":{"command":"never execute"}},"ask":true},{"usage":{"usedTokens":64,"contextWindow":128}}]');
  await a.text('hello');
  const permission = await a.out.next(x => x.method === 'session/request_permission');
  assert.equal(permission.params.toolCall.rawInput.command, 'never execute');
  a.send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' }, _meta: { fixture: { input: { command: 'rewritten' } } } } });
  await a.text('ran: {"command":"rewritten"}');
  assert.equal((await a.out.next(x => x.params?.update?.sessionUpdate === 'usage_update')).params.update.used, 64);
  assert.equal((await a.out.next(x => x.id === 3)).result.stopReason, 'end_turn');
  a.prompt(4, '#script [{"tool":{"name":"Bash","kind":"shell","input":{}},"ask":true}]');
  const denial = await a.out.next(x => x.method === 'session/request_permission');
  a.send({ id: denial.id, result: { outcome: { outcome: 'selected', optionId: 'deny' }, _meta: { fixture: { reason: 'git.reset-hard' } } } });
  await a.text('denied: git.reset-hard'); await a.out.next(x => x.id === 4);
  a.prompt(5, '#script [{"tool":{"name":"Read","kind":"read","input":{"path":"fixture"}},"ask":false}]');
  await a.text('ran: {"path":"fixture"}'); await a.out.next(x => x.id === 5);
  const frames = (await readFile(a.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(frames.some(x => x.method === 'initialize')); assert(frames.some(x => x.result?._meta?.fixture?.reason === 'git.reset-hard'));
  await control(a.ready.control, 'shutdown'); assert.equal((await a.exited).code, 0);
});

test('B5 is a real loopback tool client with bearer, list/call/missing/error', async t => {
  const calls = [];
  const server = listener(async (req, res) => {
    const frame = JSON.parse(await body(req)); calls.push({ frame, headers: req.headers });
    if (req.headers.authorization !== 'Bearer tok-tools-fixture') return json(res, {}, 401);
    if (frame.method === 'initialize') return json(res, { jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    if (frame.method === 'tools/list') return json(res, { jsonrpc: '2.0', id: frame.id, result: { tools: [{ name: 'memory' }, { name: 'broken' }] } });
    if (frame.method === 'tools/call') return json(res, { jsonrpc: '2.0', id: frame.id, result: frame.params.name === 'broken' ? { isError: true, content: [{ type: 'text', text: 'service stopped' }] } : { success: true, received: frame.params.arguments } });
    json(res, { result: {} });
  });
  t.after(server.close); const url = await listen(server.server);
  const a = await agent(t, [{ name: 'fixture', type: 'http', url: `${url}/mcp`, headers: [{ name: 'Authorization', value: 'Bearer tok-tools-fixture' }] }]);
  a.prompt(3, '#script [{"listTools":true},{"callTool":{"name":"memory","arguments":{"mode":"add"}}},{"callTool":{"name":"absent"}},{"callTool":{"name":"broken"}}]');
  await a.text('memory, broken');
  await a.text('tool-result: {"success":true,"received":{"mode":"add"}}');
  await a.text('tool-missing'); await a.text('tool-error: service stopped');
  assert.equal((await a.out.next(x => x.id === 3)).result.stopReason, 'end_turn');
  assert(calls.some(x => x.frame.method === 'initialize')); assert(calls.some(x => x.frame.method === 'tools/call' && x.frame.params.arguments?.mode === 'add'));
  assert(calls.some(x => x.frame.method === 'notifications/initialized' && x.frame.id === undefined));
  assert(calls.every(x => x.headers.authorization === 'Bearer tok-tools-fixture'));
});

test('B5 cancel pending permission/sleep, unsupported steps, malformed frames, faults and EOF', async t => {
  const a = await agent(t);
  a.prompt(3, '#script [{"sleep":60000}]');
  a.send({ method: 'session/cancel', params: { sessionId: a.sessionId } });
  assert.equal((await a.out.next(x => x.id === 3)).result.stopReason, 'cancelled');
  a.prompt(4, '#script [{"tool":{"name":"Bash","input":{}},"ask":true}]');
  await a.out.next(x => x.method === 'session/request_permission');
  a.send({ method: 'session/cancel', params: { sessionId: a.sessionId } });
  assert.equal((await a.out.next(x => x.id === 4)).result.stopReason, 'cancelled');
  for (const [id, prompt, message] of [[5, '#script [{"question":{"id":"q"}}]', /no question frame/], [6, '#script [{"compact":true}]', /no compaction frame/], [7, '#script [{"fail":"failed turn"}]', /failed turn/]]) {
    a.prompt(id, prompt); assert.match((await a.out.next(x => x.id === id)).error.message, message);
  }
  a.prompt(8, '#reply model summary'); await a.text('model summary'); await a.out.next(x => x.id === 8);
  a.child.stdin.write('not-json\n'); assert.equal((await a.out.next(x => x.id === null)).error.code, -32700);
  a.send({ id: 9, method: 'session/new', params: { mcpServers: [{ type: 'http', url: 'https://example.test/mcp' }] } });
  assert.match((await a.out.next(x => x.id === 9)).error.message, /loopback/);
  await control(a.ready.control, 'fault', { kind: 'refuse' });
  a.send({ id: 10, method: 'initialize' }); assert.match((await a.out.next(x => x.id === 10)).error.message, /refusal/);
  await control(a.ready.control, 'reset');
  const log = await (await fetch(`${a.ready.control}/control/log`)).json(); assert(Array.isArray(log));
  a.child.stdin.end(); assert.equal((await a.exited).code, 0);
  await assert.rejects(fetch(`${a.ready.control}/control/log`));
});

test('B5 bounded fault modes and pending-turn EOF terminate without a child executor', async t => {
  const a = await agent(t);
  await control(a.ready.control, 'fault', { kind: 'stall', ms: 100 });
  a.send({ id: 11, method: 'initialize' });
  await delay(130); assert(!a.out.values.some(x => x.id === 11));
  a.send({ id: 12, method: 'initialize' }); assert.equal((await a.out.next(x => x.id === 12)).result.protocolVersion, 1);
  await control(a.ready.control, 'fault', { kind: 'garbage', ms: 1 });
  assert((await a.out.next(x => x.invalid)).invalid);
  a.prompt(13, '#script [{"sleep":60000}]');
  a.child.stdin.end(); assert.equal((await a.exited).code, 0);
  const b = await agent(t);
  await control(b.ready.control, 'fault', { kind: 'drop' });
  assert.equal((await b.exited).code, 0);
  const c = await agent(t); c.child.kill(); await c.exited;
});
