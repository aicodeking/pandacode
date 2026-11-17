import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { DecisionFold, action, type Outcome } from '../src/extensions/runtime-hook-decisions';
import { report as coverageReport } from '../src/extensions/runtime-harness-coverage';
import type { Json } from '../src/extensions/runtime-hook-payload';

// R1204: the Command guard (sample.guard). PREVIEW/NODE column: the shipped lib/analyzer.mjs and lib/guard.mjs run here against a
// stand-in `panda` (hooks, commands, events, ui, settings, harnesses) and an in-memory `io`; the host's own resolution of a
// tool.before return is the R0505 twin (DecisionFold, action) and the capability matrix is the R0509 twin. Nothing here is the
// installed package: main.cjs, the real approval path and a real or scripted harness are the native and installed columns, which
// are prepared in tests/fixtures/extensions/example-guard/ (scenarios.json, evidence-columns.json) and not run.
// Companion-specific coverage (R0601 to R0606) is pending: companions were deferred by the user's decision of 2026-11-17, so the
// default-mode coverage below is the one R0509 reports for a permission request (askedCalls, escalationsOnly or none).
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const manifest = readJson('examples/extensions/guard/package/extension.json') as { id: string; name: string; permissions: string[]; runtime: Record<string, unknown>; contributes: Record<string, Record<string, unknown>[]> };
const table = readJson('tests/fixtures/extensions/example-guard/commands.json') as {
  posix: Record<string, unknown>; windows: Record<string, unknown>; policy: { rules: unknown[] };
  cases: { command: string; expect: 'allow' | 'deny'; rule?: string; rewritable?: boolean; levels?: string[]; reasonIncludes?: string; policy?: boolean; world?: string }[];
  paths: { tool: string; path: string; expect: string; rule?: string }[];
};
const OWNER = 'sample.guard';
const NAME = 'Command guard';
const GRANTS = ['harness.hooks.decide', 'ui.presentation'];
type Obj = Record<string, unknown>;
const asObj = (value: unknown) => value as Obj | null;
const json = (value: unknown) => value as Json;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Handler = (payload: Obj) => unknown;
async function boot(over: { settings?: Obj; files?: Record<string, string> } = {}) {
  const analyzer = await import('../examples/extensions/guard/package/lib/analyzer.mjs');
  const logic = await import('../examples/extensions/guard/package/lib/guard.mjs');
  const hooks = new Map<string, Handler>(), commands = new Map<string, Handler>(), events = new Map<string, Handler>(), stops: (() => void)[] = [];
  const updates: [string, Obj][] = [], views: [string, Obj][] = [], notices: Obj[] = [], dialogs: Obj[] = [], queue: Obj[] = [];
  const files = new Map<string, string>(Object.entries(over.files ?? {}));
  const settings: Obj = { level: 'standard', rules: '[]', ...(over.settings ?? {}) };
  const roster = [
    { id: 'opencode', name: 'OpenCode', package: null, installed: 'Installed' as const },
    { id: 'codex', name: 'Codex', package: null, installed: 'Installed' as const },
  ];
  const panda = {
    hooks: { on: (event: string, handler: Handler) => { hooks.set(event, handler); return { dispose: () => { hooks.delete(event); } }; } },
    commands: { register: (id: string, handler: Handler) => { commands.set(id, handler); return { dispose: () => { commands.delete(id); } }; } },
    events: { on: (kind: string, handler: Handler) => { events.set(kind, handler); return { dispose: () => { events.delete(kind); } }; } },
    ui: {
      update: (id: string, value: Obj) => { updates.push([id, value]); },
      updateView: (id: string, value: Obj) => { views.push([id, value]); },
      notify: (notice: Obj) => { notices.push(notice); },
      showDialog: async (dialog: Obj) => { dialogs.push(dialog); return queue.shift() ?? { status: 'confirmed', values: {} }; },
    },
    settings: { get: async () => ({ values: { ...settings }, revision: 'r1' }) },
    harnesses: { list: async (options: { harness: string }) => coverageReport(roster, null, options.harness) },
  };
  const lifetime = { onStop: (fn: () => void) => { stops.push(fn); }, setStatus: () => undefined };
  const io = {
    home: '/home/dev', temp: ['/tmp', '/var/tmp'], now: () => new Date(Date.UTC(2026, 10, 17, 12, 0, 0)), testCommands: true,
    dataDir: async () => '/data',
    readText: async (file: string) => files.get(file) ?? null,
    appendLine: async (file: string, line: string) => { files.set(file, `${files.get(file) ?? ''}${line}\n`); },
  };
  const guard = await logic.run(panda as never, lifetime as never, io as never);
  const call = (command: string | null, extra: Obj = {}): Obj => ({
    schemaVersion: 1, callId: 'call-1', taskId: 't1', projectId: 'p1', projectRoot: '/work/project', cwd: '/work/project', harness: 'opencode', mode: 'ask',
    source: 'permissionRequest', coverage: 'askedCalls', tool: { kind: 'shell', name: 'Bash' }, input: command === null ? {} : { command }, inputComplete: true,
    can: ['approve', 'deny', 'ask', 'rewriteInput'], ...extra,
  });
  const before = (payload: Obj) => hooks.get('tool.before')!(payload);
  const status = () => asObj([...updates].reverse().find(([id]) => id === 'sample.guard/level')?.[1]);
  const rows = () => (asObj([...views].reverse().find(([id]) => id === 'sample.guard/log')?.[1])?.controls as { rows: string[][] }[])[0].rows;
  const audit = () => files.get('/data/audit.jsonl') ?? '';
  return { analyzer, logic, guard, hooks, commands, events, stops, updates, views, notices, dialogs, queue, files, settings, call, before, status, rows, audit };
}
type Rig = Awaited<ReturnType<typeof boot>>;

