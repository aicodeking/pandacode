import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  acpPermissionResult, acpQuestion, acpQuestionResult, acpSupport, approvalResolved, BARE, builtinSupport, can, CHUNK_BYTES,
  claudePermissionResponse, COMPLETE_BYTES, frameCheck, FRAME_BYTES, HookPayloads, inputFields, parseAnswer, PREVIEW_BYTES,
  providerInput, providerSupport, questionResolved, type Answer, type Json, type Support,
} from '../src/extensions/runtime-hook-payload';
// Preview column of R0502 (complete tool inputs and approval answers). The browser preview runs no harness, so this
// spec runs in the test runner's Node: it checks the webview twin (src/extensions/runtime-hook-payload.ts) of the
// native rules (src-tauri/src/extensions/runtime_hook_payload.rs) against the shared fixtures, and drives the canonical
// Node fake agent (tests/fixtures/extensions/backends/fake-agent.mjs, B5) over real stdio. The same scenarios through
// PandaCode's declared ACP transport on Windows are the native test `runtime_hook_payload::tests::windows_transport`
// (feature extension-runtime-native-tests). No real harness runs here.
const fixtures = new URL('./fixtures/extensions/runtime-hook-payload/', import.meta.url);
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const answers = JSON.parse(readFileSync(new URL('answers.json', fixtures), 'utf8'));
const scenarios = JSON.parse(readFileSync(new URL('scenarios.json', fixtures), 'utf8'));
const scenario = (id: string) => scenarios.scenarios.find((entry: any) => entry.id === id);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const USER_DECLINE = 'Declined by the user';

test('extensions hook payload: a large input arrives as a preview and is read completely in 256 KiB chunks within 2 MiB frames', () => {
  const book = new HookPayloads();
  // Larger than the 4,096-byte display preview, smaller than 1 MiB: complete and structured.
  const small = { command: 'echo fixture', content: 'x'.repeat(50_000) };
  const recorded = book.record('run-a', 'project-a', 'tool-1', small);
  expect(recorded.fields).toEqual({ inputBytes: bytes(JSON.stringify(small)), inputComplete: true, input: small });
  const call = book.hookCall({ taskId: 'run-a', tool: { kind: 'shell', name: 'Bash' }, input: 'forged' }, recorded.callId) as any;
  expect(call.input).toEqual(small);
  expect(frameCheck({ kind: 'hook', payload: call })).toBeNull();

  // Over 3 MiB with multi-byte characters: a 1 MiB code-point-safe preview, then every chunk.
  const large = { command: 'rm -rf /tmp/fixture', padding: 'é'.repeat(3 << 20 >> 1) };
  const text = JSON.stringify(large);
  const big = book.record('run-a', null, 'tool-big', large);
  expect(big.fields.inputComplete).toBe(false);
  expect('input' in big.fields).toBe(false);
  const shown = (big.fields as any).inputPreview as string;
  expect(text.startsWith(shown)).toBe(true);
  expect(bytes(shown)).toBeLessThanOrEqual(PREVIEW_BYTES);
  expect(bytes(shown)).toBeGreaterThan(PREVIEW_BYTES - 4);
  expect(frameCheck(book.hookCall({ taskId: 'run-a' }, big.callId) as Json)).toBeNull();
  for (const start of [0, bytes(shown)]) {
    let cursor = start; let joined = start ? shown : ''; let chunks = 0;
    for (;;) {
      const chunk = book.read(big.callId, cursor);
      if (typeof chunk === 'string') throw new Error(chunk);
      expect(frameCheck({ ok: true, value: chunk })).toBeNull();
      expect(bytes(chunk.text)).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(chunk.totalBytes).toBe(bytes(text));
      joined += chunk.text; chunks += 1;
      if (chunk.nextCursor === null) break;
      expect(bytes(chunk.text)).toBeGreaterThan(CHUNK_BYTES - 4);
      cursor = chunk.nextCursor;
    }
    expect(joined).toBe(text);
    expect(JSON.parse(joined)).toEqual(large);
    expect(chunks).toBeGreaterThanOrEqual(Math.floor((bytes(text) - start) / CHUNK_BYTES));
  }
  // Cursors: inside a code point, beyond the end, at the end; unknown and ended calls.
  const inside = bytes(text.slice(0, text.indexOf('é'))) + 1;
  expect(book.read(big.callId, inside)).toBe('InvalidShape');
  expect(book.read(big.callId, bytes(text) + 1)).toBe('InvalidShape');
  expect((book.read(big.callId, bytes(text)) as any).nextCursor).toBeNull();
  expect(book.read('call-unknown', 0)).toBe('NotFound');
  for (const bad of [{ callId: big.callId }, { callId: big.callId, cursor: -1 }, { callId: big.callId, cursor: 0, extra: 1 }, { callId: 1, cursor: 0 }]) expect(book.serve(bad as Json)).toBe('InvalidShape');
  book.finish('run-a', 'tool-big');
  expect(book.read(big.callId, 0)).toBe('StaleContext');
  book.forgetRun('run-a');
  expect(book.read(big.callId, 0)).toBe('NotFound');
});

