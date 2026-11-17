import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';
import { HookPayloads, type Json } from '../src/extensions/runtime-hook-payload';
import { modeHolds } from '../src/extensions/runtime-hook-decisions';
import { checkHookDeclarations, DELIVERED, HookRegistry, RUN_KINDS, type Declaration, type Occurrence, type RunFacts } from '../src/extensions/runtime-hook-registration';
import {
  BUILT_INS, COVERAGES, INSTALLED_QUALIFIED, PATHS, QUALIFICATIONS, RECORDED, SOURCES, TRIGGERS, Tally, classify, feedMirror, mirrorRun, readOptions, report, roster, row,
  type Harness, type LaunchOrigin,
} from '../src/extensions/runtime-harness-coverage';
// Preview column of R0509 (run coverage and harness capabilities). The browser preview runs no harness, so this spec
// runs in the test runner's Node: it checks the webview twin (src/extensions/runtime-harness-coverage.ts) of the
// native rules (src-tauri/src/extensions/runtime_harness_coverage.rs) against the shared fixtures, which the native
// tests read too: the expected capability matrix, one scenario per traced launch path, the desktop's view of a task
// on another computer (approvals and tool rows mirrored, no companion), and the counters the report must show after
// them. It also drives the fixture service (main.cjs) through a stand-in of the service SDK. No real harness runs.
const fixtures = new URL('./fixtures/extensions/runtime-harness-coverage/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const matrix = read('matrix.json');
const script = read('scenarios.json');
const manifest = read('extension.json');
const OWNER = 'sample.coverage-reader';
type Obj = Record<string, any>;

const harness = (id: string): Harness => id.includes('/') ? { id, name: 'Fake agent', package: 'fake.agent', installed: 'Installed' } : { id, name: id, package: null, installed: 'Unknown' };

function noBlanketBoolean(value: unknown, path: string): void {
  if (typeof value === 'boolean') { expect(['toolServers.value', 'rewriteInput', 'hooks.toolAfter.inputComplete'], `bare boolean at ${path}`).toContain(path); return; }
  if (Array.isArray(value)) { value.forEach(item => noBlanketBoolean(item, path)); return; }
  if (value === null || typeof value !== 'object') return;
  const fields = value as Obj;
  if ('qualification' in fields) expect(QUALIFICATIONS as readonly string[], path).toContain(fields.qualification);
  if ('coverage' in fields) expect(COVERAGES as readonly string[], path).toContain(fields.coverage);
  if (typeof fields.source === 'string') expect([...SOURCES, 'host'], path).toContain(fields.source);
  for (const [key, item] of Object.entries(fields)) noBlanketBoolean(item, path ? `${path}.${key}` : key);
}

test('extensions harness coverage: every harness row agrees with the expected matrix', () => {
  expect(Object.keys(matrix.harnesses)).toEqual(expect.arrayContaining(BUILT_INS.map(([id]) => id)));
  for (const [id, want] of Object.entries(matrix.harnesses as Record<string, Obj>)) {
    const shown = row(harness(id)) as Obj;
    expect([...shown.modes].sort(), `${id} modes`).toEqual(Object.keys(want.before).sort());
    for (const [mode, coverage] of Object.entries(want.before as Record<string, string>)) {
      const cell = shown.hooks.toolBefore[mode];
      expect(cell.coverage, `${id} ${mode}`).toBe(coverage);
      expect(cell.qualification, `${id} ${mode}`).toBe(coverage === 'none' ? 'unsupported' : want.request);
      // R0505: the delivered `can` stays inside what the source carries, without approve where the mode or sandbox holds it.
      expect((cell.can as string[]).every(entry => (cell.sourceCan as string[]).includes(entry)), `${id} ${mode}: can within sourceCan`).toBe(true);
      if (modeHolds(id, mode)) expect(cell.can, `${id} ${mode}: held by the mode`).not.toContain('approve');
      expect(cell.feasible.some((item: Obj) => item.source === 'companion' && item.coverage === 'everyCall'), `${id} ${mode} companion`).toBe(want.companion === 'sourceFeasible');
      const ask = cell.feasible.find((item: Obj) => item.source === 'askAtHost');
      if (mode === 'full' && want.before.full !== 'askedCalls') expect(ask?.coverage ?? null, `${id} askAtHost`).toBe(want.askAtHost);
      else expect(ask, `${id} ${mode}`).toBeUndefined();
    }
    expect(shown.companion.state, id).toBe(want.companion);
    expect(shown.hooks.toolAfter.inputComplete, id).toBe(want.inputComplete);
    expect(shown.toolServers.value, id).toBe(want.toolServers);
    expect(shown.compact.how, id).toBe(want.compact);
    expect(shown.hooks.compaction.phase, id).toBe(want.compaction);
    expect(shown.hooks.toolAfter.feasible[0]?.rewriteResult ?? 'none', id).toBe(want.rewriteResult);
    expect([shown.denyReason, shown.rewriteInput, shown.evidence], id).toEqual([want.denyReason, want.rewriteInput, want.evidence]);
  }
});

test('extensions harness coverage: cells are qualified, never blanket booleans, and nothing claims an installed qualification', () => {
  for (const id of Object.keys(matrix.harnesses)) {
    const shown = row(harness(id)) as Obj;
    noBlanketBoolean(shown, '');
    for (const mode of shown.modes) expect(typeof shown.hooks.toolBefore[mode].qualification, `${id} ${mode}`).toBe('string');
    expect(JSON.stringify(shown), `${id}: no authorized capture exists`).not.toContain('installedQualified');
    for (const hook of ['toolAfter', 'promptSubmit', 'turn', 'compaction']) expect(typeof shown.hooks[hook].qualification, `${id} ${hook}`).toBe('string');
  }
  expect(matrix.installedQualified).toEqual([]);
  expect(INSTALLED_QUALIFIED).toEqual([]);
  // Coverage is per mode and per source: Codex, Devin, Muse and DeepSeek ask only about part of what they do.
  expect(new Set(['codex', 'devin', 'muse', 'deepseek'].flatMap(id => Object.values((row(harness(id)) as Obj).hooks.toolBefore).map((cell: any) => cell.coverage)))).toContain('escalationsOnly');
});

test('extensions harness coverage: every traced launch path classifies its run as the scenario expects', () => {
  for (const scenario of script.scenarios as Obj[]) {
    expect(classify(scenario.facts, scenario.origin as LaunchOrigin | null), scenario.id).toEqual(scenario.expect);
    const traced = (report([], null, null) as Obj).runs.find((entry: Obj) => entry.kind === scenario.expect.kind);
    expect(traced.paths.some((path: Obj) => path.launch === scenario.seam && path.trigger === scenario.expect.trigger), `${scenario.id} is traced`).toBe(true);
  }
  expect(mirrorRun(script.mirror.host)).toEqual(script.mirror.expect);
  expect((report([], null, null) as Obj).runs.map((entry: Obj) => entry.kind)).toEqual([...RUN_KINDS]);
  for (const path of PATHS) expect(TRIGGERS as readonly string[]).toContain(path.trigger);
  // Every launch path a scenario names is one PATHS lists, and no traced path is left without a scenario.
  const seams = new Set([...(script.scenarios as Obj[]).map(scenario => `${scenario.expect.kind}:${scenario.seam}:${scenario.expect.trigger}`), 'remote:mirrorSend:mirror']);
  expect(new Set(PATHS.map(path => `${path.kind}:${path.launch}:${path.trigger}`))).toEqual(seams);
});

/** The native registry calls its observer for every occurrence it publishes; the twin is counted the same way here. */
class CountingRegistry extends HookRegistry {
  private readonly tally: Tally;
  constructor(tally: Tally) { super(() => 0); this.tally = tally; }
  override publish(occurrence: Occurrence) { this.tally.observe(occurrence); return super.publish(occurrence); }
}
function counting(tally: Tally) {
  const registry = new CountingRegistry(tally);
  registry.setGate((_owner, _version, permission) => permission === 'harness.hooks.observe');
  const seen: Obj[] = [];
  registry.setDeliver((_owner, frame) => { seen.push(frame); return null; });
  const checked = checkHookDeclarations(manifest);
  if (!checked.ok) throw new Error(checked.refusal.code);
  const declared: Declaration[] = [...checked.declarations];
  for (const event of DELIVERED) if (!declared.some(item => item.event === event)) declared.push({ id: `${OWNER}/${event}`, event, onFailure: 'continue', budgetMs: 2000, match: {} });
  for (const declaration of declared) expect(typeof registry.register(OWNER, '1.0.0', declared, declaration.event)).toBe('object');
  return { registry, seen };
}
const turn = (task: string, run: Obj, text: string): RunFacts => ({ taskId: task, projectId: 'A', projectRoot: '/work/A', cwd: '/work/A', harness: 'fake.agent/agent', model: null, mode: 'ask', run, index: 1, text, attachments: [], startedBy: 'user', transcriptCursor: 0 });

test('extensions harness coverage: one scenario per run kind and the mirrored task match the report counters', () => {
  const tally = new Tally();
  const book = new HookPayloads();
  const payload = (base: Obj, callId: string) => book.hookCall(base as any, callId) as any;
  const { registry, seen } = counting(tally);
  (script.scenarios as Obj[]).forEach((scenario, index) => {
    const task = `r0509-${index}-${scenario.id}`;
    const run = classify(scenario.facts, scenario.origin);
    tally.launch(run);
    registry.turnStarted(turn(task, run, 'go'));
    const { callId } = book.record(task, 'A', 'c1', { command: 'ls' });
    registry.toolBefore(task, callId, callId, 'Bash', 'r1', payload);
    registry.toolAfter(task, callId, callId, 'Bash', 'completed', 'a.ts', payload);
    registry.turnEnded(task, true, null);
  });
  // The desktop's view of a task that runs on another computer: sent from here, decided there, no companion.
  const local = `r0509-${script.mirror.task}`;
  const events = (script.mirror.events as Obj[]).map(event => event.sessionId === script.mirror.task ? { ...event, sessionId: local } : event);
  const sent = turn(local, mirrorRun(script.mirror.host), 'go');
  tally.launch(sent.run);
  registry.turnStarted(sent);
  seen.length = 0;
  feedMirror(registry, book, events, () => null, run => tally.launch(run));
  registry.turnEnded(local, true, null);
  expect(seen.map(frame => frame.event)).toEqual(['tool.before', 'tool.after', 'compaction', 'turn.finish', 'task.idle']);
  const before = seen[0].payload;
  expect([before.source, before.coverage, before.run.kind, before.run.hostId, before.requestId, before.input]).toEqual(['permissionRequest', 'askedCalls', 'remote', script.mirror.host, 'run:r9', { command: 'ls' }]);
  expect([seen[1].payload.source, seen[1].payload.coverage]).toEqual(['activity', 'afterOnly']);
  expect(seen.every(frame => frame.payload.taskId !== 't-other'), 'a task not mirrored here starts nothing').toBe(true);

  const counted = tally.json();
  for (const [kind, want] of Object.entries(script.counters)) expect(counted[kind], kind).toEqual(want);
  const shown = report([harness('claude')], counted, null) as Obj;
  for (const entry of shown.runs as Obj[]) expect(entry.counters, entry.kind).toEqual(script.counters[entry.kind]);
  const mirrored = (shown.runs as Obj[]).find(entry => entry.kind === 'remote')!.paths.find((path: Obj) => path.trigger === 'mirror');
  expect(mirrored.toolBefore).toEqual({ source: 'permissionRequest', companions: 'unavailable' });
  expect(mirrored.delivered).toEqual([...DELIVERED]);
});

test('extensions harness coverage: list options are strict and the report filters by harness', () => {
  expect(readOptions({})).toEqual({ harness: null });
  expect(readOptions({ includeModels: false, harness: 'codex' })).toEqual({ harness: 'codex' });
  expect(readOptions({ includeModels: true })).toBe('UnsupportedCapability');
  for (const bad of [null, [], { harness: 3 }, { harness: '' }, { other: 1 }, { includeModels: 'no' }] as Json[]) expect(readOptions(bad), JSON.stringify(bad)).toBe('InvalidShape');
  const snapshot = { safeMode: false, packages: [
    { enabled: true, executable: { trusted: true }, manifest: { id: 'fake.agent', contributes: { providers: [{ id: 'fake.agent/agent', name: 'Fake agent' }] } } },
    { enabled: false, executable: { trusted: true }, manifest: { id: 'off.agent', contributes: { providers: [{ id: 'off.agent/agent', name: 'Off' }] } } },
  ] };
  const harnesses = roster(snapshot as Obj as any, id => id === 'claude');
  expect(harnesses.length).toBe(BUILT_INS.length + 1);
  expect(harnesses.find(item => item.id === 'claude')!.installed).toBe('Installed');
  expect(harnesses.find(item => item.id === 'codex')!.installed).toBe('Absent');
  expect(harnesses.find(item => item.id === 'fake.agent/agent')!.package).toBe('fake.agent');
  expect(roster({ safeMode: true, packages: snapshot.packages } as any, () => false).length).toBe(BUILT_INS.length);
  const only = report(harnesses, null, 'fake.agent/agent') as Obj;
  expect(only.harnesses.length).toBe(1);
  expect([only.harnesses[0].kind, only.harnesses[0].owner, only.decisions]).toEqual(['package', 'fake.agent', 'delivered']);
});

test('extensions harness coverage: the twin and the native table name the same roster and recorded harnesses', () => {
  const providers = source('src-tauri/src/providers.rs');
  const block = providers.slice(providers.indexOf('pub(crate) const PROVIDERS'), providers.indexOf('];', providers.indexOf('pub(crate) const PROVIDERS')));
  const native = [...block.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(match => [match[1], match[2]]);
  expect(native).toEqual(BUILT_INS.map(([id, name]) => [id, name]));
  const coverage = source('src-tauri/src/extensions/runtime_harness_coverage.rs');
  const recorded = coverage.match(/pub const RECORDED: \[&str; \d+\] = \[([^\]]+)\]/)![1].match(/"([^"]+)"/g)!.map(item => item.slice(1, -1));
  expect(recorded).toEqual(RECORDED);
  const paths = [...coverage.matchAll(/Path \{ kind: "([^"]+)", trigger: "([^"]+)", launch: "([^"]+)", events: "([^"]+)", companions: "([^"]+)" \}/g)].map(match => match.slice(1));
  expect(paths).toEqual(PATHS.map(path => [path.kind, path.trigger, path.launch, path.events, path.companions]));
});

test('extensions harness coverage: the fixture service reads the report per mode and sees each run it observes', async () => {
  expect((validateContract('packages', [manifest]) as any).ok).toBe(true);
  const tally = new Tally();
  const { registry } = counting(tally);
  const book = new HookPayloads();
  const handlers = new Map<string, Set<(payload: Json) => unknown>>();
  registry.setDeliver((_owner, frame) => { for (const handler of handlers.get(frame.event as string) ?? []) void handler(frame.payload as Json); return null; });
  const harnesses = roster({ safeMode: false, packages: [] } as any, () => false);
  let control: ((context: Obj) => Promise<any>) | null = null;
  const panda = {
    harnesses: {
      list: async (options?: Json) => {
        const read = readOptions(options ?? {});
        if (typeof read === 'string') throw Object.assign(new Error(read), { code: read });
        return report(harnesses, tally.json(), read.harness);
      },
    },
    hooks: {
      on(event: string, handler: (payload: Json) => unknown) {
        const set = handlers.get(event) ?? new Set(); handlers.set(event, set); set.add(handler);
        return { ready: Promise.resolve(), dispose: () => { set.delete(handler); } };
      },
    },
    commands: { register: (_id: string, handler: (context: Obj) => Promise<any>) => { control = handler; return { dispose() {} }; } },
  };
  const service = createRequire(import.meta.url)(fileURLToPath(new URL('main.cjs', fixtures)));
  await service.service(panda, { onStop: () => ({ dispose() {} }) });
  const status = await control!({ args: { op: 'status' } });
  expect(status.codex.ask).toEqual({ coverage: 'escalationsOnly', qualification: 'recorded', label: 'checked before sandbox escalations only' });
  expect(status.codex.full).toEqual({ coverage: 'none', qualification: 'unsupported', label: 'not enforced in this mode (seen after it ran)' });
  expect(status.claude.ask.label).toBe('checked before the calls the harness asks about');
  expect(status.opencode.ask.qualification).toBe('sourceFeasible');
  const refused = await control!({ args: { op: 'report', options: { includeModels: true } } });
  expect(refused.error).toBe('UnsupportedCapability');
  const one = await control!({ args: { op: 'report', options: { harness: 'kimi' } } });
  expect(one.report.harnesses.map((item: Obj) => item.id)).toEqual(['kimi']);

  const run = classify({ executor: 'desktop', bot: 'bot-1' }, { schedule: { schedule: 's-9' } });
  registry.turnStarted(turn('t-bot', run, 'hello'));
  const { callId } = book.record('t-bot', 'A', 'c1', { command: 'ls' });
  registry.toolBefore('t-bot', callId, callId, 'Bash', 'r1', (base, id) => book.hookCall(base as any, id) as any);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await control!({ args: { op: 'runs' } })).toEqual([{ kind: 'bot', trigger: 'schedule', executor: 'desktop', botId: 'bot-1', scheduleId: 's-9' }]);
  expect(await control!({ args: { op: 'calls' } })).toEqual([{ event: 'tool.before', source: 'permissionRequest', coverage: 'askedCalls' }]);
});
