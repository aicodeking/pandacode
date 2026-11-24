#!/usr/bin/env node
// Warm-spare benchmark: cold vs warm (parked 2 s) Claude Code launches, idle RSS, and the CLI's
// exit after `result`, driven the way PandaCode drives it (stream-json, HTTP MCP, the lead's app
// instructions). Zero dollars and no API traffic: the Messages API is a loopback stub with a dummy
// key, so the numbers isolate CLI startup from API latency. Three launch environments: `default` is
// PandaCode's plain-Claude env (the CLI's own non-essential traffic stays on, so it may reach
// Anthropic's telemetry/feature-flag hosts, never the Messages API); `privacy` adds exactly the
// variables Settings → Agents → "Turn off agent telemetry" injects (`ENVIRONMENT` in
// src-tauri/src/providers/privacy.rs, drift-guarded by the tests); `offline` adds
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 instead. The `*-resumed` suites launch like a real
// PandaCode follow-up (`--resume=<id>`) against a one-turn seed transcript in an isolated temporary
// CLAUDE_CONFIG_DIR; `--no-session-persistence` keeps that transcript byte-identical across every
// run (sha256 checked before and after), so no pair resumes a longer history than another. Pure
// helpers are exported for tests. `--stdio-mcp` adds a second, stdio MCP server (this script
// re-run with --serve-stdio-mcp, a minimal Node JSON-RPC server that stays resident until stdin
// closes), so each warm spare's idle sample splits into Claude's own RSS, the stdio MCP child's RSS
// and the descendant count, and every exit checks the child went with Claude.
//
//   node scripts/agent-bench/warm-spare-bench.mjs --pairs 12 --out scripts/agent-bench/results/warm-spare-2.1.325.json
//   node scripts/agent-bench/warm-spare-bench.mjs --pairs 5 --suites default-minimal,privacy-minimal --stdio-mcp
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapCi, mean, median, random, wilcoxon } from './stats.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = join(dirname(SELF), '..', '..');
export const BACKGROUND_EXIT_WAIT_MS = 3_000; // providers/exit.rs
export const PARK_MS = 2_000;
const RUN_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 15_000;
const PROMPT = 'Reply with ok';
const DUMMY_KEY = 'sk-ant-bench-dummy';
const SEED = 0x5a7e;
export const SUITES = ['default-minimal', 'default-user', 'privacy-minimal', 'privacy-user', 'offline-minimal', 'offline-user', 'default-resumed', 'privacy-resumed'];
/** The one exchange written into a resumed suite's seed transcript before any measured run. */
export const SEED_PROMPT = 'Remember the word kiwi. Reply with ok';
export const SEED_TURNS = 1;
export const LAUNCH_ENVS = ['default', 'privacy', 'offline'];
/** `ENVIRONMENT` in src-tauri/src/providers/privacy.rs, in order: what "Turn off agent telemetry" sets on every harness process. */
export const PRIVACY_ENV = Object.freeze({
  DO_NOT_TRACK: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  KIMI_DISABLE_TELEMETRY: 'true',
  GROK_TELEMETRY_ENABLED: 'false',
  GROK_TELEMETRY_TRACE_UPLOAD: 'false',
  DSH_TELEMETRY_DISABLED: '1',
  OPENCODE_DISABLE_SHARE: '1',
  PI_TELEMETRY: '0',
});
export const OFFLINE_ENV = Object.freeze({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
/** argv[2] that turns this script into the stdio MCP server `--stdio-mcp` launches; also the marker that finds that child in `ps`. */
export const STDIO_SERVE_FLAG = '--serve-stdio-mcp';
export const STDIO_SERVER_NAME = 'bench_stdio';
const ORPHAN_WAIT_MS = 2_000;

// ---------- pure helpers ----------

/**
 * Split a suite name into its launch env and config: `default-user` → { env: 'default', minimal: false }.
 * `*-resumed` suites use the minimal config plus `--resume=<id>` in an isolated CLAUDE_CONFIG_DIR.
 */
export function suiteParts(name) {
  if (!SUITES.includes(name)) throw new Error(`unknown suite ${name}`);
  const [env, config] = name.split('-');
  const resumed = config === 'resumed';
  return { env, privacy: env === 'privacy', offline: env === 'offline', minimal: config === 'minimal' || resumed, resumed };
}

/** Parse CLI flags: `--pairs <n>` (default 12), `--out <path>`, `--suites a,b`, `--stdio-mcp`. */
export function parseArgs(argv) {
  const opts = { pairs: 12, out: null, suites: [...SUITES], stdioMcp: false };
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
    } else if (flag === '--stdio-mcp') {
      opts.stdioMcp = true;
    } else throw new Error(`unknown flag ${flag}`);
  }
  return opts;
}

