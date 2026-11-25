import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bootstrapMedianCi, cancellableDelay, claudeArgs, mirroredClaudeJson, seedArgs, SEED_PROMPT, SEED_TURNS, transcriptDigest, launchEnv, LAUNCH_ENVS, OFFLINE_ENV, PRIVACY_ENV, rustEnvTable, SUITES, suiteParts, describe as stats, leadInstructions, mcpReply, MCP_TOOLS, pairOrders, parseArgs,
  maxMessageCount, resumeCheckError, rssKibToMib, rustFnStr, rustStr, scrub, sessionTranscriptKey, summarize, treeRssMib, unescapeRust,
  anyOrphaned, matchingLivePids, MAX_PARK_MS, mcpConfigJson, parsePsArgs, PARK_MS, runOnce, INHERITED_ENV_KEYS, MAX_SEED_TURNS, reportEnv, runSeedTurns, serveStdioMcp, STDIO_MCP_TOOLS, STDIO_SERVE_FLAG, STDIO_SERVER_NAME, treeBreakdown,
} from './warm-spare-bench.mjs';

test('parseArgs reads --pairs, --out and --suites and rejects bad input', () => {
  assert.deepEqual(parseArgs([]), { pairs: 12, out: null, suites: ['default-minimal', 'default-user', 'privacy-minimal', 'privacy-user', 'offline-minimal', 'offline-user', 'default-resumed', 'privacy-resumed'], stdioMcp: false, parkMs: PARK_MS, seedTurns: SEED_TURNS });
  assert.deepEqual(parseArgs(['--suites', 'privacy-resumed,default-resumed']).suites, ['privacy-resumed', 'default-resumed']);
  assert.deepEqual(parseArgs(['--suites', 'privacy-user,privacy-minimal']).suites, ['privacy-user', 'privacy-minimal']);
  assert.deepEqual(parseArgs(['--pairs', '3', '--out', 'x.json', '--suites', 'offline-user,default-minimal']), { pairs: 3, out: 'x.json', suites: ['offline-user', 'default-minimal'], stdioMcp: false, parkMs: PARK_MS, seedTurns: SEED_TURNS });
  assert.equal(parseArgs(['--park-ms', '3500']).parkMs, 3500);
  assert.throws(() => parseArgs(['--park-ms', '0']), /--park-ms needs/);
  assert.throws(() => parseArgs(['--park-ms', 'x']), /--park-ms needs/);
  assert.equal(MAX_PARK_MS, 600_000, 'the park can span PandaCode\'s 10-minute warm spare IDLE window');
  assert.equal(parseArgs(['--park-ms', '600000']).parkMs, 600_000);
  assert.equal(parseArgs(['--park-ms', '60001']).parkMs, 60_001, 'the old 60 s cap is gone');
  assert.throws(() => parseArgs(['--park-ms', '600001']), /--park-ms needs an integer from 1 to 600000/);
  assert.equal(parseArgs(['--stdio-mcp', '--pairs', '5']).stdioMcp, true);
  assert.equal(parseArgs(['--pairs', '5', '--stdio-mcp']).pairs, 5);
  assert.throws(() => parseArgs(['--suites', 'user']), /default-minimal/);
  assert.throws(() => parseArgs(['--pairs', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--pairs', '2.5']), /positive integer/);
  assert.throws(() => parseArgs(['--out']), /needs a path/);
  assert.throws(() => parseArgs(['--suites', 'other']), /privacy-resumed/);
  assert.throws(() => parseArgs(['--suites', 'offline-resumed']), /--suites takes/);
  assert.throws(() => parseArgs(['--nope']), /unknown flag/);
});

test('parseArgs reads --seed-turns from 1 to MAX_SEED_TURNS and rejects anything else', () => {
  assert.equal(SEED_TURNS, 1);
  assert.equal(MAX_SEED_TURNS, 200);
  assert.equal(parseArgs([]).seedTurns, 1);
  assert.equal(parseArgs(['--seed-turns', '1']).seedTurns, 1);
  assert.equal(parseArgs(['--seed-turns', '50', '--suites', 'default-resumed']).seedTurns, 50);
  assert.equal(parseArgs(['--suites', 'privacy-resumed', '--seed-turns', '200']).seedTurns, 200);
  assert.deepEqual(parseArgs(['--seed-turns', '3', '--pairs', '2']).pairs, 2, 'the flag consumes exactly its value');
  for (const bad of ['0', '-1', '2.5', '201', '1e9', 'x', '', 'NaN', 'Infinity']) assert.throws(() => parseArgs(['--seed-turns', bad]), /--seed-turns needs an integer from 1 to 200/, bad);
  assert.throws(() => parseArgs(['--seed-turns']), /--seed-turns needs an integer from 1 to 200, got undefined/);
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
  assert.ok(!user.some(a => a.startsWith('--resume')) && !minimal.some(a => a.startsWith('--resume')));
});

test('claudeArgs resumes like providers.rs (--resume=<id>) and still keeps the transcript unwritten', () => {
  const args = claudeArgs({ instructions: 'I', mcpConfig: '{}', minimal: true, resume: 'abc-123' });
  assert.equal(args.filter(a => a.startsWith('--resume')).length, 1);
  assert.ok(args.includes('--resume=abc-123'));
  assert.ok(args.includes('--no-session-persistence'), 'every resumed run must leave the seed transcript byte-identical');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(claudeArgs({ instructions: 'I', mcpConfig: '{}', minimal: true }), claudeArgs({ instructions: 'I', mcpConfig: '{}', minimal: true, resume: null }));
});

test('seedArgs persists exactly one short exchange with the minimal config', () => {
  const args = seedArgs();
  assert.equal(SEED_TURNS, 1);
  assert.equal(args[args.indexOf('-p') + 1], SEED_PROMPT);
  assert.ok(!args.includes('--no-session-persistence'), 'the seed must be written so it can be resumed');
  assert.ok(!args.some(a => a.startsWith('--resume')));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('seedArgs resumes the previous seed turn only when asked, keeping the default launch unchanged', () => {
  assert.deepEqual(seedArgs(null), seedArgs());
  const args = seedArgs('abc-123');
  assert.deepEqual(args.filter(a => a.startsWith('--resume')), ['--resume=abc-123']);
  assert.deepEqual(args.filter(a => !a.startsWith('--resume')), seedArgs());
  assert.ok(!args.includes('--no-session-persistence'), 'follow-up seed turns must append to the transcript');
});

test('runSeedTurns runs each exchange in order, resuming the id the previous one returned', async () => {
  const calls = [];
  const last = await runSeedTurns(3, async resume => { calls.push(resume); return `s${calls.length}`; });
  assert.equal(last, 's3');
  assert.deepEqual(calls, [null, 's1', 's2']);
  const once = [];
  assert.equal(await runSeedTurns(SEED_TURNS, async resume => { once.push(resume); return 'only'; }), 'only');
  assert.deepEqual(once, [null], 'the default seeds exactly one fresh exchange');
  for (const bad of [0, -1, 1.5, NaN, '2']) await assert.rejects(runSeedTurns(bad, async () => 'x'), /positive integer/);
  let ran = 0;
  await assert.rejects(runSeedTurns(5, async () => { ran++; if (ran === 2) throw new Error('seed turn failed'); return 'x'; }), /seed turn failed/);
  assert.equal(ran, 2, 'a failed seed turn stops the sequence');
});

test('transcriptDigest hashes every .jsonl by relative path and sees any change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-spare-digest-'));
  try {
    assert.deepEqual(transcriptDigest(join(dir, 'missing')), {});
    mkdirSync(join(dir, 'proj-a'), { recursive: true });
    writeFileSync(join(dir, 'proj-a', 's1.jsonl'), '{"a":1}\n');
    writeFileSync(join(dir, 'proj-a', 'notes.txt'), 'x');
    const before = transcriptDigest(dir);
    assert.deepEqual(Object.keys(before), ['proj-a/s1.jsonl']);
    assert.match(before['proj-a/s1.jsonl'], /^[0-9a-f]{64}$/);
    assert.deepEqual(transcriptDigest(dir), before);
    writeFileSync(join(dir, 'proj-a', 's1.jsonl'), '{"a":1}\n{"b":2}\n');
    assert.notDeepEqual(transcriptDigest(dir), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('transcriptDigest keeps same-named transcripts in nested folders apart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-spare-digest-nested-'));
  try {
    mkdirSync(join(dir, 'proj-a', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'proj-b'), { recursive: true });
    writeFileSync(join(dir, 'proj-a', 's1.jsonl'), 'a');
    writeFileSync(join(dir, 'proj-a', 'sub', 's1.jsonl'), 'b');
    writeFileSync(join(dir, 'proj-b', 's1.jsonl'), 'c');
    writeFileSync(join(dir, 'top.jsonl'), 'd');
    const digest = transcriptDigest(dir);
    assert.deepEqual(Object.keys(digest), ['proj-a/s1.jsonl', 'proj-a/sub/s1.jsonl', 'proj-b/s1.jsonl', 'top.jsonl']);
    assert.equal(new Set(Object.values(digest)).size, 4);
    assert.ok(Object.keys(digest).every(k => !k.includes('\\')));
    assert.equal(sessionTranscriptKey(digest, 'top'), 'top.jsonl');
    assert.equal(sessionTranscriptKey({ 'proj-b/abc.jsonl': 'h' }, 'abc'), 'proj-b/abc.jsonl');
    assert.equal(sessionTranscriptKey({ 'proj-b/xabc.jsonl': 'h' }, 'abc'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resumeCheckError fails closed when the seed request was not captured', () => {
  for (const resumed of [0, 1, 5, 100]) assert.match(resumeCheckError(null, resumed), /seed request was not captured/);
  assert.match(resumeCheckError(undefined, 5), /not captured/);
  assert.match(resumeCheckError(3, 3), /resume not loaded/);
  assert.match(resumeCheckError(3, 2), /resume not loaded/);
  assert.match(resumeCheckError(3, undefined), /resume not loaded/);
  assert.equal(resumeCheckError(3, 5), null);
  assert.equal(resumeCheckError(0, 3), null);
  assert.match(resumeCheckError(0, 1), /resume incomplete/, 'one seeded exchange holds at least two messages');
});

test('resumeCheckError keeps the one-turn default and scales with --seed-turns', () => {
  // Recorded 1-turn run (warm-spare-2.1.325.json): seed request 2 messages, resumed 5.
  assert.equal(resumeCheckError(2, 5), null);
  assert.equal(resumeCheckError(2, 5, SEED_TURNS), resumeCheckError(2, 5));
  assert.match(resumeCheckError(2, 2, 1), /resume not loaded/);
  // Live --seed-turns 3 smoke (Claude Code 2.1.325, 2026-11-24): largest seed request 6, resumed 9 (2N and 2N + 3).
  assert.equal(resumeCheckError(6, 9, 3), null);
  assert.match(resumeCheckError(6, 6, 3), /resume not loaded/);
  assert.equal(resumeCheckError(100, 103, 50), null);
  assert.match(resumeCheckError(2, 5, 50), /resume incomplete: request held 5 messages, 50 seeded turns need more than 100/);
  assert.match(resumeCheckError(90, 100, 50), /resume incomplete/);
  assert.equal(resumeCheckError(90, 101, 50), null);
  assert.match(resumeCheckError(null, 155, 50), /not captured/);
});

test('maxMessageCount is the largest captured request, null when none was captured', () => {
  assert.equal(maxMessageCount([]), null);
  assert.equal(maxMessageCount([3]), 3);
  assert.equal(maxMessageCount([0]), 0);
  assert.equal(maxMessageCount([3, 5, 1]), 5, 'a smaller auxiliary request after the main one does not lower it');
  assert.equal(maxMessageCount([1, 3]), 3);
  const counts = [2, 4];
  maxMessageCount(counts);
  assert.deepEqual(counts, [2, 4], 'does not mutate its input');
});

test('a missing resumed capture fails the resume check through maxMessageCount', () => {
  assert.match(resumeCheckError(maxMessageCount([3, 1]), maxMessageCount([])), /resume not loaded/);
  assert.match(resumeCheckError(maxMessageCount([]), maxMessageCount([5])), /not captured/);
  assert.equal(resumeCheckError(maxMessageCount([3, 1]), maxMessageCount([5, 1])), null);
});

test('mirroredClaudeJson drops the projects map and tolerates bad input', () => {
  assert.deepEqual(mirroredClaudeJson(JSON.stringify({ projects: { '/x': {} }, hasCompletedOnboarding: true, cachedGrowthBookFeatures: { f: 1 } })), { hasCompletedOnboarding: true, cachedGrowthBookFeatures: { f: 1 } });
  assert.deepEqual(mirroredClaudeJson(''), {});
  assert.deepEqual(mirroredClaudeJson('[1]'), {});
  assert.deepEqual(mirroredClaudeJson('null'), {});
});

test('scrub removes the home directory', () => {
  assert.equal(scrub('/home/a/x and /home/a/y', '/home/a'), '~/x and ~/y');
  assert.equal(scrub('none', undefined), 'none');
});

test('suiteParts splits each suite into launch env and config', () => {
  assert.deepEqual(SUITES, ['default-minimal', 'default-user', 'privacy-minimal', 'privacy-user', 'offline-minimal', 'offline-user', 'default-resumed', 'privacy-resumed']);
  assert.deepEqual(SUITES.map(suiteParts), [
    { env: 'default', privacy: false, offline: false, minimal: true, resumed: false }, { env: 'default', privacy: false, offline: false, minimal: false, resumed: false },
    { env: 'privacy', privacy: true, offline: false, minimal: true, resumed: false }, { env: 'privacy', privacy: true, offline: false, minimal: false, resumed: false },
    { env: 'offline', privacy: false, offline: true, minimal: true, resumed: false }, { env: 'offline', privacy: false, offline: true, minimal: false, resumed: false },
    { env: 'default', privacy: false, offline: false, minimal: true, resumed: true }, { env: 'privacy', privacy: true, offline: false, minimal: true, resumed: true },
  ]);
  for (const s of SUITES) assert.ok(LAUNCH_ENVS.includes(suiteParts(s).env), s);
  assert.throws(() => suiteParts('minimal'), /unknown suite/);
  assert.throws(() => suiteParts('privacy-other'), /unknown suite/);
});

test('launchEnv adds the non-essential-traffic switch only offline and drops session variables', () => {
  const parent = { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDECODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
  const base = { PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321', ANTHROPIC_API_KEY: 'sk-ant-bench-dummy' };
  assert.deepEqual(launchEnv(4321, 'default', parent), base);
  const offline = launchEnv(4321, 'offline', parent);
  assert.deepEqual(offline, { ...base, ...OFFLINE_ENV });
  assert.equal(offline.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(offline.CLAUDECODE, undefined);
  assert.equal(offline.DISABLE_TELEMETRY, undefined);
  assert.throws(() => launchEnv(4321, true, parent), /unknown launch env/);
});

test('launchEnv forwards exactly INHERITED_ENV_KEYS from the parent and nothing else', () => {
  assert.ok(Object.isFrozen(INHERITED_ENV_KEYS));
  assert.deepEqual([...INHERITED_ENV_KEYS], ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
  const parent = Object.fromEntries(INHERITED_ENV_KEYS.map(k => [k, `v-${k}`]));
  Object.assign(parent, { NODE_OPTIONS: '--x', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'https://real', SSH_AUTH_SOCK: '/s', ARBITRARY_EXTRA: 'y', path: 'lower' });
  const env = launchEnv(4321, 'default', parent);
  const inherited = Object.keys(env).filter(k => k !== 'ANTHROPIC_BASE_URL' && k !== 'ANTHROPIC_API_KEY');
  assert.deepEqual(inherited, [...INHERITED_ENV_KEYS]);
  for (const k of INHERITED_ENV_KEYS) assert.equal(env[k], `v-${k}`, k);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-bench-dummy', 'a real key never reaches the child');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321');
  for (const k of ['NODE_OPTIONS', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK', 'ARBITRARY_EXTRA', 'path']) assert.equal(env[k], undefined, k);
  assert.deepEqual(Object.keys(launchEnv(4321, 'default', { PATH: '/bin' })), ['PATH', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'], 'unset keys are skipped, not forwarded as undefined');
});

test('the report env lists the same inherited keys launchEnv forwards', () => {
  const env = reportEnv();
  assert.equal(env.inherited, INHERITED_ENV_KEYS.join(', '));
  assert.deepEqual(env.inherited.split(', '), [...INHERITED_ENV_KEYS]);
  assert.equal(env.ANTHROPIC_API_KEY, launchEnv(1, 'default', {}).ANTHROPIC_API_KEY);
  assert.deepEqual(env.privacy_extra, { ...PRIVACY_ENV });
  assert.deepEqual(env.offline_extra, { ...OFFLINE_ENV });
});

test('launchEnv privacy adds exactly PandaCode\'s telemetry-off env and not the non-essential-traffic switch', () => {
  const env = launchEnv(4321, 'privacy', { PATH: '/bin', HOME: '/h', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321', ANTHROPIC_API_KEY: 'sk-ant-bench-dummy', ...PRIVACY_ENV });
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  for (const key of ['DO_NOT_TRACK', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY']) assert.equal(env[key], '1', key);
});

test('rustEnvTable reads a (&str, &str) table, skipping comments', () => {
  const src = 'const OTHER: &[(&str, &str)] = &[("X", "9")];\nconst ENVIRONMENT: &[(&str, &str)] = &[\n    // ("COMMENTED", "1"),\n    ("A", "1"), // trailing\n    ("B_C", "true"),\n];\n';
  assert.deepEqual(rustEnvTable(src, 'ENVIRONMENT'), [['A', '1'], ['B_C', 'true']]);
  assert.throws(() => rustEnvTable(src, 'MISSING'), /MISSING not found/);
});

test('PRIVACY_ENV matches providers/privacy.rs ENVIRONMENT exactly (drift guard)', () => {
  const source = readFileSync(new URL('../../src-tauri/src/providers/privacy.rs', import.meta.url), 'utf8');
  const table = rustEnvTable(source, 'ENVIRONMENT');
  assert.ok(table.length >= 4, `ENVIRONMENT parsed ${table.length} entries`);
  assert.deepEqual(Object.entries(PRIVACY_ENV), table, 'update PRIVACY_ENV in warm-spare-bench.mjs to match providers/privacy.rs, then rerun the benchmark');
  assert.ok(!('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in PRIVACY_ENV), 'privacy suites must stay distinct from offline');
  assert.ok(Object.isFrozen(PRIVACY_ENV));
});

test('recorded results cover every suite, carry the privacy env and no personal paths', () => {
  const text = readFileSync(new URL('./results/warm-spare-2.1.325.json', import.meta.url), 'utf8');
  assert.ok(!/\/Users\/|\/home\/[^/\s"]+\/|\/private\/var\/folders\/|\/var\/folders\//.test(text), 'results must not hold a home or temporary directory');
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(text), 'results must not hold an email address');
  const report = JSON.parse(text);
  assert.equal(report.benchmark, 'warm-spare-bench');
  assert.match(report.claude_version, /^2\.1\.325\b/);
  assert.deepEqual(Object.keys(report.summary), SUITES);
  assert.deepEqual(report.env.privacy_extra, { ...PRIVACY_ENV });
  assert.deepEqual(report.env.offline_extra, { ...OFFLINE_ENV });
  for (const suite of SUITES) {
    assert.deepEqual(report.suites[suite], suiteParts(suite), suite);
    const s = report.summary[suite];
    assert.equal(s.runs, report.pairs * 2, suite);
    assert.equal(s.saving_result_ms.pairs, report.pairs, suite);
    for (const key of ['median', 'mean', 'wilcoxon_p']) assert.equal(typeof s.saving_result_ms[key], 'number', `${suite} ${key}`);
    assert.equal(s.errors, 0, suite);
    assert.equal(s.exit_code_0, `${s.runs}/${s.runs}`, suite);
    assert.equal(s.exited_within_wait, `${s.runs}/${s.runs}`, suite);
    assert.equal(typeof s.warm.idle_rss_mib.median, 'number', suite);
  }
  const measured = report.runs.filter(r => !r.warmup);
  assert.equal(measured.length, SUITES.length * report.pairs * 2);
  assert.ok(measured.every(r => r.error === null && r.exit_code === 0), 'every measured run exits 0 without error');
  assert.deepEqual(report.resumed_extra_flags, ['--resume=<seed session id>']);
  assert.deepEqual(report.seed_flags, seedArgs());
  const resumed = SUITES.filter(s => suiteParts(s).resumed);
  assert.deepEqual(Object.keys(report.seeds), resumed);
  for (const suite of resumed) {
    const seed = report.seeds[suite];
    assert.equal(seed.turns, 1, suite);
    assert.equal(seed.prompt, SEED_PROMPT, suite);
    assert.equal(seed.transcript_unchanged, true, `${suite}: every run resumed the same byte-identical transcript`);
    assert.match(seed.transcript_sha256, /^[0-9a-f]{64}$/, suite);
    assert.deepEqual(seed.resumed_request_messages.length, 1, `${suite}: every run resumed the same history`);
    assert.ok(seed.resumed_request_messages[0] > seed.seed_request_messages, `${suite}: the resumed history reached the API`);
    for (const r of report.runs.filter(x => x.suite === suite)) assert.equal(r.api_messages, seed.resumed_request_messages[0], `${suite} pair ${r.pair} ${r.arm}`);
  }
  for (const r of report.runs.filter(x => !suiteParts(x.suite).resumed)) assert.equal(r.api_messages, undefined);
});

const openTimeouts = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

test('cancellableDelay resolves to its value and leaves no timer behind', async () => {
  const before = openTimeouts();
  const wait = cancellableDelay(1, 'late');
  assert.equal(openTimeouts(), before + 1);
  assert.equal(await wait.promise, 'late');
  assert.equal(openTimeouts(), before);
  wait.cancel(); // harmless after firing
  assert.equal(openTimeouts(), before);
});

test('cancellableDelay.cancel clears its timer when a race settles first, so the loop can exit', async () => {
  const before = openTimeouts();
  const wait = cancellableDelay(60_000, null);
  assert.equal(openTimeouts(), before + 1);
  let fired = false;
  wait.promise.then(() => { fired = true; });
  try { assert.equal(await Promise.race([Promise.resolve('exited'), wait.promise]), 'exited'); } finally { wait.cancel(); }
  assert.equal(openTimeouts(), before);
  wait.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fired, false);
});

const BENCH = fileURLToPath(new URL('./warm-spare-bench.mjs', import.meta.url));
const lines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
const HANDSHAKE = [
  { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.325' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
];

function assertHandshake(replies) {
  assert.equal(replies.length, 2, 'one reply per request, none for the notification');
  assert.deepEqual(replies.map(r => r.id), [0, 1]);
  assert.equal(replies[0].result.protocolVersion, '2025-11-25');
  assert.equal(replies[0].result.serverInfo.name, STDIO_SERVER_NAME);
  assert.deepEqual(replies[0].result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(replies[1].result.tools, STDIO_MCP_TOOLS);
}

test('serveStdioMcp answers initialize and tools/list, stays resident, and resolves on EOF with no timers left', async () => {
  const beforeTimers = openTimeouts();
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.setEncoding('utf8'); output.on('data', c => { text += c; });
  let settled = false;
  const served = serveStdioMcp(input, output).then(n => { settled = true; return n; });
  input.write(`${JSON.stringify(HANDSHAKE[0])}\n${JSON.stringify(HANDSHAKE[1])}\n`);
  input.write(JSON.stringify(HANDSHAKE[2]).slice(0, 10)); // a request split across chunks
  input.write(`${JSON.stringify(HANDSHAKE[2]).slice(10)}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'resident while stdin is open');
  assert.equal(openTimeouts(), beforeTimers, 'the server keeps no timers');
  input.end();
  assert.equal(await served, 3);
  assertHandshake(lines(text));
  assert.equal(output.listenerCount('error'), 0, 'the EPIPE guard is removed on exit');
  assert.equal(openTimeouts(), beforeTimers);
});

test('serveStdioMcp replies to parse errors and batches, ignores responses, and survives a closed output', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.setEncoding('utf8'); output.on('data', c => { text += c; });
  const served = serveStdioMcp(input, output);
  input.write('not json\n\n');
  input.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })}\n`); // a response from the client: no reply
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'resources/list' })}`); // final line without a newline
  await served;
  const replies = lines(text);
  assert.equal(replies[0].error.code, -32700);
  assert.deepEqual(replies[1], [{ jsonrpc: '2.0', id: 7, result: {} }]);
  assert.equal(replies[2].error.code, -32601);
  assert.equal(replies.length, 3);

  const lateIn = new PassThrough(); const lateOut = new PassThrough();
  const late = serveStdioMcp(lateIn, lateOut);
  lateOut.destroy();
  lateIn.end(`${JSON.stringify(HANDSHAKE[0])}\n`);
  await late; // no throw after the peer hung up
});

test('the bench script as a real stdio MCP child answers the handshake and exits 0 on stdin EOF', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [BENCH, STDIO_SERVE_FLAG], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', c => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
  const exited = once(child, 'exit');
  child.stdin.write(`${JSON.stringify(HANDSHAKE[0])}\n${JSON.stringify(HANDSHAKE[1])}\n`);
  // Wait for the initialize reply before tools/list, as a real client does.
  while (!stdout.includes('\n')) await once(child.stdout, 'data');
  child.stdin.write(`${JSON.stringify(HANDSHAKE[2])}\n`);
  while (stdout.split('\n').filter(Boolean).length < 2) await once(child.stdout, 'data');
  assert.equal(child.exitCode, null, 'resident while stdin is open');
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.stdin.end();
  const [code, signal] = await exited;
  clearTimeout(killer);
  assert.equal(signal, null, `exited by itself, stderr: ${stderr}`);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assertHandshake(lines(stdout));
});

test('mcpConfigJson adds the stdio server only with --stdio-mcp', () => {
  const http = JSON.parse(mcpConfigJson({ mcpPort: 4321, token: 't' }));
  assert.deepEqual(Object.keys(http.mcpServers), ['pandacode_architect']);
  assert.deepEqual(http.mcpServers.pandacode_architect, { type: 'http', url: 'http://127.0.0.1:4321/mcp', headers: { Authorization: 'Bearer t' } });
  const both = JSON.parse(mcpConfigJson({ mcpPort: 4321, token: 't', stdio: true, node: '/n', script: '/s.mjs' }));
  assert.deepEqual(both.mcpServers[STDIO_SERVER_NAME], { type: 'stdio', command: '/n', args: ['/s.mjs', STDIO_SERVE_FLAG], env: {} });
  assert.deepEqual(both.mcpServers.pandacode_architect, http.mcpServers.pandacode_architect);
});

test('treeBreakdown splits Claude, its stdio MCP child and other descendants', () => {
  const ps = [
    '  10     1 204800 claude -p --output-format stream-json',
    '  11    10  40960 /opt/node /x/warm-spare-bench.mjs --serve-stdio-mcp',
    '  12    10  10240 /bin/zsh -c something',
    '  13    12   1024 rg --files',
    '  14     1 999999 /opt/node /x/warm-spare-bench.mjs --serve-stdio-mcp',
    '  15    15      5 self-parented',
    'garbage line',
  ].join('\n');
  assert.equal(parsePsArgs(ps).length, 6);
  assert.deepEqual(parsePsArgs('  7 1 8')[0], { pid: 7, ppid: 1, kib: 8, args: '' });
  assert.deepEqual(treeBreakdown(ps, 10), { self_rss_mib: 200, tree_rss_mib: 251, child_count: 3, mcp_child_count: 1, mcp_child_rss_mib: 40, mcp_child_pids: [11], mcp_children: [{ pid: 11, args: '/opt/node /x/warm-spare-bench.mjs --serve-stdio-mcp' }] });
  assert.deepEqual(treeBreakdown(ps, 15), { self_rss_mib: 0, tree_rss_mib: 0, child_count: 0, mcp_child_count: 0, mcp_child_rss_mib: 0, mcp_child_pids: [], mcp_children: [] });
  assert.equal(treeBreakdown(ps, 99), null);
  assert.equal(treeBreakdown('  20 1 100 node --serve-stdio-mcpX\n  21 20 100 node x --serve-stdio-mcp-other', 20).mcp_child_count, 0, 'the marker matches a whole argument only');
});

test('summarize reports stdio MCP fields only when runs carry them', () => {
  const stdioRow = (pair, arm, extra = {}) => row(pair, arm, 300, 20, arm === 'warm' ? { self_rss_mib: 190 + pair, mcp_child_rss_mib: 40, child_count: 1, mcp_child_count: 1, mcp_child_orphaned: false, ...extra } : { mcp_child_orphaned: false });
  const runs = [1, 2, 3].flatMap(p => [stdioRow(p, 'cold'), stdioRow(p, 'warm', p === 3 ? { mcp_child_count: 0, mcp_child_rss_mib: 0, child_count: 0 } : {})]);
  const s = summarize(runs);
  assert.equal(s.warm.idle_self_rss_mib.median, 192);
  assert.equal(s.warm.idle_mcp_child_rss_mib.max, 40);
  assert.equal(s.warm.idle_child_count.min, 0);
  assert.equal(s.warm.mcp_child_seen, '2/3');
  assert.equal(s.warm.mcp_child_orphaned, 0);
  const plain = summarize([row(1, 'cold', 300, 20), row(1, 'warm', 50, 10)]);
  for (const key of ['idle_self_rss_mib', 'idle_mcp_child_rss_mib', 'idle_child_count', 'mcp_child_seen', 'mcp_child_orphaned']) assert.ok(!(key in plain.warm), key);
});

const MISSING = join(tmpdir(), 'warm-spare-bench-missing-claude', 'claude');

for (const arm of ['cold', 'warm']) {
  test(`runOnce records a spawn failure (ENOENT, ${arm}) instead of hanging, and leaves no timers or children`, { timeout: 10_000 }, async () => {
    const before = openTimeouts();
    const processes = () => process.getActiveResourcesInfo().filter(r => r === 'ProcessWrap').length;
    const processesBefore = processes();
    const started = performance.now();
    const out = await runOnce({ arm, args: [], env: process.env, cwd: tmpdir(), command: MISSING, parkMs: 30_000 });
    assert.ok(performance.now() - started < 5_000, 'settles on the spawn error, not the 30 s park or the 92 s result timeout');
    assert.match(out.error, /spawn failed: ENOENT/);
    assert.equal(out.result_ms, null);
    assert.equal(out.exit_code, null);
    assert.equal(openTimeouts(), before, 'the result timeout (and any park timer) was cleared');
    // libuv closes the failed process handle asynchronously; it must go within a moment.
    for (let i = 0; i < 100 && processes() > processesBefore; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(processes() <= processesBefore, 'no child process handle left (an earlier test\'s child may close meanwhile)');
  });
}

test('runOnce survives a child that exits before reading stdin (no unhandled EPIPE)', { timeout: 10_000 }, async () => {
  const before = openTimeouts();
  const unhandled = [];
  const onError = error => unhandled.push(error);
  process.on('uncaughtException', onError);
  try {
    const out = await runOnce({ arm: 'cold', args: ['-e', 'process.stdin.destroy(); process.exit(3)'], env: process.env, cwd: tmpdir(), command: process.execPath });
    assert.match(out.error, /exited before result \(code 3/);
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally { process.off('uncaughtException', onError); }
  assert.deepEqual(unhandled, []);
  assert.equal(openTimeouts(), before);
});

// A fake CLI that starts a stdio MCP lookalike (argv carries the serve flag) that ignores stdin EOF,
// records its pid, and exits with an error on initialize: the errored run must still kill that child.
const FAKE_CLAUDE = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ${JSON.stringify(STDIO_SERVE_FLAG)}], { stdio: 'ignore' });
writeFileSync(process.argv[1], String(kid.pid));
process.stdin.once('data', () => process.exit(1));
`;

test('runOnce kills a sampled stdio MCP child when the run errors', { timeout: 15_000, skip: process.platform === 'win32' && 'needs ps' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warm-spare-orphan-'));
  const pidFile = join(dir, 'mcp.pid');
  let kidPid = null;
  try {
    const out = await runOnce({ arm: 'warm', args: ['-e', FAKE_CLAUDE, pidFile], env: process.env, cwd: dir, stdioMcp: true, command: process.execPath, parkMs: 600 });
    kidPid = Number(readFileSync(pidFile, 'utf8'));
    assert.match(out.error, /exited before result \(code 1/);
    assert.equal(out.mcp_child_count, 1, 'the lookalike was sampled while parked');
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 2_000;
    while (alive(kidPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(alive(kidPid), false, 'the stdio MCP child did not outlive the errored run');
  } finally {
    if (kidPid) { try { process.kill(kidPid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matchingLivePids keeps a live matching child even after it is reparented to PID 1', () => {
  const expected = [{ pid: 11, args: 'node bench.mjs --serve-stdio-mcp' }];
  assert.deepEqual(matchingLivePids('   11    10  40960 node bench.mjs --serve-stdio-mcp\n', expected), [11], 'still under Claude');
  assert.deepEqual(matchingLivePids('    1     0   1000 /sbin/launchd\n   11     1  40960 node bench.mjs --serve-stdio-mcp  \n', expected), [11], 'orphaned: ppid 1, trailing spaces trimmed');
  assert.deepEqual(matchingLivePids('   11 node bench.mjs --serve-stdio-mcp\n', expected), [11], 'pid=,args= tables work too');
});

test('matchingLivePids parses each ps line on its own, so a header or garbage line does not break valid rows', () => {
  const expected = [{ pid: 11, args: 'node bench.mjs --serve-stdio-mcp' }, { pid: 13, args: 'node bench.mjs --serve-stdio-mcp' }];
  const ps = '  PID  PPID   RSS ARGS\n   11     1  40960 node bench.mjs --serve-stdio-mcp\n garbage ?? line\n   13    10  40960 node bench.mjs --serve-stdio-mcp\n';
  assert.deepEqual(matchingLivePids(ps, expected), [11, 13], 'header and garbage lines are skipped; 4-column rows still match');
  assert.deepEqual(matchingLivePids('   11     1  40960 node bench.mjs --serve-stdio-mcp\n   13 node bench.mjs --serve-stdio-mcp\n', expected), [11, 13], 'mixed 4- and 2-column lines each parse by their own shape');
});

test('anyOrphaned fails closed: null when ps is unreadable, false when verified gone or nothing sampled, true when verified alive', async () => {
  const child = { pid: 11, args: 'node bench.mjs --serve-stdio-mcp' };
  assert.equal(await anyOrphaned([child], () => null), null, 'ps unavailable is unknown, never a clean false');
  assert.deepEqual(matchingLivePids(null, [child]), [], 'and nothing unverified is killed');
  assert.equal(await anyOrphaned([], () => null), false, 'no sampled children: nothing to orphan');
  assert.equal(await anyOrphaned(undefined, () => { throw new Error('ps must not be read'); }), false);
  assert.equal(await anyOrphaned([child], () => '    1     0   1000 /sbin/launchd\n'), false, 'verified gone');
  const alive = '   11     1  40960 node bench.mjs --serve-stdio-mcp\n';
  assert.equal(await anyOrphaned([child], () => alive, { waitMs: 20, pollMs: 5 }), true, 'verified still running at the deadline');
  let reads = 0;
  assert.equal(await anyOrphaned([child], () => (++reads < 3 ? alive : ''), { waitMs: 1_000, pollMs: 5 }), false, 'exits during the wait');
  reads = 0;
  assert.equal(await anyOrphaned([child], () => (++reads < 2 ? alive : null), { waitMs: 1_000, pollMs: 5 }), null, 'ps failing mid-wait is still unknown');
});

test('matchingLivePids drops a dead PID and a reused PID running another command, and never guesses without ps', () => {
  const expected = [{ pid: 11, args: 'node bench.mjs --serve-stdio-mcp' }, { pid: 12, args: 'node bench.mjs --serve-stdio-mcp' }, { pid: 13, args: 'node bench.mjs --serve-stdio-mcp' }];
  const ps = ['    1     0   1000 /sbin/launchd', '   12     1  30000 /usr/bin/vim notes.txt', '   13     1  40960 node bench.mjs --serve-stdio-mcp'].join('\n');
  assert.deepEqual(matchingLivePids(ps, expected), [13], '11 is gone and 12 was reused by an unrelated command: neither is killed');
  assert.deepEqual(matchingLivePids('   12     1  30000 node bench.mjs --serve-stdio-mcp --other\n', expected), [], 'changed args are a different process');
  assert.deepEqual(matchingLivePids(null, expected), [], 'ps unavailable: kill nothing');
  assert.deepEqual(matchingLivePids('', expected), []);
  assert.deepEqual(matchingLivePids(ps, []), []);
});