/** What the host does with one package's return, through the R0505 twin: the fold, then the action on the harness. */
function host(can: string[], answers: { answer: { value: Json } | { error: string }; onFailure?: string; owner?: string; name?: string; grants?: string[] }[]) {
  const fold = new DecisionFold(can);
  for (const entry of answers) fold.step({ owner: entry.owner ?? OWNER, name: entry.name ?? NAME, onFailure: entry.onFailure ?? 'ask', grants: entry.grants ?? GRANTS, answer: entry.answer });
  const outcome: Outcome = fold.outcome();
  return { fold, outcome, act: action(outcome, false, false), receipts: fold.settled() };
}
const verdictOf = (rig: Rig, command: string, level = 'standard', world = 'posix', rules: unknown[] = []) => {
  const base = (world === 'windows' ? table.windows : table.posix) as Obj;
  return rig.analyzer.analyze(command, { ...base, level, rules, escapes: world !== 'windows' } as never) as { verdict: string; rule: string | null; reason: string; rewritable: boolean; steps: string[] };
};

test('command guard preview: the package is a valid service package with hooks, no panel and no companion', () => {
  expect(validateContract('packages', [manifest] as never).ok).toBe(true);
  expect(manifest.id).toBe(OWNER);
  expect(manifest.name).toBe(NAME);
  expect(manifest.permissions).toEqual(['ui.contribute', 'runtime.service', 'events.workspace', 'harness.hooks.observe', 'harness.hooks.decide', 'ui.dynamic', 'ui.notify', 'ui.presentation', 'harnesses.inventory', 'storage.private']);
  // No panel is required: no rich view, no panel permission, the table is host-rendered.
  expect(manifest.permissions).not.toContain('ui.richViews');
  expect(JSON.stringify(manifest.contributes.views)).not.toContain('"rich"');
  expect(manifest.contributes.hooks.map(hook => [hook.id, hook.event, hook.onFailure])).toEqual([['sample.guard/before', 'tool.before', 'ask'], ['sample.guard/after', 'tool.after', 'continue']]);
  expect(manifest.runtime).toMatchObject({ kind: 'node', entrypoint: 'main.cjs', files: ['lib'], service: { start: 'onEnable' } });
  // The shipped signals of the tool row name the deciding package; labels fit the 24 character cap.
  const signals = (manifest.contributes.toolRows[0].signals as { label: string; when: string }[]);
  expect(signals.map(signal => signal.when)).toEqual(['hook-deny', 'hook-rewrite']);
  for (const signal of signals) expect(signal.label.length).toBeLessThanOrEqual(24);
  // Browser-safe logic: the analyser imports nothing; the service imports only the analyser.
  const analyser = read('examples/extensions/guard/package/lib/analyzer.mjs'), service = read('examples/extensions/guard/package/lib/guard.mjs');
  expect(analyser).not.toMatch(/\b(?:import|require)\b\s*[(\s'"{]/);
  expect(service).not.toMatch(/\bprocess\b|node:|child_process|\beval\b|new Function|\brequire\b/);
  expect([...service.matchAll(/\bimport\s*\{[^}]*\}\s*from\s*'([^']+)'/g)].map(match => match[1])).toEqual(['./analyzer.mjs']);
  const main = read('examples/extensions/guard/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:fs', 'node:os', 'node:path']);
  expect([...main.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['./lib/guard.mjs']);
  // The guard never approves: no `approve` decision anywhere in its logic.
  expect(service).not.toContain("decision: 'approve'");
});

test('command guard preview: the analyser table (at least 60 commands, every level it names, both shells)', async () => {
  const rig = await boot();
  expect(table.cases.length).toBeGreaterThanOrEqual(60);
  const rules = (rig.analyzer.readPolicy(JSON.stringify(table.policy)) as { rules: unknown[] }).rules;
  for (const entry of table.cases) {
    for (const level of entry.levels ?? ['standard']) {
      const result = verdictOf(rig, entry.command, level, entry.world ?? 'posix', entry.policy === true ? rules : []);
      const label = `${level}: ${entry.command}`;
      expect(result.verdict, label).toBe(entry.expect);
      if (entry.rule) expect(result.rule, label).toBe(entry.rule);
      if (entry.reasonIncludes) expect(result.reason, label).toContain(entry.reasonIncludes);
      if (entry.rewritable !== undefined) expect(result.rewritable, label).toBe(entry.rewritable);
    }
  }
  for (const entry of table.paths) {
    const hit = rig.analyzer.checkWritePath(entry.path, { ...table.posix, level: 'standard' } as never) as { rule: string } | null;
    expect(hit?.rule ?? 'allow', entry.path).toBe(entry.expect === 'allow' ? 'allow' : entry.rule);
  }
});

test('command guard preview: a refusal reaches the agent with the reason and the rule id, and the package is named', async () => {
  const rig = await boot();
  const answer = await rig.before(rig.call('git reset --hard'));
  expect(answer).toMatchObject({ decision: 'deny' });
  const reason = String(asObj(answer)?.reason);
  expect(reason).toContain('git.reset-hard');
  expect(reason).toContain('git reset --hard');
  const { act, outcome, receipts } = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { value: json(answer) } }]);
  expect(outcome).toMatchObject({ kind: 'deny', by: { owner: OWNER, name: NAME } });
  expect(act).toMatchObject({ kind: 'deny', answer: { approved: false, decidedBy: OWNER, reason } });
  expect(receipts).toEqual([{ owner: OWNER, applied: true }]);
  // The audit file and the log table carry the same decision, newest first, with the rule.
  expect(JSON.parse(rig.audit().trim().split('\n')[0])).toMatchObject({ verdict: 'deny', rule: 'git.reset-hard', command: 'git reset --hard' });
  expect(rig.rows()[0].slice(1)).toEqual(['deny', 'git.reset-hard', 'git reset --hard']);
});