test('extensions hook payload: escaping, shape, a fixed serialization and per-run identity', () => {
  const book = new HookPayloads();
  // Backslashes double when serialized and again inside the preview string: still one frame.
  const escaped = book.record('run-e', null, 'tool-escape', { path: '\\'.repeat(1 << 20) });
  expect(escaped.fields.inputComplete).toBe(false);
  expect(frameCheck(book.hookCall({ taskId: 'run-e' }, escaped.callId) as Json)).toBeNull();
  const wide = Array.from({ length: 140_000 }, () => 0);
  expect(bytes(JSON.stringify(wide))).toBeLessThan(COMPLETE_BYTES);
  expect(inputFields(wide).inputComplete).toBe(false);
  let deep: Json = 0; for (let index = 0; index < 70; index++) deep = [deep];
  expect(inputFields(deep).inputComplete).toBe(false);
  expect(frameCheck({ text: 'x'.repeat(FRAME_BYTES) })).toBe('LimitExceeded');

  // Replaced until a hook sees it, then fixed; a held call outlives its end.
  const first = book.record('run-l', null, 'tool-1', { command: 'partial' });
  expect(book.record('run-l', null, 'tool-1', { command: 'complete' }).callId).toBe(first.callId);
  expect((book.payload(first.callId) as any).input.command).toBe('complete');
  expect((book.record('run-l', null, 'tool-1', { command: 'later' }).fields as any).input.command).toBe('complete');
  expect(book.retain(first.callId)).toBeNull();
  book.finish('run-l', 'tool-1');
  expect(typeof book.read(first.callId, 0)).toBe('object');
  book.release(first.callId);
  expect(book.read(first.callId, 0)).toBe('StaleContext');

  // The same harness call and request id in two runs: two calls, two requests, no leak.
  const one = book.record('run-1', null, '1', { command: 'a' });
  const two = book.record('run-2', null, '1', { command: 'b' });
  expect(one.callId).not.toBe(two.callId);
  expect(book.openApproval('run-1', '7', '1', builtinSupport('claude'))).toBe(one.callId);
  expect(book.openApproval('run-2', '7', '1', builtinSupport('claude'))).toBe(two.callId);
  book.attach('run-1', '7', { approved: false, reason: 'not here', decidedBy: 'sample.guard' });
  expect(book.take('run-2', '7', false)).toEqual({ approved: false });
  expect(book.take('run-1', '7', false).reason).toBe('not here');
  expect(book.take('run-1', '7', false)).toEqual({ approved: false });
});