/** Decode a Rust string literal body (normal `"..."`, escapes \n \" \\). */
export const unescapeRust = body => body.replace(/\\(["\\nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** The `(key, value)` pairs of a `const NAME: &[(&str, &str)] = &[...];` table, comments skipped. */
export function rustEnvTable(source, name) {
  const block = source.match(new RegExp(`const ${name}: &\\[\\(&str, &str\\)\\] = &\\[([\\s\\S]*?)\\];`));
  if (!block) throw new Error(`${name} not found`);
  const body = block[1].split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n');
  return [...body.matchAll(/\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map(m => [unescapeRust(m[1]), unescapeRust(m[2])]);
}

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
  const warm = arm('warm');
  const stdio = warm.some(r => r.mcp_child_rss_mib !== undefined) ? {
    idle_self_rss_mib: describe(warm.map(r => r.self_rss_mib)),
    idle_mcp_child_rss_mib: describe(warm.map(r => r.mcp_child_rss_mib)),
    idle_child_count: describe(warm.map(r => r.child_count)),
    idle_mcp_child_count: describe(warm.map(r => r.mcp_child_count)),
    mcp_child_seen: `${warm.filter(r => r.mcp_child_count >= 1).length}/${warm.length}`,
    mcp_child_orphaned: ok.filter(r => r.mcp_child_orphaned).length,
  } : {};
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
    warm: { ...sides('warm'), idle_rss_mib: describe(warm.map(r => r.rss_mib)), idle_tree_rss_mib: describe(warm.map(r => r.tree_rss_mib)), ...stdio },
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

/** Rows of `ps -A -o pid=,ppid=,rss=,args=` as { pid, ppid, kib, args }; malformed lines dropped. */
export function parsePsArgs(psText) {
  return String(psText).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/)).filter(Boolean)
    .map(([, pid, ppid, kib, args]) => ({ pid: Number(pid), ppid: Number(ppid), kib: Number(kib), args: args ?? '' }));
}

/**
 * Split `root`'s process tree from `ps -A -o pid=,ppid=,rss=,args=` into Claude's own RSS, its
 * descendants, and the descendants whose command line contains `marker` (the stdio MCP server).
 * Null when `root` is not listed. Command lines never leave this function, only pids and sizes.
 */
export function treeBreakdown(psText, root, marker = STDIO_SERVE_FLAG) {
  const rows = parsePsArgs(psText);
  const self = rows.find(r => r.pid === root);
  if (!self) return null;
  const kids = new Map();
  for (const r of rows) if (r.pid !== r.ppid) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const descendants = []; const stack = [...(kids.get(root) ?? [])]; const seen = new Set([root]);
  while (stack.length) {
    const r = stack.pop();
    if (seen.has(r.pid)) continue;
    seen.add(r.pid); descendants.push(r);
    stack.push(...(kids.get(r.pid) ?? []));
  }
  const marked = descendants.filter(r => r.args.split(/\s+/).includes(marker));
  const mib = kib => round(kib / 1024);
  const sum = list => list.reduce((total, r) => total + r.kib, 0);
  return {
    self_rss_mib: mib(self.kib),
    tree_rss_mib: mib(self.kib + sum(descendants)),
    child_count: descendants.length,
    mcp_child_count: marked.length,
    mcp_child_rss_mib: mib(sum(marked)),
    mcp_child_pids: marked.map(r => r.pid).sort((a, b) => a - b),
  };
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
      if (Array.isArray(parsed.messages)) counts.messageCounts.push(parsed.messages.length);
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

/** The stdio server's one tool: enough for Claude to list and register it, never called by the bench prompt. */
export const STDIO_MCP_TOOLS = [
  { name: 'bench_echo', description: 'Echo the given text back.', inputSchema: obj({ text: { type: 'string' } }, ['text']) },
];

/** Answer one MCP JSON-RPC message (Streamable HTTP by default, or `server` for stdio); `null` for a notification or response. */
export function mcpReply(message, server = { name: 'pandacode_architect', tools: MCP_TOOLS }) {
  if (!message || typeof message !== 'object' || message.id === undefined || message.id === null || typeof message.method !== 'string') return null;
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': return ok({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: server.name, version: 'bench' } });
    case 'tools/list': return ok({ tools: server.tools });
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

/**
 * A minimal stdio MCP server: newline-delimited JSON-RPC on `input`, replies on `output`, resident
 * until `input` ends (no timers, so nothing outlives stdin). Resolves with the request count; a write
 * after the peer hung up (EPIPE) is dropped rather than thrown.
 */
export async function serveStdioMcp(input = process.stdin, output = process.stdout) {
  const server = { name: STDIO_SERVER_NAME, tools: STDIO_MCP_TOOLS };
  let buffer = ''; let handled = 0; let broken = false;
  const onError = () => { broken = true; };
  output.on('error', onError);
  const send = value => { if (!broken && !output.destroyed) output.write(`${JSON.stringify(value)}\n`); };
  const handle = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(message) ? message : [message];
    handled += batch.length;
    const replies = batch.map(m => mcpReply(m, server)).filter(Boolean);
    if (replies.length) send(Array.isArray(message) ? replies : replies[0]);
  };
  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
  });
  try {
    await Promise.race([once(input, 'end'), once(input, 'close')]);
  } finally {
    handle(buffer);
    output.off('error', onError);
  }
  return handled;
}

/** The `--mcp-config` JSON: the app's HTTP server, plus the stdio server (this script with STDIO_SERVE_FLAG) when `stdio` is set. */
export function mcpConfigJson({ mcpPort, token, stdio = false, node = process.execPath, script = SELF }) {
  const servers = { pandacode_architect: { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: `Bearer ${token}` } } };
  if (stdio) servers[STDIO_SERVER_NAME] = { type: 'stdio', command: node, args: [script, STDIO_SERVE_FLAG], env: {} };
  return JSON.stringify({ mcpServers: servers });
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

/** A delay resolving to `value` after `ms`; `cancel()` clears its timer so nothing keeps the event loop alive once a race settles (the promise then never resolves). */
export function cancellableDelay(ms, value) {
  let timer = null;
  const promise = new Promise(resolve => { timer = setTimeout(() => { timer = null; resolve(value); }, ms); });
  return { promise, cancel: () => { if (timer !== null) { clearTimeout(timer); timer = null; } } };
}

/** Claude's own RSS, the stdio MCP child's RSS and the descendant count; null fields when `ps` is unavailable. */
function sampleTree(pid) {
  try { return treeBreakdown(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }), pid); } catch { return null; }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Whether any of `pids` is still running ORPHAN_WAIT_MS after Claude exited (polled, so a fast exit returns at once). */
async function anyOrphaned(pids) {
  const deadline = performance.now() + ORPHAN_WAIT_MS;
  while (pids.some(alive)) {
    if (performance.now() >= deadline) return true;
    await delay(50);
  }
  return false;
}

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
async function runOnce({ arm, args, env, cwd, stdioMcp = false }) {
  const tSpawn = performance.now();
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: performance.now() })));
  child.on('error', () => {});
  const out = { arm, init_ms: null, result_ms: null, exit_after_result_ms: null, exit_code: null, rss_mib: null, tree_rss_mib: null, result_subtype: null, error: null };
  let mcpPids = [];
  let t0 = tSpawn;
  let tResult = null;
  const resultTimeout = cancellableDelay(RUN_TIMEOUT_MS + PARK_MS);
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
    resultTimeout.promise.then(() => reject(new Error('timed out waiting for result')));
  });
  done.catch(() => {});
  try {
    if (arm === 'warm') {
      await delay(PARK_MS);
      Object.assign(out, sampleRss(child.pid));
      if (stdioMcp) {
        const tree = sampleTree(child.pid);
        mcpPids = tree?.mcp_child_pids ?? [];
        Object.assign(out, { self_rss_mib: tree?.self_rss_mib ?? null, mcp_child_rss_mib: tree?.mcp_child_rss_mib ?? null, child_count: tree?.child_count ?? null, mcp_child_count: tree?.mcp_child_count ?? null, tree_rss_mib: tree?.tree_rss_mib ?? out.tree_rss_mib });
      }
      t0 = performance.now();
    }
    write(child, { type: 'control_request', request_id: 'pandacode-init', request: { subtype: 'initialize', hooks: null } });
    await done;
    const exitTimeout = cancellableDelay(EXIT_TIMEOUT_MS, null);
    let exit;
    try { exit = await Promise.race([exited, exitTimeout.promise]); } finally { exitTimeout.cancel(); }
    if (!exit) { out.error = out.error ?? `no exit within ${EXIT_TIMEOUT_MS} ms of result`; child.kill('SIGKILL'); await exited; }
    else { out.exit_after_result_ms = exit.at - tResult; out.exit_code = exit.code; }
    if (stdioMcp) {
      if (arm === 'cold') mcpPids = []; // sampled only while parked
      out.mcp_child_orphaned = await anyOrphaned(mcpPids);
      if (out.mcp_child_orphaned) { out.error = out.error ?? `stdio MCP child outlived Claude by ${ORPHAN_WAIT_MS} ms`; for (const p of mcpPids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
    }
  } catch (error) {
    out.error = `${error.message}; stderr: ${stderr.slice(-300)}`;
    child.kill('SIGKILL');
    await exited;
  } finally {
    resultTimeout.cancel();
    children.delete(child);
  }
  for (const key of ['init_ms', 'result_ms', 'exit_after_result_ms']) out[key] = round(out[key]);
  return out;
}

/** The child env: a few inherited basics, the loopback API, and the launch env's switches (`privacy`: PRIVACY_ENV; `offline`: OFFLINE_ENV). */
export function launchEnv(apiPort, launch, parent = process.env) {
  if (!LAUNCH_ENVS.includes(launch)) throw new Error(`unknown launch env ${launch}`);
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env = Object.fromEntries(keep.filter(k => parent[k] !== undefined).map(k => [k, parent[k]]));
  const extra = launch === 'privacy' ? PRIVACY_ENV : launch === 'offline' ? OFFLINE_ENV : {};
  return { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`, ANTHROPIC_API_KEY: DUMMY_KEY, ...extra };
}

/** PandaCode's stream-json launch; `resume` adds `--resume=<id>` as `providers.rs` does (the bench keeps `--no-session-persistence` so the seed transcript never grows). */
export function claudeArgs({ instructions, mcpConfig, minimal, resume = null }) {
  return [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--disallowedTools=ScheduleWakeup,Monitor,CronCreate',
    ...(minimal ? ['--setting-sources', 'project', '--strict-mcp-config'] : []),
    ...(resume ? [`--resume=${resume}`] : []),
    '--mcp-config', mcpConfig, '--no-session-persistence', '--model', 'sonnet', '--append-system-prompt', instructions,
  ];
}

/** The seed turn of a resumed suite: one plain `-p` exchange that persists its session (no `--no-session-persistence`). */
export function seedArgs() {
  return ['-p', SEED_PROMPT, '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--model', 'sonnet'];
}

/** sha256 of every `.jsonl` transcript under `projectsDir`, keyed by relative path (sorted). */
export function transcriptDigest(projectsDir) {
  let files = [];
  try { files = readdirSync(projectsDir, { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')).sort(); } catch { return {}; }
  return Object.fromEntries(files.map(f => [relative(projectsDir, join(projectsDir, f)).split(sep).join('/'), createHash('sha256').update(readFileSync(join(projectsDir, f))).digest('hex')]));
}

/** The digest key of session `sessionId`'s transcript (any project subfolder), or null. */
export function sessionTranscriptKey(digest, sessionId) {
  const name = `${sessionId}.jsonl`;
  return Object.keys(digest).find(key => key === name || key.endsWith(`/${name}`)) ?? null;
}

/** The largest `messages` length among captured Messages API requests, or null when none was captured (an auxiliary request after the main one never lowers it). */
export const maxMessageCount = counts => (counts.length ? Math.max(...counts) : null);

/** Why a resumed run did not load its session, or null: fails closed when the seed request was not captured. */
export function resumeCheckError(seedMessages, resumedMessages) {
  if (!Number.isFinite(seedMessages)) return 'resume not verified: the seed request was not captured';
  if (!Number.isFinite(resumedMessages) || !(resumedMessages > seedMessages)) return `resume not loaded: request held ${resumedMessages} messages, seed request ${seedMessages}`;
  return null;
}

/** Run the seed turn in `cwd` with `env` (which carries the temporary CLAUDE_CONFIG_DIR); returns its session id. */
function runSeed(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', seedArgs(), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true; clearTimeout(timer); children.delete(child);
      return true;
    };
    child.on('error', err => { if (settle()) reject(err); });
    child.on('exit', code => {
      if (!settle()) return;
      let result = null;
      try { result = JSON.parse(stdout); } catch { /* reported below */ }
      if (code !== 0 || !result?.session_id || result.is_error) return reject(new Error(`seed turn failed (code ${code}): ${scrub(stderr.slice(-300), process.env.HOME)}`));
      resolve(result.session_id);
    });
  });
}

/**
 * The temporary folder's `.claude.json`: the machine's `~/.claude.json` (what the other suites read)
 * without its `projects` map. Without the cached account and feature state in it, every turn of a
 * fresh folder awaits a bootstrap fetch that a dummy key can never satisfy, which an initialized config folder does not.
 */
export function mirroredClaudeJson(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const { projects: _projects, ...rest } = parsed;
  return rest;
}

/** A resumed suite's isolated config folder with one seeded session: env, session id and the transcript digest. */
async function seedResumed(name, cwd, baseEnv) {
  const configDir = mkdtempSync(join(tmpdir(), `warm-spare-${name}-config-`));
  tempDirs.add(configDir);
  let source = '';
  try { source = readFileSync(join(baseEnv.HOME ?? '', '.claude.json'), 'utf8'); } catch { /* no user state: an empty folder */ }
  const mirror = mirroredClaudeJson(source);
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify(mirror), { mode: 0o600 });
  const env = { ...baseEnv, CLAUDE_CONFIG_DIR: configDir };
  const sessionId = await runSeed(cwd, env);
  const digest = transcriptDigest(join(configDir, 'projects'));
  if (!sessionTranscriptKey(digest, sessionId)) throw new Error(`seed transcript for ${sessionId} not found in the temporary config folder`);
  return { configDir, env, sessionId, digest, mirrored: Object.keys(mirror).length > 0 };
}

async function runSuite(name, pairs, ctx) {
  const cwd = mkdtempSync(join(tmpdir(), `warm-spare-${name}-`));
  tempDirs.add(cwd);
  const { env: launch, minimal, resumed } = suiteParts(name);
  ctx.counts.api = {}; ctx.counts.mcp = {}; ctx.counts.messageCounts = [];
  const seed = resumed ? await seedResumed(name, cwd, launchEnv(ctx.apiPort, launch)) : null;
  const seedMessages = seed ? maxMessageCount(ctx.counts.messageCounts) : null;
  const args = claudeArgs({ ...ctx, minimal, resume: seed?.sessionId });
  const env = seed ? seed.env : launchEnv(ctx.apiPort, launch);
  ctx.counts.api = {}; ctx.counts.mcp = {};
  const runs = [];
  const orders = [['cold', 'warm'], ...pairOrders(pairs, SEED + SUITES.indexOf(name))];
  for (let i = 0; i < orders.length; i++) {
    for (const arm of orders[i]) {
      ctx.counts.messageCounts = [];
      const r = await runOnce({ arm, args, env, cwd, stdioMcp: ctx.stdioMcp });
      const resumedMessages = seed ? maxMessageCount(ctx.counts.messageCounts) : undefined;
      if (seed && r.error == null) r.error = resumeCheckError(seedMessages, resumedMessages);
      const row = { suite: name, pair: i, warmup: i === 0, ...r, ...(seed ? { api_messages: resumedMessages } : {}), error: r.error && scrub(r.error, process.env.HOME) };
      runs.push(row);
      process.stderr.write(`${name} ${i === 0 ? 'warmup' : `pair ${i}`} ${arm}: result ${row.result_ms} ms, exit +${row.exit_after_result_ms} ms (code ${row.exit_code})${row.rss_mib ? `, rss ${row.rss_mib} MiB` : ''}${row.mcp_child_count != null ? `, stdio MCP ${row.mcp_child_count} child ${row.mcp_child_rss_mib} MiB, ${row.child_count} descendants` : ''}${row.error ? `, ERROR ${row.error}` : ''}\n`);
    }
  }
  let seedInfo = null;
  if (seed) {
    const after = transcriptDigest(join(seed.configDir, 'projects'));
    const unchanged = JSON.stringify(after) === JSON.stringify(seed.digest);
    if (!unchanged) throw new Error(`${name}: the seed transcript changed during the suite`);
    seedInfo = {
      turns: SEED_TURNS, prompt: SEED_PROMPT, seed_request_messages: seedMessages,
      resumed_request_messages: [...new Set(runs.filter(r => !r.error).map(r => r.api_messages))],
      transcript_sha256: seed.digest[sessionTranscriptKey(seed.digest, seed.sessionId)], transcript_unchanged: unchanged,
      config_dir: 'temporary CLAUDE_CONFIG_DIR, deleted after the suite',
      config_state: seed.mirrored ? "the machine's ~/.claude.json without its projects map (cached account and feature state, as the other suites read it); no other user files" : 'empty (no ~/.claude.json found)',
    };
    rmSync(seed.configDir, { recursive: true, force: true });
    tempDirs.delete(seed.configDir);
  }
  rmSync(cwd, { recursive: true, force: true });
  tempDirs.delete(cwd);
  return { runs, summary: summarize(runs), stub_requests: { messages_api: ctx.counts.api, mcp: ctx.counts.mcp }, ...(seedInfo ? { seed: seedInfo } : {}) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const instructions = leadInstructions();
  const counts = { api: {}, mcp: {}, messageCounts: [] };
  const token = `bench-${Math.random().toString(36).slice(2)}`;
  const api = messagesStub(counts); const mcp = mcpServer(counts, token);
  const apiPort = await listen(api); const mcpPort = await listen(mcp);
  const mcpConfig = mcpConfigJson({ mcpPort, token, stdio: opts.stdioMcp });
  const ctx = { instructions, mcpConfig, apiPort, counts, stdioMcp: opts.stdioMcp };
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
    resumed_extra_flags: ['--resume=<seed session id>'],
    seed_flags: seedArgs(),
    ...(opts.stdioMcp ? { stdio_mcp: { server: STDIO_SERVER_NAME, command: `node scripts/agent-bench/warm-spare-bench.mjs ${STDIO_SERVE_FLAG}`, tools: STDIO_MCP_TOOLS.map(t => t.name), sampled: 'warm arm while parked: Claude self RSS, stdio MCP child RSS (descendants whose argv holds the serve flag), descendant count; every run checks the sampled child exits within 2 s of Claude' } } : {}),
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:<port>', ANTHROPIC_API_KEY: DUMMY_KEY, inherited: 'PATH, HOME, USER, SHELL, TMPDIR, LANG only', privacy_extra: { ...PRIVACY_ENV }, privacy_source: 'src-tauri/src/providers/privacy.rs ENVIRONMENT', offline_extra: { ...OFFLINE_ENV } },
    suites: Object.fromEntries(Object.keys(suites).map(k => [k, suiteParts(k)])),
    method: 'Messages API and Streamable HTTP MCP are loopback stubs (no Messages API traffic, no cost, no API jitter; the stub answers 200 {} to any other path, such as HEAD /api/hello). default-* suites use PandaCode\'s plain-Claude env, so the CLI\'s own non-essential traffic (telemetry, feature flags, update checks) stays on and may leave the machine; privacy-* suites add exactly PandaCode\'s "Turn off agent telemetry" variables (providers/privacy.rs ENVIRONMENT: DO_NOT_TRACK, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY and the other harnesses\' opt-outs) and nothing else; offline-* suites add CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. *-resumed suites (default or privacy env, minimal config) first run one seed turn (a single short exchange, persisted) in a fresh temporary CLAUDE_CONFIG_DIR, then launch every cold and warm run with --resume=<seed session id> plus --no-session-persistence, so each resumes the same byte-identical one-turn transcript (the temporary folder holds a copy of ~/.claude.json without its projects map, so cached account and feature state match the other suites; with an empty folder every turn awaits a bootstrap fetch the dummy key cannot satisfy) (sha256 checked after the suite; each run\'s Messages API request must carry more messages than the seed request, proving the history loaded); long real histories are unmeasured. Cold: spawn, initialize at once, user message on control_response, timed from spawn. Warm: spawn with stdin open, park 2 s, sample RSS, then initialize and the message, timed from the end of the park. stdin closed at result; exit timed from result. Pair order seeded per pair; pair 0 is a discarded warmup.',
    stub_requests: Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, v.stub_requests])),
    seeds: Object.fromEntries(Object.entries(suites).filter(([, v]) => v.seed).map(([k, v]) => [k, v.seed])),
    summary: Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, v.summary])),
    runs: Object.values(suites).flatMap(v => v.runs),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out) { mkdirSync(dirname(opts.out), { recursive: true }); writeFileSync(opts.out, text); }
  process.stdout.write(opts.out ? `${JSON.stringify(report.summary, null, 2)}\n` : text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === STDIO_SERVE_FLAG) serveStdioMcp().catch(error => { console.error(error); process.exitCode = 1; });
  else main().catch(error => { console.error(error); cleanup(); process.exit(1); });
}