test('command guard preview: permitted work continues, and the guard never approves', async () => {
  const rig = await boot();
  for (const command of ['git status', 'npm test', 'rm -rf ./build', 'rm -rf /tmp/x']) {
    const answer = await rig.before(rig.call(command));
    expect(answer ?? null, command).toBeNull();
    const { outcome, act } = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { value: json(answer ?? null) } }]);
    expect(outcome, command).toEqual({ kind: 'none' });
    expect(act, command).toEqual({ kind: 'prompt', note: null });
  }
  // A read, a search and an unknown kind are not its business.
  for (const kind of ['read', 'search', 'fetch', 'other']) expect(await rig.before(rig.call('rm -rf ~', { tool: { kind, name: 'X' } })) ?? null).toBeNull();
  expect(rig.audit()).not.toContain('"approve"');
});

test('command guard preview: a plain force push is rewritten to force-with-lease with both versions shown, where the call allows it', async () => {
  const rig = await boot();
  const answer = asObj(await rig.before(rig.call('git push --force origin main')));
  expect(answer).toMatchObject({ decision: 'rewrite', input: { command: 'git push --force-with-lease origin main' } });
  const note = String(answer?.note);
  expect(note).toContain('git push --force origin main');
  expect(note).toContain('git push --force-with-lease origin main');
  expect(note).not.toContain('\n');
  expect(new TextEncoder().encode(note).length).toBeLessThanOrEqual(512);
  const { outcome, act } = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { value: json(answer) } }]);
  expect(outcome).toMatchObject({ kind: 'approve', input: { command: 'git push --force-with-lease origin main' } });
  expect(act).toMatchObject({ kind: 'approve', answer: { approved: true, decidedBy: OWNER, input: { command: 'git push --force-with-lease origin main' } } });
  expect(rig.rows()[0][1]).toBe('rewrite');
  expect(JSON.parse(rig.audit().trim().split('\n')[0])).toMatchObject({ verdict: 'rewrite', original: 'git push --force origin main', rewritten: 'git push --force-with-lease origin main' });
  // Where the harness cannot run new arguments (`can` has no rewriteInput) the same call is denied with the reason, never run as written.
  const plain = await boot();
  const refused = asObj(await plain.before(plain.call('git push --force origin main', { can: ['approve', 'deny', 'ask'] })));
  expect(refused).toMatchObject({ decision: 'deny' });
  expect(String(refused?.reason)).toContain('git.push-force');
  // A wrapped force push is not rewritten: it is denied (the arguments of a shell string are not edited).
  expect(asObj(await plain.before(plain.call('sh -c "git push --force origin main"')))).toMatchObject({ decision: 'deny' });
  // The rewrite is a decision of this package only, and a deny of another package overrides it with the winner named.
  const both = host(['approve', 'deny', 'ask', 'rewriteInput'], [
    { answer: { value: json(answer) } },
    { owner: 'sample.other', name: 'Other', answer: { value: { decision: 'deny', reason: 'no pushes today' } } },
  ]);
  expect(both.outcome).toMatchObject({ kind: 'deny', by: { owner: 'sample.other' } });
  expect(both.receipts[0]).toMatchObject({ owner: OWNER, applied: false, overriddenBy: 'sample.other' });
});

