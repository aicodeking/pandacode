import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapMedianCi, claudeArgs, launchEnv, SUITES, suiteParts, describe as stats, leadInstructions, mcpReply, MCP_TOOLS, pairOrders, parseArgs,
  rssKibToMib, rustFnStr, rustStr, scrub, summarize, treeRssMib, unescapeRust,
} from './warm-spare-bench.mjs';

test('parseArgs reads --pairs, --out and --suites and rejects bad input', () => {
  assert.deepEqual(parseArgs([]), { pairs: 12, out: null, suites: ['default-minimal', 'default-user', 'offline-minimal', 'offline-user'] });
  assert.deepEqual(parseArgs(['--pairs', '3', '--out', 'x.json', '--suites', 'offline-user,default-minimal']), { pairs: 3, out: 'x.json', suites: ['offline-user', 'default-minimal'] });
  assert.throws(() => parseArgs(['--suites', 'user']), /default-minimal/);
  assert.throws(() => parseArgs(['--pairs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--pairs', '2.5']), /positive integer/);
  assert.throws(() => parseArgs(['--out']), /needs a path/);
  assert.throws(() => parseArgs(['--suites', 'other']), /offline-user/);
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
});

test('Rust string helpers decode plain, raw and fn-body literals', () => {
  assert.equal(unescapeRust('a\\n\\"b\\\\'), 'a\n"b\\');
  const src = 'const A: &str = "x\\n\\"y\\"";\npub const B: &str = r#"\nraw "q"\n"#;\nfn instruction() -> &\'static str {\n    "\\n\\nhi"\n}';
  assert.equal(rustStr(src, 'A'), 'x\n"y"');
  assert.equal(rustStr(src, 'B'), '\nraw "q"\n');
  assert.equal(rustFnStr(src, 'instruction'), '\n\nhi');
  assert.throws(() => rustStr(src, 'C'), /C not found/);
});

test('leadInstructions assembles the lead text in app_instructions order', () => {
  const files = {
    'src-tauri/src/app_instructions.rs': ['TURN_ENDS', 'LOOK', 'EDIT_CLAUDE', 'RICH_QUESTIONS', 'GENERATIVE_UI', 'VISUAL_PROGRESS']
      .map(n => `const ${n}: &str = "${n === 'LOOK' ? '[{explore}]' : `[${n}]`}";`).join('\n'),
    'src-tauri/src/session_titles.rs': 'pub(crate) const GUIDANCE: &str = "[G]";',
    'src-tauri/src/run_script.rs': 'pub const INSTRUCTIONS: &str = r#"[R]"#;',
    'src-tauri/src/turn_changes/host.rs': 'pub(crate) fn instruction() -> &\'static str {\n    "[T]"\n}',
  };
  assert.equal(leadInstructions(path => files[path]), '[G][R][T][TURN_ENDS][pandacode_explore][EDIT_CLAUDE][RICH_QUESTIONS][GENERATIVE_UI][VISUAL_PROGRESS]');
});

test('leadInstructions from the repository is the recorded lead size', () => {
  // docs/worker-tokens.md: lead 6,325 B (local macOS Claude, explore on, agent-made tools off).
  assert.equal(Buffer.byteLength(leadInstructions(), 'utf8'), 6325);
});

test('pairOrders is seeded, interleaved and balanced enough', () => {
  const a = pairOrders(12, 7);
  assert.deepEqual(a, pairOrders(12, 7));
  assert.equal(a.length, 12);
  for (const order of a) assert.deepEqual([...order].sort(), ['cold', 'warm']);
  const coldFirst = pairOrders(200, 1).filter(o => o[0] === 'cold').length;
  assert.ok(coldFirst > 70 && coldFirst < 130, `cold first ${coldFirst}/200`);
});

test('describe drops nulls and rounds', () => {
  assert.deepEqual(stats([3, null, 1, 2.04]), { n: 3, median: 2, mean: 2, min: 1, max: 3 });
  assert.deepEqual(stats([null]), { n: 0, median: null, mean: null, min: null, max: null });
});

test('bootstrapMedianCi brackets the median and is deterministic', () => {
  const values = [5, 6, 7, 8, 9, 10, 11];
  const [lo, hi] = bootstrapMedianCi(values, 2000, 3);
  assert.ok(lo <= 8 && hi >= 8);
  assert.deepEqual(bootstrapMedianCi(values, 2000, 3), [lo, hi]);
});

const row = (pair, arm, result, exit, extra = {}) => ({ pair, arm, warmup: pair === 0, init_ms: result / 2, result_ms: result, exit_after_result_ms: exit, exit_code: 0, rss_mib: arm === 'warm' ? 200 + pair : null, tree_rss_mib: arm === 'warm' ? 210 + pair : null, error: null, ...extra });

