// Batch G1 (gui.mjs): arm launches against the cited launch code, the T3 stand-in, and the analysis.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARMS, EDIT_PASS_MARGIN, PANDA_SERVE_TEST, analyze, mobileProject, pandaStubCalls, armLaunch, armMessage, loadGui, pairs, pandaInstructions, pandaSources, plan, ratioOfMeans, rustConst, t3Flags, t3StubReply } from './gui.mjs';
import { REPO, exploreClause, measuredRun, pool } from './lib.mjs';
import { armFlag, newLists } from './s3.mjs';
import { metrics } from './metrics.mjs';

test('G1-3: quota and unbilled or empty output stop scheduling, measured task failures do not', async () => {
  const { runBlocker } = await import('./gui.mjs');
  assert.equal(typeof runBlocker, 'function');
  const good = { billedUsd: 0.1, tokens: { output: 100 }, steps: 2, exitCode: 0, success: false };
  assert.equal(runBlocker(good, ''), null, 'a failed task grade is still a valid measurement');
  for (const billedUsd of [0, undefined, NaN]) assert.match(runBlocker({ ...good, billedUsd }, ''), /billing/);
  assert.match(runBlocker({ ...good, tokens: { output: 0 } }, ''), /empty/);
  assert.match(runBlocker({ ...good, steps: 0 }, ''), /empty/);
  assert.equal(runBlocker({ ...good, timedOut: true }, ''), null);
  assert.equal(runBlocker({ ...good, exitCode: 1 }, ''), null);
  for (const error of ['rate_limit_error', 'quota exceeded', "You've hit your limit", 'Insufficient credits']) {
    const text = JSON.stringify({ type: 'result', is_error: true, errors: [error], total_cost_usd: 0, usage: {} });
    assert.match(runBlocker({ ...good, ...metrics(text), billedUsd: 0 }, text), /quota|rate limit/);
  }
  assert.equal(runBlocker({ ...good, isError: true, subtype: 'error_max_budget_usd' }, ''), null);
  assert.equal(runBlocker(good, JSON.stringify({ type: 'result', is_error: false, result: 'The quota parser is fixed.' })), null);
  assert.equal(runBlocker(good, JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', errors: ['Maximum budget exceeded'], result: 'Edited quota parser.' })), null);
  assert.equal(runBlocker(good, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'quota exceeded in a test fixture' }] } })), null);
  assert.match(runBlocker(good, JSON.stringify({ type: 'result', is_error: false, result: "You've hit your limit · resets 4pm" })), /quota|rate limit/);
  assert.match(runBlocker({ ...good, invalid: 'quota or rate limit' }, ''), /quota|rate limit/);
});

test('G1-2: the analyzer refuses invalid harness attempts before exporting performance results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g1-invalid-'));
  try {
    const run = join(dir, 'runs', 'G1', 'invalid');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'run.json'), JSON.stringify({ billedUsd: 0.1, tokens: { output: 100 }, steps: 2, invalid: 'quota or rate limit' }));
    const summary = join(dir, 'summary.json');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./gui.mjs', import.meta.url)), '--analyze', '--out', dir, '--summary', summary], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid harness attempts/);
    assert.equal(existsSync(summary), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G1-4: the real pool preserves completed and in-flight records and stops after a blocker', async () => {
  const { runBlocker } = await import('./gui.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'g1-pool-'));
  const exitCode = process.exitCode;
  try {
    const batchDir = join(dir, 'G1');
    mkdirSync(batchDir);
    let aborted = null;
    const started = [];
    const report = await pool([0, 1, 2], {
      limit: 2, batchDir, out: dir, ledger: join(dir, 'ledger.jsonl'), minFreeGiB: 6, budget: 150,
      cap: () => 3, diskNeed: () => 0, free: () => 100, aborted: () => aborted,
      runOne: async id => {
        started.push(id);
        const record = id ? { billedUsd: 0.1, tokens: { output: 100 }, steps: 1, success: true } : {};
        const result = await measuredRun({ runDir: join(batchDir, String(id)), ledger: join(dir, 'ledger.jsonl'), workRoot: join(dir, 'work'), batch: 'G1', id: String(id), capUsd: 3, record, body: async () => {
          await new Promise(resolve => setTimeout(resolve, id ? 10 : 1));
          if (!id) throw new Error('setup failed before any model call');
        } });
        aborted ??= runBlocker(result, '');
        return result;
      },
    });
    assert.deepEqual(started, [0, 1]);
    assert.match(report.stoppedBy, /billing/);
    assert.equal(report.remaining.length, 1);
    assert.ok(existsSync(join(batchDir, '0', 'run.json')) && existsSync(join(batchDir, '1', 'run.json')));
    assert.equal(existsSync(join(batchDir, '2', 'run.json')), false);
  } finally { process.exitCode = exitCode; rmSync(dir, { recursive: true, force: true }); }
});

