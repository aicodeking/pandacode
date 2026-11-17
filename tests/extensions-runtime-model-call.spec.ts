import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import {
  DEFAULT_TIMEOUT_MS, MAX_RUNNING, MAX_WAITING, ModelCalls, parseOptions, PERMISSION, type Run, type RunRequest, type Wiring,
} from '../src/extensions/runtime-model-call';
// Preview column of R0704 (`panda.models.call`, one bounded model answer). The browser preview runs no harness, so this
// spec runs in the test runner's Node: it checks the options and the admission rules through the webview twin
// (src/extensions/runtime-model-call.ts) of the native module (src-tauri/src/extensions/runtime_model_call.rs, whose tests
// read the same cases.json), and answers hidden runs from the scripted fake agent (B5, tests/fixtures/extensions/backends/
// fake-agent.mjs) over real stdio: `#reply <text>` returns the text. No real harness runs here; the installed-app column
// (a signed-in harness) is pending, not claimed.
const fixtures = new URL('./fixtures/extensions/runtime-model-call/', import.meta.url);
const agentPath = fileURLToPath(new URL('./fixtures/extensions/backends/fake-agent.mjs', import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const manifest = read('extension.json');
const cases = read('cases.json');
type Obj = Record<string, any>;
const OWNER = 'sample.ask';

function expand(value: any): any {
  if (typeof value === 'string') { const match = /^\{pad:(\d+)\}$/.exec(value); return match ? 'x'.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  return value;
}

/** B5 over stdio ACP: one session, one prompt, the text it streams back, then stdin EOF and an awaited exit. */
async function askAgent(prompt: string, log: string, signal: AbortSignal): Promise<string> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [agentPath], { stdio: 'pipe', windowsHide: true, env: { ...process.env, FAKE_AGENT_LOG: log } });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<number, (frame: Obj) => void>();
  let text = '';
  lines.on('line', line => {
    const frame = JSON.parse(line) as Obj;
    if (frame.method === 'session/update' && frame.params?.update?.sessionUpdate === 'agent_message_chunk') text += frame.params.update.content.text;
    else if (typeof frame.id === 'number') waiting.get(frame.id)?.(frame);
  });
  let serial = 0;
  const send = (method: string, params: Obj) => new Promise<Obj>((resolve, reject) => {
    const id = ++serial;
    waiting.set(id, frame => (frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const stop = async () => { child.stdin.end(); await exited; };
  try {
    await send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await send('session/new', { cwd: process.cwd(), mcpServers: [] });
    signal.addEventListener('abort', () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.sessionId } })}\n`), { once: true });
    const done = await send('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
    if (done.stopReason === 'cancelled') throw Object.assign(new Error('cancelled'), { code: 'Cancelled' });
    return text;
  } finally { await stop(); }
}

/** A registry whose hidden runs go to B5; `tasks` stands for the sidebar and `seen` for what each run was handed. */
function wired(options: { granted?: boolean; run?: Run | null } = {}) {
  const { granted = true } = options;
  const scratch = mkdtempSync(join(tmpdir(), 'pc-model-call-'));
  const log = join(scratch, 'agent.jsonl');
  const tasks: string[] = [];
  const seen: RunRequest[] = [];
  const hooks: string[] = [];
  const agent: Run = async (request, signal) => {
    seen.push(request);
    if (request.options.harness === 'no-hidden') throw Object.assign(new Error('x'), { code: 'UnsupportedCapability' });
    if (request.options.harness === 'signed-out') throw Object.assign(new Error('x'), { code: 'HostUnavailable' });
    return { text: await askAgent(request.options.prompt, log, signal), harness: request.options.harness ?? 'fake-agent', model: 'fixture-model', input: 11, output: 3 };
  };
  const wiring: Wiring = {
    packageOf: owner => (owner === OWNER ? { version: '1.0.0', name: 'Ask' } : undefined),
    holds: (owner, _version, permission) => granted && owner === OWNER && permission === PERMISSION,
    run: options.run === null ? undefined : (options.run ?? agent),
  };
  return { calls: new ModelCalls(wiring), tasks, seen, hooks, log, wiring, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}
/** A run that holds until `release()` (or is aborted), counting how many started. */
function held() {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { started: 0 };
  const run: Run = async (request, signal) => {
    state.started += 1;
    await new Promise<void>((resolve, reject) => { gate.then(resolve); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    return { text: 'released', harness: 'fake-agent', model: 'fixture-model' };
  };
  return { run, state, release: () => release() };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));

test.describe('extensions model call: R0704 one bounded model answer', () => {
  test('the fixture package is valid and holds models.call', () => {
    expect((validateContract('packages', [manifest]) as Obj).ok).toBe(true);
    expect(manifest.permissions).toContain(PERMISSION);
    expect(cases.limits).toMatchObject({ running: MAX_RUNNING, waiting: MAX_WAITING, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
  });

  for (const scripted of cases.options as Obj[]) {
    test(`options: ${scripted.id}`, () => {
      const result = parseOptions(expand(scripted.options));
      if (scripted.expect.code) { expect(result.ok).toBe(false); expect((result as Obj).error.code).toBe(scripted.expect.code); }
      else { expect(result.ok).toBe(true); expect((result as Obj).options.timeoutMs).toBe(scripted.expect.timeoutMs ?? DEFAULT_TIMEOUT_MS); }
    });
  }

  test('the scripted harness returns its answer for one prompt: no task, usage names the package, no tool and no hook', async () => {
    const { calls, tasks, seen, log, cleanup } = wired();
    try {
      const done = await calls.call(OWNER, 'c1', { prompt: '#reply four' });
      expect(done).toMatchObject({ ok: true, answer: { text: 'four', harness: 'fake-agent', model: 'fixture-model', usage: { input: 11, output: 3 } } });
      expect(tasks, 'no sidebar task was created').toEqual([]);
      const usage = calls.usage(OWNER);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ kind: 'models.call', owner: OWNER, package: 'Ask', harness: 'fake-agent', model: 'fixture-model', input: 11, output: 3 });
      expect(JSON.stringify(usage)).not.toContain('four');
      expect(calls.counters(OWNER)).toEqual({ running: 0, waiting: 0, live: 0 });
      // The hidden run is handed the options and the package name only: no tool host, hook registry, session or task.
      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0]).sort()).toEqual(['options', 'owner', 'packageName']);
      // B5 saw exactly the ACP lifecycle of one hidden run, a session with no tool server and no other prompt.
      const frames = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Obj);
      expect(frames.map(frame => frame.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
      expect(frames[1].params.mcpServers).toEqual([]);
      expect(frames[2].params.prompt).toEqual([{ type: 'text', text: '#reply four' }]);
    } finally { cleanup(); }
  });

  test('two calls run and eight wait per package; the next is refused; a freed slot starts the next waiting call', async () => {
    const hold = held();
    const { calls, cleanup } = wired({ run: hold.run });
    try {
      const pending = Array.from({ length: MAX_RUNNING + MAX_WAITING }, (_, index) => calls.call(OWNER, `c${index}`, { prompt: 'hold', timeoutMs: 600_000 }));
      await tick();
      expect(calls.counters(OWNER)).toEqual({ running: MAX_RUNNING, waiting: MAX_WAITING, live: MAX_RUNNING + MAX_WAITING });
      expect(hold.state.started).toBe(MAX_RUNNING);
      const refused = await calls.call(OWNER, 'c-over', { prompt: 'hold' });
      expect(refused).toMatchObject({ ok: false, error: { code: 'LimitExceeded' } });
      expect(calls.cancel(OWNER, 'c9'), 'a waiting call leaves its place').toBe(true);
      expect(await pending[9]).toMatchObject({ ok: false, error: { code: 'Cancelled' } });
      expect(calls.cancel(OWNER, 'c0'), 'a running call frees its slot').toBe(true);
      expect(await pending[0]).toMatchObject({ ok: false, error: { code: 'Cancelled' } });
      await tick();
      expect(hold.state.started, 'the first waiting call started').toBe(MAX_RUNNING + 1);
      expect(calls.cancel(OWNER, 'nobody')).toBe(false);
      expect(calls.revoked(OWNER)).toBe(MAX_RUNNING + MAX_WAITING - 2);
      for (const result of await Promise.all(pending.slice(1, 9))) expect(result).toMatchObject({ ok: false, error: { code: 'PermissionDenied' } });
      expect(calls.counters(OWNER)).toEqual({ running: 0, waiting: 0, live: 0 });
    } finally { cleanup(); }
  });

  test('timeout, sign-out, a missing hidden-run path and a missing grant end the call at once', async () => {
    const hold = held();
    const { calls, cleanup } = wired({ run: hold.run });
    try {
      expect(await calls.call(OWNER, 't', { prompt: 'hold', timeoutMs: 1_000 })).toMatchObject({ ok: false, error: { code: 'Timeout' } });
      const signedOut = calls.call(OWNER, 's', { prompt: 'hold', harness: 'fake-agent', timeoutMs: 600_000 });
      await tick();
      expect(calls.signedOut('fake-agent')).toBe(1);
      expect(await signedOut).toMatchObject({ ok: false, error: { code: 'HostUnavailable' } });
      expect(calls.signedOut('another-harness'), 'nothing in flight').toBe(0);
      expect(await calls.call(OWNER, 'dup', { prompt: '' })).toMatchObject({ ok: false, error: { code: 'InvalidShape' } });
      expect(await calls.call(OWNER, '', { prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'InvalidShape' } });
      expect(await calls.call('sample.other', 'o', { prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'HostUnavailable' } });
      expect(calls.usage()).toEqual([]);
      expect(calls.counters(OWNER)).toEqual({ running: 0, waiting: 0, live: 0 });
    } finally { cleanup(); }
    const none = wired({ run: null });
    try { expect(await none.calls.call(OWNER, 'a', { prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability' } }); } finally { none.cleanup(); }
    const unsupported = wired();
    try {
      expect(await unsupported.calls.call(OWNER, 'u', { prompt: 'x', harness: 'no-hidden' })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability' } });
      expect(await unsupported.calls.call(OWNER, 'h', { prompt: 'x', harness: 'signed-out' })).toMatchObject({ ok: false, error: { code: 'HostUnavailable' } });
    } finally { unsupported.cleanup(); }
    const denied = wired({ granted: false });
    try {
      expect(await denied.calls.call(OWNER, 'd', { prompt: '#reply x' })).toMatchObject({ ok: false, error: { code: 'PermissionDenied' } });
      expect(denied.seen, 'without models.call no harness is reached').toEqual([]);
      expect(existsSync(denied.log), 'B5 was never started').toBe(false);
    } finally { denied.cleanup(); }
  });

  test('a cancelled call stops the scripted harness and answers Cancelled', async () => {
    const { calls, cleanup } = wired();
    try {
      // `#script [{sleep}]` keeps B5 in its turn until session/cancel arrives.
      const answer = calls.call(OWNER, 'slow', { prompt: '#script [{"sleep":30000}]', timeoutMs: 600_000 });
      await new Promise<void>(resolve => setTimeout(resolve, 400));
      expect(calls.cancel(OWNER, 'slow')).toBe(true);
      expect(await answer).toMatchObject({ ok: false, error: { code: 'Cancelled' } });
      expect(calls.counters(OWNER)).toEqual({ running: 0, waiting: 0, live: 0 });
    } finally { cleanup(); }
  });

  test('the fixture service asks through panda.models.call and returns the answer', async () => {
    const { calls, cleanup } = wired();
    try {
      const require = createRequire(import.meta.url);
      const main = require(fileURLToPath(new URL('main.cjs', fixtures)));
      const commands = new Map<string, (context: Obj) => Promise<unknown>>();
      let serial = 0;
      const panda = {
        commands: { register: (id: string, handler: (context: Obj) => Promise<unknown>) => { commands.set(id, handler); return { dispose: () => commands.delete(id) }; } },
        models: { call: async (options: Obj) => {
          const { signal, ...rest } = options;
          const id = `svc-${++serial}`;
          signal?.addEventListener('abort', () => calls.cancel(OWNER, id), { once: true });
          const result = await calls.call(OWNER, id, rest as never);
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          return result.answer;
        } },
      };
      await main.service(panda);
      expect(await commands.get('sample.ask/ask')!({ prompt: '#reply seven' })).toMatchObject({ text: 'seven', harness: 'fake-agent' });
      expect(calls.usage(OWNER)).toHaveLength(1);
    } finally { cleanup(); }
  });
});