test('command guard preview: a handler that throws or is slow leaves the normal prompt and is never approved by accident', async () => {
  const rig = await boot();
  // The slow command: the handler is still working when the host\'s budget (2 s in the manifest) would end; its late answer is never applied.
  const slow = Promise.resolve(rig.before(rig.call('guard-test sleep 0.3')));
  expect(await Promise.race([slow, wait(50).then(() => 'pending')])).toBe('pending');
  const timedOut = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { error: 'Timeout' }, onFailure: 'ask' }]);
  expect(timedOut.outcome).toMatchObject({ kind: 'ask', by: { owner: OWNER, failed: true } });
  expect(timedOut.act).toEqual({ kind: 'prompt', note: 'Command guard did not answer (Timeout). Decide yourself.' });
  expect(timedOut.outcome.kind).not.toBe('approve');
  expect(await slow).toBeNull();
  // The throwing command: the same prompt, with the code of the failure.
  await expect(Promise.resolve(rig.before(rig.call('guard-test throw')))).rejects.toThrow('InvalidShape');
  const failed = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { error: 'InvalidShape' }, onFailure: 'ask' }]);
  expect(failed.act).toEqual({ kind: 'prompt', note: 'Command guard did not answer (InvalidShape). Decide yourself.' });
  // The agent is never blocked: the next call is still judged.
  expect(await rig.before(rig.call('git reset --hard'))).toMatchObject({ decision: 'deny' });
});

