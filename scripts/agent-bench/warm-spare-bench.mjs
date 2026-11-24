#!/usr/bin/env node
// Warm-spare benchmark: cold vs warm (parked 2 s) Claude Code launches, idle RSS, and the CLI's
// exit after `result`, driven the way PandaCode drives it (stream-json, HTTP MCP, the lead's app
// instructions). Zero dollars and no API traffic: the Messages API is a loopback stub with a dummy
// key, so the numbers isolate CLI startup from API latency. Two launch environments: `default` is
// PandaCode's plain-Claude env (the CLI's own non-essential traffic stays on, so it may reach
// Anthropic's telemetry/feature-flag hosts, never the Messages API); `offline` adds
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. Pure helpers are exported for tests.
//
//   node scripts/agent-bench/warm-spare-bench.mjs --pairs 12 --out scripts/agent-bench/results/warm-spare-2.1.325.json
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapCi, mean, median, random, wilcoxon } from './stats.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BACKGROUND_EXIT_WAIT_MS = 3_000; // providers/exit.rs
export const PARK_MS = 2_000;
const RUN_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 15_000;
const PROMPT = 'Reply with ok';
const DUMMY_KEY = 'sk-ant-bench-dummy';
const SEED = 0x5a7e;
export const SUITES = ['default-minimal', 'default-user', 'offline-minimal', 'offline-user'];

// ---------- pure helpers ----------

/** Split a suite name into its launch env and config: `default-user` → { env: 'default', minimal: false }. */
export function suiteParts(name) {
  if (!SUITES.includes(name)) throw new Error(`unknown suite ${name}`);
  const [env, config] = name.split('-');
  return { env, offline: env === 'offline', minimal: config === 'minimal' };
}

/** Parse CLI flags: `--pairs <n>` (default 12), `--out <path>`, `--suites a,b`. */
export function parseArgs(argv) {
  const opts = { pairs: 12, out: null, suites: [...SUITES] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--pairs') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--pairs needs a positive integer, got ${value}`);
      opts.pairs = n; i++;
    } else if (flag === '--out') {
      if (!value) throw new Error('--out needs a path');
      opts.out = value; i++;
    } else if (flag === '--suites') {
      const list = String(value ?? '').split(',').filter(Boolean);
      if (!list.length || list.some(s => !SUITES.includes(s))) throw new Error(`--suites takes ${SUITES.join(',')}, got ${value}`);
      opts.suites = list; i++;
    } else throw new Error(`unknown flag ${flag}`);
  }
  return opts;
}