test('extensions hook payload: the shared answer fixture renders the same semantics for every protocol', () => {
  const options = answers.acpOptions as Json[];
  const original = answers.originalInput as Json;
  const adapters: [string, Support][] = [
    ['provider', providerSupport({ can: ['rewriteInput'] })], ['providerBare', providerSupport({})],
    ['acpDeclared', acpSupport(answers.acpDeclaredInitialize)], ['acpBare', BARE], ['claude', builtinSupport('claude')], ['kimi', builtinSupport('kimi')],
  ];
  expect(can(builtinSupport('claude'))).toEqual(['approve', 'deny', 'ask', 'rewriteInput']);
  for (const entry of answers.cases) {
    const answer = parseAnswer(entry.answer) as Answer;
    for (const [adapter, support] of adapters) {
      const book = new HookPayloads(); const label = `${entry.id}/${adapter}`;
      book.openApproval('run', 'req', 'tool-1', support);
      const refused = (entry.expect.unsupportedFor ?? []).includes(adapter);
      if (refused) {
        expect(() => book.attach('run', 'req', answer), label).toThrow(/^UnsupportedCapability/);
        expect(book.support('run', 'req'), `${label}: still open`).toEqual(support);
        continue;
      }
      book.attach('run', 'req', answer);
      const claimed = book.take('run', 'req', answer.approved);
      expect(claimed, label).toEqual(answer);
      let executed: Json; let reason: string | null;
      if (adapter.startsWith('provider')) {
        const value = providerInput(claimed) as any; executed = value.input ?? original; reason = value.reason ?? null;
      } else if (adapter === 'claude') {
        const response = claudePermissionResponse(original, claimed, USER_DECLINE) as any;
        executed = response.updatedInput ?? original; reason = response.message && response.message !== USER_DECLINE ? response.message : null;
      } else {
        const result = acpPermissionResult(options, claimed, support) as any;
        expect(result.outcome.optionId, label).toBe(answer.approved ? 'allow' : 'deny');
        executed = result._meta?.pandacode?.updatedInput ?? original; reason = result._meta?.pandacode?.reason ?? null;
      }
      if (answer.approved) expect(executed, label).toEqual(entry.expect.executed);
      expect(reason, label).toBe(support.denyReason === 'answer' ? entry.expect.reason : null);
      expect(approvalResolved('task', 'req', 'call-x', claimed).by, label).toEqual(entry.expect.by);
    }
  }
  expect(approvalResolved('task', 'req', null, null).by).toBe('cancelled');
  for (const bad of [{ approved: 'yes' }, { approved: false, input: {} }, { approved: false, reason: '' }, { approved: true, decidedBy: 'Sample' }, { approved: true, extra: 1 }]) expect(() => parseAnswer(bad as Json)).toThrow();
  // Structured questions over ACP: options become answers and an answer selects its option.
  const question = { id: 1003, method: 'session/request_permission', params: { toolCall: { toolCallId: 'question-db', title: 'Which database?' }, options: [{ optionId: 'q0_opt_0', name: 'Postgres', kind: 'allow_once' }, { optionId: 'q0_opt_1', name: 'SQLite', kind: 'allow_once' }, { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }] } };
  expect(acpQuestion(question)?.[0]).toMatchObject({ id: 'q0', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] });
  expect(acpQuestionResult(question, { answers: { q0: { answers: ['SQLite'] } } })).toEqual({ outcome: { outcome: 'selected', optionId: 'q0_opt_1' } });
  expect(acpQuestionResult(question, { answers: {} })).toEqual({ outcome: { outcome: 'cancelled' } });
  expect(questionResolved('task', 'req', 'sample.guard', { answers: { q0: { answers: ['Postgres'] } } }).by).toEqual({ package: 'sample.guard' });
});

type Frame = Record<string, any>;
function agent(env: Record<string, string>) {
  const child = spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { ...process.env, ...env } });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  const values: Frame[] = []; const all: Frame[] = []; const waiting: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    const frame = JSON.parse(line); all.push(frame);
    const at = waiting.findIndex(item => item.match(frame));
    if (at < 0) values.push(frame); else waiting.splice(at, 1)[0].resolve(frame);
  });
  const next = (match: (frame: Frame) => boolean, ms = 20_000): Promise<Frame> => {
    const at = values.findIndex(match);
    if (at >= 0) return Promise.resolve(values.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { match, resolve: (frame: Frame) => { clearTimeout(timer); resolve(frame); } };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error('fake agent frame timeout')); }, ms);
      waiting.push(item);
    });
  };
  const send = (frame: Frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  return {
    all, next, send,
    async open(): Promise<{ sessionId: string; support: Support }> {
      await new Promise<void>((resolve, reject) => { createInterface({ input: child.stderr }).once('line', () => resolve()); child.once('error', reject); });
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
      const support = acpSupport((await next(frame => frame.id === 1)).result);
      send({ id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } });
      return { sessionId: (await next(frame => frame.id === 2)).result.sessionId, support };
    },
    async close() { child.stdin.end(); expect(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])).toBe(0); },
  };
}
const said = (session: ReturnType<typeof agent>, text: string) => session.next(frame => frame.method === 'session/update' && frame.params.update.content?.text === text);
const prompt = (session: ReturnType<typeof agent>, sessionId: string, id: number, text: string) => session.send({ id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });

test('extensions hook payload: the fake agent hands over a large input completely, receives the deny reason and runs a supported rewrite', async () => {
  const book = new HookPayloads();
  // A tool input over 1 MiB, emitted by the agent itself: the display preview is cut, the payload is a preview and
  // hooks.input reassembles exactly what the agent sent.
  const large = agent(scenario('large-input').env);
  try {
    const { sessionId } = await large.open();
    prompt(large, sessionId, 10, scenario('large-input').prompt);
    const frame = await large.next(entry => entry.method === 'session/update' && entry.params.update.sessionUpdate === 'tool_call');
    const raw = frame.params.update.rawInput;
    expect(bytes(JSON.stringify(raw))).toBeGreaterThan(scenario('large-input').expect.minimumBytes);
    const recorded = book.record('run-large', null, frame.params.update.toolCallId, raw);
    expect(recorded.fields.inputComplete).toBe(false);
    let cursor: number | null = 0; let joined = '';
    while (cursor !== null) { const chunk = book.read(recorded.callId, cursor); if (typeof chunk === 'string') throw new Error(chunk); expect(frameCheck({ ok: true, value: chunk })).toBeNull(); joined += chunk.text; cursor = chunk.nextCursor; }
    expect(JSON.parse(joined)).toEqual(raw);
    expect(raw.command).toBe(scenario('large-input').expect.command);
    await said(large, 'after-large');
    expect((await large.next(entry => entry.id === 10)).result.stopReason).toBe('end_turn');
  } finally { await large.close(); }

  // An agent that declares the PandaCode answer fields: the reason and the rewrite reach it.
  const declared = agent(scenario('deny-reason').env);
  try {
    const { sessionId, support } = await declared.open();
    expect(support).toEqual({ denyReason: 'answer', rewriteInput: true });
    prompt(declared, sessionId, 11, scenario('deny-reason').prompt);
    let request = await declared.next(entry => entry.method === 'session/request_permission');
    book.openApproval(sessionId, String(request.id), request.params.toolCall.toolCallId, support);
    book.attach(sessionId, String(request.id), { approved: false, reason: scenario('deny-reason').reason, decidedBy: 'sample.guard' });
    declared.send({ id: request.id, result: acpPermissionResult(request.params.options, book.take(sessionId, String(request.id), false), support) });
    await said(declared, `denied: ${scenario('deny-reason').reason}`);
    expect((await declared.next(entry => entry.id === 11)).result.stopReason).toBe('end_turn');

    prompt(declared, sessionId, 12, scenario('rewrite-supported').prompt);
    request = await declared.next(entry => entry.method === 'session/request_permission');
    book.openApproval(sessionId, String(request.id), request.params.toolCall.toolCallId, support);
    book.attach(sessionId, String(request.id), { approved: true, input: scenario('rewrite-supported').rewrite, decidedBy: 'sample.guard' });
    declared.send({ id: request.id, result: acpPermissionResult(request.params.options, book.take(sessionId, String(request.id), true), support) });
    await said(declared, `ran: ${JSON.stringify(scenario('rewrite-supported').rewrite)}`);
    expect((await declared.next(entry => entry.id === 12)).result.stopReason).toBe('end_turn');
    expect(declared.all.some(entry => entry.params?.update?.content?.text === `ran: ${JSON.stringify(scenario('rewrite-supported').expect.original)}`)).toBe(false);
  } finally { await declared.close(); }

  // An agent that declares nothing: the rewrite is refused before any answer, so the old input never runs.
  const bare = agent(scenario('rewrite-unsupported').env);
  try {
    const { sessionId, support } = await bare.open();
    expect(support).toEqual(BARE);
    prompt(bare, sessionId, 13, scenario('rewrite-unsupported').prompt);
    const request = await bare.next(entry => entry.method === 'session/request_permission');
    book.openApproval(sessionId, String(request.id), request.params.toolCall.toolCallId, support);
    expect(() => book.attach(sessionId, String(request.id), { approved: true, input: scenario('rewrite-unsupported').rewrite, decidedBy: 'sample.guard' })).toThrow(/^UnsupportedCapability/);
    expect(book.support(sessionId, String(request.id))).toEqual(BARE);
    // The user then denies it at the normal prompt: the bare decision, no `_meta`.
    const result = acpPermissionResult(request.params.options, book.take(sessionId, String(request.id), false), support);
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    bare.send({ id: request.id, result });
    await said(bare, 'denied: permission rejected (ACP supplied no reason)');
    expect((await bare.next(entry => entry.id === 13)).result.stopReason).toBe('end_turn');
    expect(bare.all.some(entry => typeof entry.params?.update?.content?.text === 'string' && entry.params.update.content.text.startsWith('ran: '))).toBe(false);
  } finally { await bare.close(); }
});