test('command guard preview: the level, the custom rules and the project policy change the next verdict without a restart', async () => {
  const rig = await boot();
  expect(asObj(await rig.before(rig.call('rm -rf ./build')) ?? null)).toBeNull();
  rig.settings.level = 'paranoid';
  rig.events.get('settings.changed')!({});
  await expect.poll(() => String(rig.status()?.text), { timeout: 2000 }).toContain('paranoid');
  expect(asObj(await rig.before(rig.call('rm -rf ./build')))).toMatchObject({ decision: 'deny' });
  // A custom rule from the settings page.
  rig.settings.level = 'standard';
  rig.settings.rules = JSON.stringify(table.policy.rules);
  rig.events.get('settings.changed')!({});
  await expect.poll(() => String(rig.status()?.text), { timeout: 2000 }).toContain('standard');
  expect(asObj(await rig.before(rig.call('terraform destroy')))).toMatchObject({ decision: 'deny' });
  expect(String(asObj(await rig.before(rig.call('terraform destroy')))?.reason)).toContain('Destroying infrastructure needs a person.');
  // A project policy file can raise the level but never lower it.
  const raised = await boot({ files: { '/work/project/.sample-guard/policy.json': JSON.stringify({ level: 'paranoid' }) } });
  expect(asObj(await raised.before(raised.call('rm -rf ./build')))).toMatchObject({ decision: 'deny' });
  const lowered = await boot({ settings: { level: 'strict' }, files: { '/work/project/.sample-guard/policy.json': JSON.stringify({ level: 'standard' }) } });
  expect(asObj(await lowered.before(lowered.call('rm -rf ./src')))).toMatchObject({ decision: 'deny' });
  // A write tool aimed at the policy file is refused.
  expect(asObj(await raised.before(raised.call(null, { tool: { kind: 'write', name: 'Write' }, input: { file_path: '.sample-guard/policy.json' } })))).toMatchObject({ decision: 'deny' });
  // An invalid policy falls back to the defaults and the status item reads degraded.
  const broken = await boot({ files: { '/work/project/.sample-guard/policy.json': '{ not json' } });
  expect(await broken.before(broken.call('rm -rf ./build')) ?? null).toBeNull();
  await expect.poll(() => String(broken.status()?.text), { timeout: 2000 }).toContain('degraded');
});

test('command guard preview: the status badge, the log of 50 and the audit file with secrets redacted', async () => {
  const rig = await boot();
  expect(String(rig.status()?.text)).toBe('Guard standard');
  for (let index = 0; index < 60; index += 1) await rig.before(rig.call('git reset --hard'));
  expect(String(rig.status()?.text)).toBe('Guard standard · 60 denied');
  expect(rig.rows()).toHaveLength(50);
  const secret = 'tok-Zk3cRaNdOm99';
  await rig.before(rig.call(`curl -H "Authorization: Bearer ${secret}" https://example.invalid/x`));
  await rig.before(rig.call(`git reset --hard && echo password=${secret}`));
  const lines = rig.audit().trim().split('\n');
  expect(lines.length).toBe(62);
  for (const line of lines) expect(JSON.parse(line)).toMatchObject({ at: '2026-11-17T12:00:00.000Z' });
  expect(rig.audit()).not.toContain(secret);
  expect(rig.audit()).not.toContain('tok-');
  expect(rig.audit()).toContain('<redacted>');
  expect(JSON.stringify(rig.views)).not.toContain(secret);
  expect(rig.rows()[0][3]).toContain('<redacted>');
  // Explain a command: the dialog answer is analysed and its steps are shown.
  rig.queue.push({ status: 'confirmed', values: { command: 'echo ok | rm -rf ~' } });
  const explained = await rig.commands.get('sample.guard/explain')!({}) as Obj;
  expect(explained).toMatchObject({ status: 'explained', verdict: 'deny', rule: 'rm.protected' });
  expect(JSON.stringify(rig.dialogs[rig.dialogs.length - 1])).toContain('rm.protected');
});