/** Decode a Rust string literal body (normal `"..."`, escapes \n \" \\). */
export const unescapeRust = body => body.replace(/\\(["\\nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** A `const NAME: &str = "...";` (or `r#"..."#`) from Rust source. */
export function rustStr(source, name) {
  const raw = source.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (raw) return raw[1];
  const plain = source.match(new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`));
  if (!plain) throw new Error(`${name} not found`);
  return unescapeRust(plain[1]);
}

/** The body of `fn instruction() -> &'static str { "..." }`. */
export function rustFnStr(source, fn) {
  const match = source.match(new RegExp(`fn ${fn}\\(\\) -> &'static str \\{\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) throw new Error(`fn ${fn} not found`);
  return unescapeRust(match[1]);
}

/**
 * The lead's app instructions as `app_instructions()` builds them for a local Claude task with
 * explore on, agent-made tools off: GUIDANCE, run script, tracking, TURN_ENDS, LOOK+EDIT_CLAUDE,
 * RICH_QUESTIONS, GENERATIVE_UI, VISUAL_PROGRESS.
 */
export function leadInstructions(read = path => readFileSync(join(REPO, path), 'utf8')) {
  const app = read('src-tauri/src/app_instructions.rs');
  const look = rustStr(app, 'LOOK').replaceAll('{explore}', 'pandacode_explore') + rustStr(app, 'EDIT_CLAUDE');
  return [
    rustStr(read('src-tauri/src/session_titles.rs'), 'GUIDANCE'),
    rustStr(read('src-tauri/src/run_script.rs'), 'INSTRUCTIONS'),
    rustFnStr(read('src-tauri/src/turn_changes/host.rs'), 'instruction'),
    rustStr(app, 'TURN_ENDS'), look,
    rustStr(app, 'RICH_QUESTIONS'), rustStr(app, 'GENERATIVE_UI'), rustStr(app, 'VISUAL_PROGRESS'),
  ].join('');
}

/** Interleaved order: one arm-order per pair from a seeded coin, so cold and warm alternate fairly. */
export function pairOrders(pairs, seed = SEED) {
  const next = random(seed);
  return Array.from({ length: pairs }, () => (next() < 0.5 ? ['cold', 'warm'] : ['warm', 'cold']));
}

/** Percentile bootstrap of the median. */
export function bootstrapMedianCi(values, rounds = 10_000, seed = 0x2545f491) {
  const next = random(seed);
  const meds = new Float64Array(rounds);
  for (let r = 0; r < rounds; r++) meds[r] = median(Array.from(values, () => values[Math.floor(next() * values.length)]));
  meds.sort();
  return [meds[Math.floor(rounds * 0.025)], meds[Math.floor(rounds * 0.975)]];
}

const round = (x, digits = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits);

/** median, mean, min, max of a numeric list (nulls dropped). */
export function describe(values) {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!list.length) return { n: 0, median: null, mean: null, min: null, max: null };
  return { n: list.length, median: round(median(list)), mean: round(mean(list)), min: round(Math.min(...list)), max: round(Math.max(...list)) };
}

/** Summary of one suite's measured (non-warmup) runs. */
export function summarize(runs, { exitWait = BACKGROUND_EXIT_WAIT_MS } = {}) {
  const measured = runs.filter(r => !r.warmup);
  const ok = measured.filter(r => !r.error);
  const arm = name => ok.filter(r => r.arm === name);
  const pairsById = new Map();
  for (const r of ok) pairsById.set(r.pair, { ...pairsById.get(r.pair), [r.arm]: r });
  const complete = [...pairsById.values()].filter(p => p.cold && p.warm);
  const savings = complete.map(p => p.cold.result_ms - p.warm.result_ms);
  const initSavings = complete.map(p => p.cold.init_ms - p.warm.init_ms);
  const exits = ok.map(r => r.exit_after_result_ms);
  const sides = name => ({
    init_ms: describe(arm(name).map(r => r.init_ms)),
    result_ms: describe(arm(name).map(r => r.result_ms)),
    exit_after_result_ms: describe(arm(name).map(r => r.exit_after_result_ms)),
  });
  return {
    runs: measured.length,
    errors: measured.length - ok.length,
    exit_code_0: `${ok.filter(r => r.exit_code === 0).length}/${measured.length}`,
    cold: sides('cold'),
    warm: { ...sides('warm'), idle_rss_mib: describe(arm('warm').map(r => r.rss_mib)), idle_tree_rss_mib: describe(arm('warm').map(r => r.tree_rss_mib)) },
    saving_result_ms: savings.length ? {
      pairs: savings.length,
      median: round(median(savings)), mean: round(mean(savings)),
      median_ci95: bootstrapMedianCi(savings).map(x => round(x)),
      mean_ci95: bootstrapCi(savings).map(x => round(x)),
      wilcoxon_p: round(wilcoxon(savings), 6),
      warm_faster: `${savings.filter(s => s > 0).length}/${savings.length}`,
    } : null,
    saving_init_ms: initSavings.length ? { median: round(median(initSavings)), mean: round(mean(initSavings)) } : null,
    exit_after_result_ms: describe(exits),
    exited_within_wait: `${exits.filter(ms => ms <= exitWait).length}/${measured.length}`,
  };
}

/** Parse `ps -o rss=` (KiB) into MiB. */
export const rssKibToMib = text => { const kib = Number(String(text).trim()); return Number.isFinite(kib) && kib > 0 ? round(kib / 1024) : null; };

/** Sum RSS (KiB→MiB) of `root` and its descendants from `ps -A -o pid=,ppid=,rss=` output. */
export function treeRssMib(psText, root) {
  const rows = psText.split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(r => r.length === 3 && r.every(Number.isFinite));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , kib]) => [pid, kib]));
  let total = 0; const stack = [root]; const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid); total += rss.get(pid) ?? 0;
    stack.push(...(kids.get(pid) ?? []));
  }
  return total ? round(total / 1024) : null;
}

/** Remove the user's home directory from text bound for the results file. */
export const scrub = (text, home) => (home ? String(text).split(home).join('~') : String(text));

// ---------- loopback servers ----------

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function messagesStub(counts) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      counts.api[`${req.method} ${path}`] = (counts.api[`${req.method} ${path}`] ?? 0) + 1;
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return json(res, { input_tokens: 10 });
      if (req.method !== 'POST' || path !== '/v1/messages') return json(res, {});
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* fall through with defaults */ }
      const model = parsed.model ?? 'claude-sonnet-bench';
      const id = `msg_bench_${Date.now()}`;
      const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!parsed.stream) return json(res, { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage });
      sse(res, [
        ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    });
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
/** The three tools PandaCode's `mcp_host` always lists for a local Claude lead (names as in the app). */
export const MCP_TOOLS = [
  { name: 'pandacode_explore', description: 'Locate code: search, symbols, outlines and ranged reads, all questions in one call.', inputSchema: obj({ questions: { type: 'array', items: { type: 'string' } } }, ['questions']) },
  { name: 'pandacode_track_files', description: 'Begin or complete a file-change capture around an edit batch.', inputSchema: obj({ action: { type: 'string', enum: ['begin', 'complete'] }, paths: { type: 'array', items: { type: 'string' } }, captureId: { type: 'string' } }, ['action']) },
  { name: 'pandacode_title', description: 'Set the sidebar title. Call it alongside another tool call; alone only on a clear topic change or when the title is just the first message. At most once per turn; never overrides a manual name.', inputSchema: obj({ title: { type: 'string', minLength: 1, maxLength: 80 } }, ['title']) },
];

/** Answer one Streamable HTTP MCP JSON-RPC message; `null` for a notification. */
export function mcpReply(message) {
  if (message.id === undefined || message.id === null) return null;
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': return ok({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pandacode_architect', version: 'bench' } });
    case 'tools/list': return ok({ tools: MCP_TOOLS });
    case 'ping': return ok({});
    case 'tools/call': return ok({ content: [{ type: 'text', text: 'bench stub' }], isError: true });
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
}

function mcpServer(counts, token) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url !== '/mcp') return json(res, {}, 404);
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, {}, 401);
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let message;
      try { message = JSON.parse(body); } catch { return json(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
      const batch = Array.isArray(message) ? message : [message];
      for (const m of batch) counts.mcp[m.method] = (counts.mcp[m.method] ?? 0) + 1;
      const replies = batch.map(mcpReply).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      json(res, Array.isArray(message) ? replies : replies[0]);
    });
  });
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

// ---------- runs ----------

const children = new Set();
const tempDirs = new Set();
function cleanup() {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); process.exit(130); });

const delay = ms => new Promise(r => setTimeout(r, ms));

function sampleRss(pid) {
  let rss = null; let tree = null;
  try { rss = rssKibToMib(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })); } catch { /* fall back below */ }
  if (rss == null && process.platform === 'linux') {
    try { const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m); rss = m ? rssKibToMib(m[1]) : null; } catch { /* gone */ }
  }
  try { tree = treeRssMib(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }), pid); } catch { /* unsupported */ }
  return { rss_mib: rss, tree_rss_mib: tree };
}

const write = (child, value) => child.stdin.write(`${JSON.stringify(value)}\n`);

/** One launch: cold (initialize at spawn) or warm (parked PARK_MS with stdin open first). */
async function runOnce({ arm, args, env, cwd }) {
  const tSpawn = performance.now();
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: performance.now() })));
  child.on('error', () => {});
  const out = { arm, init_ms: null, result_ms: null, exit_after_result_ms: null, exit_code: null, rss_mib: null, tree_rss_mib: null, result_subtype: null, error: null };
  let t0 = tSpawn;
  let tResult = null;
  const done = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'control_response' && event.response?.request_id === 'pandacode-init' && out.init_ms == null) {
          out.init_ms = performance.now() - t0;
          write(child, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] }, parent_tool_use_id: null, session_id: '' });
        } else if (event.type === 'result' && tResult == null) {
          tResult = performance.now();
          out.result_ms = tResult - t0;
          out.result_subtype = event.subtype ?? null;
          if (event.is_error) out.error = `result is_error: ${String(event.result ?? '').slice(0, 200)}`;
          child.stdin.end();
          resolve();
        }
      }
    });
    exited.then(e => reject(new Error(`exited before result (code ${e.code}, signal ${e.signal})`)));
    setTimeout(() => reject(new Error('timed out waiting for result')), RUN_TIMEOUT_MS + PARK_MS);
  });
  done.catch(() => {});
  try {
    if (arm === 'warm') {
      await delay(PARK_MS);
      Object.assign(out, sampleRss(child.pid));
      t0 = performance.now();
    }
    write(child, { type: 'control_request', request_id: 'pandacode-init', request: { subtype: 'initialize', hooks: null } });
    await done;
    const exit = await Promise.race([exited, delay(EXIT_TIMEOUT_MS).then(() => null)]);
    if (!exit) { out.error = out.error ?? `no exit within ${EXIT_TIMEOUT_MS} ms of result`; child.kill('SIGKILL'); await exited; }
    else { out.exit_after_result_ms = exit.at - tResult; out.exit_code = exit.code; }
  } catch (error) {
    out.error = `${error.message}; stderr: ${stderr.slice(-300)}`;
    child.kill('SIGKILL');
    await exited;
  } finally {
    children.delete(child);
  }
  for (const key of ['init_ms', 'result_ms', 'exit_after_result_ms']) out[key] = round(out[key]);
  return out;
}

/** The child env: a few inherited basics, the loopback API, and `offline`'s one extra switch. */
export function launchEnv(apiPort, offline, parent = process.env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env = Object.fromEntries(keep.filter(k => parent[k] !== undefined).map(k => [k, parent[k]]));
  return { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`, ANTHROPIC_API_KEY: DUMMY_KEY, ...(offline ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}) };
}

export function claudeArgs({ instructions, mcpConfig, minimal }) {
  return [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--disallowedTools=ScheduleWakeup,Monitor,CronCreate',
    ...(minimal ? ['--setting-sources', 'project', '--strict-mcp-config'] : []),
    '--mcp-config', mcpConfig, '--no-session-persistence', '--model', 'sonnet', '--append-system-prompt', instructions,
  ];
}

async function runSuite(name, pairs, ctx) {
  const cwd = mkdtempSync(join(tmpdir(), `warm-spare-${name}-`));
  tempDirs.add(cwd);
  const { offline, minimal } = suiteParts(name);
  const args = claudeArgs({ ...ctx, minimal });
  const env = launchEnv(ctx.apiPort, offline);
  ctx.counts.api = {}; ctx.counts.mcp = {};
  const runs = [];
  const orders = [['cold', 'warm'], ...pairOrders(pairs, SEED + SUITES.indexOf(name))];
  for (let i = 0; i < orders.length; i++) {
    for (const arm of orders[i]) {
      const r = await runOnce({ arm, args, env, cwd });
      const row = { suite: name, pair: i, warmup: i === 0, ...r, error: r.error && scrub(r.error, process.env.HOME) };
      runs.push(row);
      process.stderr.write(`${name} ${i === 0 ? 'warmup' : `pair ${i}`} ${arm}: result ${row.result_ms} ms, exit +${row.exit_after_result_ms} ms (code ${row.exit_code})${row.rss_mib ? `, rss ${row.rss_mib} MiB` : ''}${row.error ? `, ERROR ${row.error}` : ''}\n`);
    }
  }
  rmSync(cwd, { recursive: true, force: true });
  tempDirs.delete(cwd);
  return { runs, summary: summarize(runs), stub_requests: { messages_api: ctx.counts.api, mcp: ctx.counts.mcp } };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const instructions = leadInstructions();
  const counts = { api: {}, mcp: {} };
  const token = `bench-${Math.random().toString(36).slice(2)}`;
  const api = messagesStub(counts); const mcp = mcpServer(counts, token);
  const apiPort = await listen(api); const mcpPort = await listen(mcp);
  const mcpConfig = JSON.stringify({ mcpServers: { pandacode_architect: { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
  const ctx = { instructions, mcpConfig, apiPort, counts };
  const suites = {};
  try {
    for (const name of opts.suites) suites[name] = await runSuite(name, opts.pairs, ctx);
  } finally {
    api.close(); mcp.close();
  }
  const versionAfter = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  if (versionAfter !== version) throw new Error(`claude changed during the run: ${version} -> ${versionAfter}`);
  const report = {
    benchmark: 'warm-spare-bench',
    claude_version: version,
    platform: process.platform, arch: process.arch, node: process.version,
    timestamp: new Date().toISOString(),
    pairs: opts.pairs, warmup_pairs: 1, park_ms: PARK_MS, background_exit_wait_ms: BACKGROUND_EXIT_WAIT_MS, seed: SEED,
    prompt: PROMPT,
    app_instructions_bytes: Buffer.byteLength(instructions, 'utf8'),
    flags: claudeArgs({ instructions: '<app_instructions>', mcpConfig: '<http-mcp-json>', minimal: false }),
    minimal_extra_flags: ['--setting-sources', 'project', '--strict-mcp-config'],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:<port>', ANTHROPIC_API_KEY: DUMMY_KEY, inherited: 'PATH, HOME, USER, SHELL, TMPDIR, LANG only', offline_extra: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
    suites: Object.fromEntries(Object.keys(suites).map(k => [k, suiteParts(k)])),
    method: 'Messages API and Streamable HTTP MCP are loopback stubs (no Messages API traffic, no cost, no API jitter; the stub answers 200 {} to any other path, such as HEAD /api/hello). default-* suites use PandaCode\'s plain-Claude env, so the CLI\'s own non-essential traffic (telemetry, feature flags, update checks) stays on and may leave the machine; offline-* suites add CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. Cold: spawn, initialize at once, user message on control_response, timed from spawn. Warm: spawn with stdin open, park 2 s, sample RSS, then initialize and the message, timed from the end of the park. stdin closed at result; exit timed from result. Pair order seeded per pair; pair 0 is a discarded warmup.',
    stub_requests: Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, v.stub_requests])),
    summary: Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, v.summary])),
    runs: Object.values(suites).flatMap(v => v.runs),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) { mkdirSync(dirname(opts.out), { recursive: true }); writeFileSync(opts.out, text); }
  process.stdout.write(opts.out ? `${JSON.stringify(report.summary, null, 2)}\n` : text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); cleanup(); process.exit(1); });
}