const { gui, tasks } = loadGui();
const t3 = gui.t3;
const texts = { panda: pandaInstructions(pandaSources()), worker: pandaInstructions(pandaSources(), { worker: true }), report: 'REPORT' };
const launch = (arm, extra = {}) => armLaunch(arm, { model: 'sonnet', cap: 3, cwd: '/w', mcp: '{"mcpServers":{"x":{}}}', texts, t3, lists: newLists(), ...extra });
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('the T3 snapshot is the one T3 Code measures (agentContextBudget.json at the pinned commit)', () => {
  assert.equal(t3.commit, '25bf84ab07f53f141c20239c63e383823a9d5ea0');
  assert.equal(Buffer.byteLength(t3.systemAppend), 5366);
  const listed = t3.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  assert.equal(Buffer.byteLength(JSON.stringify(listed)), 48119);
  assert.equal(t3.tools.length, 71);
  // AgentContextBudget.test.ts: only request_secret is loaded up front.
  assert.deepEqual(t3.tools.filter(t => t._meta?.['anthropic/alwaysLoad']).map(t => t.name), ['request_secret']);
  assert.match(t3.systemAppend, /^<runtime_info>In case you're asked: you are running in T3 Code through the Claude Code harness\./);
  assert.match(t3.systemAppend, /## T3 Code orchestration/);
  assert.match(t3.systemAppend, /t3_background_wait/);
  assert.equal(t3.mcpServerName, 't3-code');
});

test('T3 flags map its query options as the Agent SDK does (ClaudeAdapterV2.ts makeClaudeQueryOptions, sdk.mjs)', () => {
  const o = t3.queryOptions;
  assert.equal(o.permissionMode, 'default', 'the snapshot is the Default mode; full access maps to bypassPermissions (lines 2806-2830)');
  assert.deepEqual(o.tools, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(o.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(o.effort, 'high');
  assert.equal(o.settingSources, undefined, 'T3 leaves setting sources to the CLI default');
  assert.deepEqual(t3Flags(o, '/w'), ['--thinking=adaptive', '--thinking-display=summarized', '--effort=high', '--tools=default', '--include-partial-messages', '--add-dir=/w', '--settings={"showThinkingSummaries":true}']);
});

test('arm launches: PLAIN is bare, T3 carries its append, MCP and SDK entrypoint', () => {
  const plain = launch('PLAIN');
  assert.ok(plain.argv.includes('--dangerously-skip-permissions'));
  assert.ok(!plain.argv.includes('--append-system-prompt') && !plain.argv.includes('--effort'));
  assert.equal(valueOf(plain.argv, '--mcp-config'), '{"mcpServers":{}}');
  assert.deepEqual(plain.env, {});
  const t = launch('T3');
  assert.equal(valueOf(t.argv, '--append-system-prompt'), t3.systemAppend);
  assert.equal(valueOf(t.argv, '--permission-mode'), 'bypassPermissions');
  assert.ok(t.argv.includes('--allow-dangerously-skip-permissions') && t.argv.includes('--effort=high'));
  assert.equal(t.argv.filter(a => a.startsWith('--thinking-display')).length, 1);
  assert.deepEqual(t.env, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
  // Every arm shares the house flags, in the same order.
  for (const arm of [...ARMS, 'PANDA_W']) assert.deepEqual(launch(arm).argv.slice(0, 12), plain.argv.slice(0, 12), arm);
});

test('PANDA mirrors configure_command and app_instructions for a Full access plain task', () => {
  const providers = readFileSync(join(REPO, 'src-tauri/src/providers.rs'), 'utf8');
  for (const flag of ['"--include-partial-messages"', '"--replay-user-messages"', '"full" => "bypassPermissions"', '"--allow-dangerously-skip-permissions"', '"--append-system-prompt"']) assert.ok(providers.includes(flag), flag);
  const p = launch('PANDA');
  assert.ok(p.argv.includes(`--disallowedTools=${rustConst(providers, 'CLAUDE_SESSION_BOUND_TOOLS')}`));
  assert.equal(valueOf(p.argv, '--permission-mode'), 'bypassPermissions');
  assert.equal(valueOf(p.argv, '--append-system-prompt'), texts.panda);
  const lib = readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8');
  assert.ok(texts.panda.startsWith('\n\nSidebar titles:'));
  assert.ok(texts.panda.includes(exploreClause()) && texts.panda.includes(rustConst(lib, 'SAVE')) && !texts.panda.includes('Project tools note'));
  assert.ok(texts.panda.endsWith(rustConst(lib, 'VISUAL_PROGRESS')));
  assert.ok(texts.panda.includes('pandacode-run.sh') && texts.panda.includes('pandacode_track_files'));
});

test('PANDA_W is round 18 worker launch: worker text, S3 NEW lists, report sentence first', () => {
  assert.ok(texts.worker.startsWith('\n\nFile change tracking') && texts.worker.includes(exploreClause()) && !texts.worker.includes('Sidebar titles'));
  assert.ok(launch('PANDA_W', { worker: 'ro' }).argv.includes(armFlag('NEW', 'ro', newLists())));
  assert.equal(armMessage('PANDA_W', 'task', 'REPORT'), 'REPORT\n\ntask');
  assert.equal(armMessage('T3', 'task', 'REPORT'), 'task');
});

test('the T3 stand-in lists the snapshot and refuses every call', async () => {
  const tools = t3.tools.slice(0, 3);
  assert.deepEqual(t3StubReply({ id: 1, method: 'tools/list' }, tools).result.tools, tools);
  assert.equal(t3StubReply({ id: 2, method: 'tools/call', params: { name: 'x' } }, tools).result.isError, true);
  assert.equal(t3StubReply({ method: 'notifications/initialized' }, tools), null);
  assert.equal(t3StubReply({ id: 3, method: 'resources/list' }, tools).error.code, -32601);
  // End to end over stdio, as Claude Code starts it.
  const dir = mkdtempSync(join(tmpdir(), 'gui-stub-'));
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(tools));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gui.mjs', import.meta.url)), '--t3-stub', join(dir, 'tools.json')], { env: { ...process.env, T3_STUB_LOG: join(dir, 'calls.jsonl') } });
  const replies = [];
  const done = new Promise(resolve => child.stdout.on('data', d => { replies.push(...String(d).trim().split('\n').map(l => JSON.parse(l))); if (replies.length >= 3) resolve(); }));
  for (const m of [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_task' } }]) child.stdin.write(`${JSON.stringify(m)}\n`);
  await done;
  child.kill();
  assert.equal(replies[0].result.serverInfo.name, 'T3 Code');
  assert.equal(replies[1].result.tools.length, 3);
  assert.equal(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim(), '{"name":"delegate_task"}');
});

test('tasks: 20 tuned localization, 6 edits, 14 edit2; the plan counts runs', () => {
  assert.equal(tasks.length, 40);
  assert.equal(new Set(tasks.map(t => t.id)).size, 40);
  const p = plan(tasks, [1, 2, 3], ARMS);
  assert.deepEqual(p.bySet, { loc: 20, edit: 6, edit2: 14 });
  assert.equal(p.runs, 360);
  assert.ok(p.estimateUsd > 60 && p.estimateUsd < 90);
});

const fake = ({ tasks: n = 16, factor = { T3: 1.2, PANDA: 0.8, PANDA_W: 0.9 } } = {}) => {
  const runs = [];
  for (let i = 0; i < n; i++) for (const arm of ['PLAIN', 'T3', 'PANDA', 'PANDA_W']) for (const seed of [1, 2, 3]) {
    const f = arm === 'PLAIN' ? 1 : factor[arm];
    const noise = 1 + 0.05 * Math.sin(i * 7 + seed * 3 + arm.length);
    const set = i % 2 ? 'loc' : 'edit2';
    runs.push({ arm, seed, task: `t${i}`, set, steps: (10 + i) * f * noise, billedUsd: 0.2 * (1 + i / 10) * f * noise, wallMs: 1000, grade: { recall: 1, precision: 0.8 }, success: true });
  }
  return runs;
};

test('analysis: log-ratio per task, Holm over the four primary tests, gates, worker arm descriptive', () => {
  const out = analyze(fake());
  const t = out.arms.T3.table.steps;
  assert.ok(Math.abs(t.change - 0.2) < 0.02 && t.read === 'higher' && t.pHolm >= t.p);
  assert.equal(out.arms.PANDA.table.billedUsd.read, 'lower');
  assert.ok(Math.abs(out.arms.PANDA.table.billedUsd.ratioOfMeans + 0.2) < 0.02 && out.arms.PANDA.table.billedUsd.absolute < 0);
  assert.equal(out.arms.T3.table.wallMs.read, 'descriptive');
  assert.equal(out.arms.PANDA_W.table.steps.read, 'descriptive');
  assert.equal(out.arms.PANDA_W.table.steps.pHolm, undefined);
  assert.equal(out.arms.PANDA.gates.recall.pass, true);
  assert.equal(out.arms.PANDA.gates.editPass.margin, EDIT_PASS_MARGIN);
  assert.equal(out.arms.PANDA_W.gates.recall.pass, undefined);
  // No effect: not shown either way.
  const none = analyze(fake({ factor: { T3: 1, PANDA: 1, PANDA_W: 1 } }));
  assert.match(none.arms.T3.table.steps.read, /^not shown/);
});

test('pairs and ratio of means use per-task means over seeds', () => {
  const runs = [{ arm: 'PLAIN', task: 'a', x: 1 }, { arm: 'PLAIN', task: 'a', x: 3 }, { arm: 'T3', task: 'a', x: 4 }, { arm: 'T3', task: 'b', x: 9 }];
  assert.deepEqual(pairs(runs, 'T3', r => r.x), [[2, 4]]);
  const r = ratioOfMeans([[2, 4], [2, 2]], { rounds: 200 });
  assert.equal(r.ratioOfMeans, 0.5);
  assert.equal(r.absolute, 1);
});

test('G1-1: PANDA serves the catalog test, sees mobile checkouts as the app does and counts stub calls once', () => {
  const rs = readFileSync(join(REPO, 'src-tauri/src/providers/mcp_host/tests.rs'), 'utf8');
  assert.ok(rs.includes(`async fn ${PANDA_SERVE_TEST.split('::').at(-1)}()`));
  const dir = mkdtempSync(join(tmpdir(), 'g1-mobile-'));
  assert.equal(mobileProject(dir), false);
  mkdirSync(join(dir, 'apps', 'phone'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'phone', 'app.json'), '{"expo":{}}');
  assert.equal(mobileProject(dir), true);
  rmSync(dir, { recursive: true, force: true });
  const use = (id, name) => `{"type":"tool_use","id":"${id}","name":"mcp__pandacode_architect__${name}"`;
  // Partial messages repeat each tool_use in a stream event: counted once, real tools never.
  assert.equal(pandaStubCalls([use('a', 'pandacode_design_list'), use('a', 'pandacode_design_list'), use('b', 'pandacode_track_files'), use('c', 'pandacode_explore')].join('\n')), 1);
});