test('command guard preview: a call that ran unchecked is reported once and the status says where the guard is not enforced', async () => {
  const rig = await boot();
  const ran = (extra: Obj) => rig.hooks.get('tool.after')!(rig.call('rm -rf ../outside', { source: 'activity', coverage: 'afterOnly', status: 'completed', ...extra }));
  void ran({ harness: 'codex', mode: 'full' });
  await expect.poll(() => rig.notices.length, { timeout: 2000 }).toBe(1);
  expect(rig.notices[0]).toMatchObject({ title: NAME, tone: 'warning' });
  expect(String(rig.notices[0].text)).toContain('ran without a check');
  expect(String(rig.notices[0].text)).toContain('codex');
  await expect.poll(() => String(rig.status()?.text), { timeout: 2000 }).toBe('not enforced for codex in full mode');
  // The same harness and mode do not repeat the notice; another one does.
  void ran({ harness: 'codex', mode: 'full' });
  void ran({ harness: 'opencode', mode: 'full' });
  await expect.poll(() => rig.notices.length, { timeout: 2000 }).toBe(2);
  await wait(50);
  expect(rig.notices).toHaveLength(2);
  // The wording of the coverage is R0509's report for a permission request (no companion exists in this run).
  const cell = (id: string, mode: string) => ((coverageReport([{ id, name: id, package: null, installed: 'Installed' }], null, id).harnesses as Obj[])[0].hooks as { toolBefore: Record<string, { coverage: string }> }).toolBefore[mode].coverage;
  expect(cell('codex', 'full')).toBe('none');
  expect(cell('codex', 'ask')).toBe('escalationsOnly');
  expect(cell('opencode', 'ask')).toBe('askedCalls');
  expect(String(rig.notices[0].text)).not.toContain('every call');
});

test('command guard preview: disable, revoke and safe mode remove the hooks and ordinary agent flow continues, with no panel', async () => {
  const rig = await boot();
  expect([...rig.hooks.keys()].sort()).toEqual(['tool.after', 'tool.before']);
  expect(rig.commands.has('sample.guard/explain')).toBe(true);
  // The service stops (disable, revoked grant, safe mode, quit): the host removes it, which disposes both hooks and the command.
  for (const stop of rig.stops) stop();
  expect(rig.hooks.size).toBe(0);
  expect(rig.commands.size).toBe(0);
  expect(rig.events.size).toBe(0);
  // With nothing attached no decider is asked: the call takes exactly the path it took without the package.
  const none = host(['approve', 'deny', 'ask', 'rewriteInput'], []);
  expect(none.outcome).toEqual({ kind: 'none' });
  expect(none.act).toEqual({ kind: 'prompt', note: null });
  // A decision returned without the grant is refused: PermissionDenied, and the call still takes the normal prompt.
  const revoked = host(['approve', 'deny', 'ask', 'rewriteInput'], [{ answer: { value: { decision: 'deny', reason: 'x' } }, grants: [] }]);
  expect(revoked.outcome).toEqual({ kind: 'none' });
  expect(revoked.receipts[0]).toMatchObject({ applied: false, code: 'PermissionDenied' });
});

test('command guard preview: the scripted fake-agent scenarios and the evidence columns are prepared, not claimed', () => {
  const scenarios = readJson('tests/fixtures/extensions/example-guard/scenarios.json') as { label: string; scenarios: { id: string; behavior: number; script: Obj[]; expect: Obj }[] };
  const allowed = ['say', 'tool', 'question', 'listTools', 'callTool', 'echoPrompt', 'usage', 'compact', 'sleep', 'fail'];
  expect(scenarios.label).toContain('synthetic');
  expect(scenarios.scenarios.map(scenario => scenario.id)).toEqual(['denied', 'permitted', 'rewritten', 'slow', 'unchecked']);
  for (const scenario of scenarios.scenarios) for (const step of scenario.script) expect(Object.keys(step).filter(key => allowed.includes(key)), scenario.id).toHaveLength(1);
  const columns = readJson('tests/fixtures/extensions/example-guard/evidence-columns.json') as { columns: { id: string; state: string; port?: number }[]; companions: { state: string; reason: string } };
  expect(columns.columns.map(column => column.id)).toEqual(['preview-chromium', 'preview-webkit', 'native', 'installed-windows']);
  for (const column of columns.columns) expect(column.state).toBe('prepared, not run (deferred to the final test phase)');
  expect(columns.companions.state).toBe('pending — companions deferred (user decision 2026-11-17)');
});
