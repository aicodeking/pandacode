import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compile = file => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const http = `data:text/javascript,${encodeURIComponent(compile('../src/web-http.ts'))}`;
const source = compile('../src/web-terminal-recovery.ts').replace("'./web-http.ts'", JSON.stringify(http));
const { WebTerminalRecovery } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

globalThis.window = { setTimeout, clearTimeout };
globalThis.location = new URL('https://panda.example/');
const snapshot = (data = 'AB', nextSequence = 2, patch = {}) => ({ terminalId: 't', baseSequence: nextSequence ? 1 : 0, nextSequence, data, exit: false, truncated: false, ...patch });
const response = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function recorder(onRecovered = () => {}) {
  const state = { replacements: [], appends: [], errors: [], paused: 0, recovered: 0 };
  const recovery = new WebTerminalRecovery(
    (data, exit) => state.replacements.push({data, exit}),
    (data, exit) => state.appends.push({data, exit}),
    error => state.errors.push(error),
    () => { state.recovered++; onRecovered(); },
    () => state.paused++,
  );
  recovery.begin('t'); return { state, recovery };
}
const frame = (sequence, data = '', exit = false) => ({ terminalId: 't', terminalSequence: sequence, data, exit });

test('snapshot replaces the screen, deduplicates covered frames, and appends newer output once', async () => {
  const pending = deferred(); globalThis.fetch = async () => pending.promise;
  const { recovery, state } = recorder(); const started = recovery.start('t');
  recovery.consume(frame(2, 'B')); recovery.consume(frame(3, 'C')); recovery.consume(frame(3, 'duplicate'));
  pending.resolve(response(snapshot())); await started;
  assert.deepEqual(state.replacements, [{ data: 'AB', exit: false }]);
  assert.deepEqual(state.appends, [{ data: 'C', exit: false }]);
  recovery.consume(frame(2, 'old')); recovery.consume(frame(4, 'D', true)); recovery.consume(frame(4, 'duplicate'));
  assert.deepEqual(state.appends, [{ data: 'C', exit: false }, { data: 'D', exit: true }]);
  assert.equal(state.recovered, 1); assert.equal(state.errors.length, 0); recovery.dispose();
});

test('a steady-state sequence gap pauses input and obtains a new full snapshot', async () => {
  const pending = deferred(), resumed = deferred(); let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? response(snapshot('A', 1)) : pending.promise;
  const { recovery, state } = recorder(() => { if (state.recovered === 2) resumed.resolve(); });
  await recovery.start('t'); recovery.consume(frame(3, 'C')); recovery.consume(frame(4, 'D'));
  assert.equal(state.paused, 2); assert.equal(requests, 2);
  pending.resolve(response(snapshot('ABC', 3))); await resumed.promise;
  assert.deepEqual(state.replacements.map(value => value.data), ['A', 'ABC']);
  assert.deepEqual(state.appends.map(value => value.data), ['D']); assert.equal(state.errors.length, 0); recovery.dispose();
});

test('superseded requests cannot replace newer state even when fetch ignores abort', async () => {
  const old = deferred(), recent = deferred(); const signals = [];
  globalThis.fetch = async (_url, init) => { signals.push(init.signal); return signals.length === 1 ? old.promise : recent.promise; };
  const { recovery, state } = recorder(); const first = recovery.start('t'), second = recovery.start('t');
  assert.equal(signals[0].aborted, true);
  recent.resolve(response(snapshot('new', 1))); await second;
  old.resolve(response(snapshot('stale', 1))); await first;
  assert.deepEqual(state.replacements.map(value => value.data), ['new']); assert.equal(state.recovered, 1); recovery.dispose();
});

test('dispose discards late fetch completion without touching the screen or reporting failure', async () => {
  const pending = deferred(); globalThis.fetch = async () => pending.promise;
  const { recovery, state } = recorder(); const started = recovery.start('t'); recovery.dispose();
  pending.resolve(response(snapshot())); await started;
  assert.equal(state.replacements.length, 0); assert.equal(state.recovered, 0); assert.equal(state.errors.length, 0);
});

test('invalid, incomplete and truncated snapshots remain blocked until terminal reopen', async () => {
  for (const value of [null, snapshot('', 0, { exit: 'false' }), snapshot('', 0, { truncated: 'false' }), snapshot('x', 2, {baseSequence: 2}), snapshot('x', 1, {terminalId:'other'}), snapshot('tail', 4, {truncated:true}), snapshot('x', Number.MAX_SAFE_INTEGER + 1)]) {
    globalThis.fetch = async () => response(value);
    const { recovery, state } = recorder(); await recovery.start('t');
    assert.equal(state.errors.length, 1); assert.equal(state.replacements.length, 0); assert.equal(state.recovered, 0);
    await recovery.start('t'); recovery.consume(frame(1, 'ignored')); assert.equal(state.errors.length, 1); assert.equal(state.appends.length, 0); recovery.dispose();
  }
});

test('output-byte and zero-byte-frame count overflow abort recovery without later resuming', async () => {
  for (const overflow of ['bytes', 'frames']) {
    let aborted = false; globalThis.fetch = async (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); });
    });
    const { recovery, state } = recorder(); const started = recovery.start('t');
    if (overflow === 'bytes') recovery.consume(frame(1, 'x'.repeat(1024 * 1024 + 1)));
    else for (let index = 1; index <= 4097; index++) recovery.consume(frame(index));
    await started; assert.equal(aborted, true); assert.equal(state.errors.length, 1); assert.equal(state.recovered, 0); assert.equal(state.replacements.length, 0); recovery.dispose();
  }
});

test('missing sequence metadata and unauthorized snapshots fail visibly', async () => {
  globalThis.fetch = async () => response(snapshot('', 0));
  const { recovery, state } = recorder(); await recovery.start('t');
  recovery.consume({ terminalId: 't', data: 'unsequenced' });
  assert.equal(state.errors.length, 1); assert.equal(state.appends.length, 0); recovery.dispose();
  globalThis.fetch = async () => new Response(null, { status: 403 });
  const denied = recorder(); await denied.recovery.start('t'); assert.match(denied.state.errors[0].message, /403/); assert.equal(denied.state.recovered, 0); denied.recovery.dispose();
});

test('runtime pause stops delivery until a new coherent snapshot completes', async () => {
  globalThis.fetch = async () => response(snapshot('A', 1)); const { recovery, state } = recorder();
  await recovery.start('t'); recovery.pause(); recovery.consume(frame(2, 'B'));
  assert.equal(state.appends.length, 0); assert.equal(state.paused, 2);
  globalThis.fetch = async () => response(snapshot('AB', 2)); await recovery.start('t'); recovery.consume(frame(3, 'C'));
  assert.deepEqual(state.replacements.map(value => value.data), ['A','AB']); assert.deepEqual(state.appends.map(value => value.data), ['C']); recovery.dispose();
});