test('summarize pairs cold and warm, drops warmup and counts exits', () => {
  const runs = [row(0, 'cold', 9999, 9999), row(0, 'warm', 1, 1)];
  for (let p = 1; p <= 6; p++) runs.push(row(p, 'cold', 300 + p, 20), row(p, 'warm', 50, p === 6 ? 3500 : 10));
  const s = summarize(runs);
  assert.equal(s.runs, 12);
  assert.equal(s.errors, 0);
  assert.equal(s.exit_code_0, '12/12');
  assert.equal(s.cold.result_ms.median, 303.5);
  assert.equal(s.warm.result_ms.median, 50);
  assert.equal(s.warm.idle_rss_mib.min, 201);
  assert.equal(s.warm.idle_tree_rss_mib.max, 216);
  assert.equal(s.saving_result_ms.pairs, 6);
  assert.equal(s.saving_result_ms.median, 253.5);
  assert.equal(s.saving_result_ms.warm_faster, '6/6');
  assert.equal(s.saving_result_ms.wilcoxon_p, 0.03125); // exact, 6 pairs all one sign
  assert.ok(s.saving_result_ms.median_ci95[0] <= 253.5 && s.saving_result_ms.median_ci95[1] >= 253.5);
  assert.equal(s.exited_within_wait, '11/12');
  assert.equal(s.exit_after_result_ms.max, 3500);
});

test('summarize counts errors and leaves incomplete pairs out of the savings', () => {
  const runs = [row(1, 'cold', 300, 20), row(1, 'warm', 50, 10, { error: 'timed out', result_ms: null, exit_code: null }), row(2, 'cold', 310, 20), row(2, 'warm', 60, 10)];
  const s = summarize(runs);
  assert.equal(s.errors, 1);
  assert.equal(s.exit_code_0, '3/4');
  assert.equal(s.saving_result_ms.pairs, 1);
  assert.equal(s.saving_result_ms.median, 250);
  assert.equal(summarize([row(1, 'cold', 300, 20)]).saving_result_ms, null);
});

test('RSS helpers convert KiB and sum a process tree', () => {
  assert.equal(rssKibToMib(' 204800\n'), 200);
  assert.equal(rssKibToMib(''), null);
  const ps = '  10 1 102400\n  11 10 10240\n  12 11 1024\n  13 1 999999\n  14 14 5\n';
  assert.equal(treeRssMib(ps, 10), 111);
  assert.equal(treeRssMib(ps, 14), 0); // a self-parented row does not loop
  assert.equal(treeRssMib(ps, 99), null);
});

test('MCP stub answers like the app host: initialize, tools/list, notifications', () => {
  const init = mcpReply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'pandacode_architect');
  assert.deepEqual(mcpReply({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map(t => t.name), ['pandacode_explore', 'pandacode_track_files', 'pandacode_title']);
  assert.equal(mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(mcpReply({ jsonrpc: '2.0', id: 3, method: 'nope' }).error.code, -32601);
  for (const tool of MCP_TOOLS) assert.equal(tool.inputSchema.type, 'object');
});

test('claudeArgs carries PandaCode flags and only the minimal suite isolates settings', () => {
  const user = claudeArgs({ instructions: 'I', mcpConfig: '{}', minimal: false });
  const minimal = claudeArgs({ instructions: 'I', mcpConfig: '{}', minimal: true });
  for (const flag of ['--replay-user-messages', '--include-partial-messages', '--no-session-persistence', '--disallowedTools=ScheduleWakeup,Monitor,CronCreate', '--allow-dangerously-skip-permissions']) assert.ok(user.includes(flag), flag);
  assert.equal(user[user.indexOf('--model') + 1], 'sonnet');
  assert.equal(user[user.indexOf('--append-system-prompt') + 1], 'I');
  assert.ok(!user.includes('--strict-mcp-config') && !user.includes('--setting-sources'));
  assert.ok(minimal.includes('--strict-mcp-config'));
  assert.equal(minimal[minimal.indexOf('--setting-sources') + 1], 'project');
});

test('scrub removes the home directory', () => {
  assert.equal(scrub('/home/a/x and /home/a/y', '/home/a'), '~/x and ~/y');
  assert.equal(scrub('none', undefined), 'none');
});

test('suiteParts splits each suite into launch env and config', () => {
  assert.deepEqual(SUITES.map(suiteParts), [
    { env: 'default', offline: false, minimal: true }, { env: 'default', offline: false, minimal: false },
    { env: 'offline', offline: true, minimal: true }, { env: 'offline', offline: true, minimal: false },
  ]);
  assert.throws(() => suiteParts('minimal'), /unknown suite/);
});

test('launchEnv adds the non-essential-traffic switch only offline and drops session variables', () => {
  const parent = { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDECODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const online = launchEnv(4321, false, parent);
  assert.deepEqual(online, { PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321', ANTHROPIC_API_KEY: 'sk-ant-bench-dummy' });
  const offline = launchEnv(4321, true, parent);
  assert.equal(offline.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(offline.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(offline.CLAUDECODE, undefined);
});
