#!/usr/bin/env node
// Launches the production desktop builds of PandaCode and T3 Code fresh (throwaway $HOME),
// records network flows, resources and disk writes over an idle window, then quits them.
// See README.md. macOS only. Usage: RUNS=5 IDLE_S=60 node bench/telemetry-compare/run.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RUNS = Number(process.env.RUNS ?? 5);
const IDLE_S = Number(process.env.IDLE_S ?? 60);
const STEADY_S = Math.min(30, IDLE_S / 2); // CPU over the last STEADY_S seconds of the window
const COOLDOWN_MS = 5000;
const REAL_HOME = os.homedir();
// Bundle IDs whose real ~/Library caches belong to the bench (not the user), so they are measured
// and removed before each run. WKWebView writes ~/Library/{Caches,WebKit}/<id> whatever $HOME says.
const OWNED_IDS = (process.env.OWNED_IDS ?? 'ai.pandacode.bench').split(',').filter(Boolean);
const REAL_LIBRARY_DIRS = ['Caches', 'WebKit', 'HTTPStorages', 'Preferences', 'Saved Application State', 'Logs'];

const APPS = [
  {
    key: 'pandacode', name: 'PandaCode',
    bundle: process.env.PANDACODE_APP ?? path.join(ROOT, 'src-tauri/target/release/bundle/macos/PandaCode.app'),
    ownData: /^Library\/[^/]+\/ai\.pandacode\./, // the app's own files, as opposed to caches of the CLIs it starts
  },
  {
    key: 't3', name: 'T3 Code', bundle: process.env.T3_APP ?? '/Applications/T3 Code (Nightly).app',
    ownData: /^(\.t3(\/|$)|Library\/[^/]+\/(t3code|com\.t3tools))/,
  },
];

// Per-process facts the shell can't give us: the "responsible" process (WKWebView's WebContent,
// Networking and GPU services are launchd children, attributed to the app only through it),
// task info (RSS, CPU, threads) and which processes own an on-screen window.
const PROBE_SRC = String.raw`
import Foundation
import CoreGraphics
typealias RespFn = @convention(c) (pid_t) -> pid_t
let resp = unsafeBitCast(dlsym(dlopen(nil, RTLD_NOW), "responsibility_get_pid_responsible_for_pid")!, to: RespFn.self)
let bundle = CommandLine.arguments[1] + "/"
let main = CommandLine.arguments[1] + "/Contents/MacOS/"
let interval = Double(CommandLine.arguments[2])! / 1000
var tb = mach_timebase_info_data_t(); mach_timebase_info(&tb)
var pids = [pid_t](repeating: 0, count: 16384)
var buf = [CChar](repeating: 0, count: 4096)
setvbuf(stdout, nil, _IOLBF, 0)
while true {
  let n = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
  var paths = [pid_t: String](), resps = [pid_t: pid_t]()
  for p in pids.prefix(n) where p > 0 {
    resps[p] = resp(p)
    if proc_pidpath(p, &buf, 4096) > 0 { paths[p] = String(cString: buf) }
  }
  let ours = Set(paths.filter { $0.value.hasPrefix(bundle) }.map { $0.key })
  var rows = [String]()
  for p in pids.prefix(n) where p > 0 && (ours.contains(p) || ours.contains(resps[p] ?? 0)) {
    var bsd = proc_bsdinfo(); var ti = proc_taskinfo()
    let ppid = proc_pidinfo(p, PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 ? Int(bsd.pbi_ppid) : -1
    let ok = proc_pidinfo(p, PROC_PIDTASKINFO, 0, &ti, Int32(MemoryLayout<proc_taskinfo>.size)) > 0
    let cpuNs = ok ? (ti.pti_total_user + ti.pti_total_system) * UInt64(tb.numer) / UInt64(tb.denom) : 0
    let name = (paths[p] ?? "?").split(separator: "/").last.map(String.init) ?? "?"
    let isMain = (paths[p] ?? "").hasPrefix(main) ? 1 : 0
    rows.append("[\(p),\(ppid),\(resps[p] ?? 0),\(isMain),\(ok ? ti.pti_resident_size : 0),\(cpuNs),\(ok ? ti.pti_threadnum : 0),\"\(name.replacingOccurrences(of: "\"", with: ""))\"]")
  }
  var wins = Set<Int>()
  if !rows.isEmpty, let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      guard let pid = w[kCGWindowOwnerPID as String] as? Int, (w[kCGWindowLayer as String] as? Int) == 0,
            let b = w[kCGWindowBounds as String] as? [String: Any], ((b["Height"] as? Double) ?? 0) >= 100 else { continue }
      wins.insert(pid)
    }
  }
  print("{\"t\":\(Int(Date().timeIntervalSince1970 * 1000)),\"procs\":[\(rows.joined(separator: ","))],\"wins\":[\(wins.map(String.init).joined(separator: ","))]}")
  Thread.sleep(forTimeInterval: interval)
}
`;

const children = new Set(); // helper processes we started (probe, nettop)
const owned = new Set();    // app pids we launched (and their current tree), killed on any exit
let currentTree = [];
function cleanup() {
  for (const pid of [...owned, ...currentTree]) try { process.kill(pid, 'SIGKILL'); } catch {}
  for (const c of children) try { c.kill('SIGKILL'); } catch {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function buildProbe() {
  const dir = path.join(HERE, '.build');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'probe.swift'), bin = path.join(dir, 'probe');
  if (!fs.existsSync(bin) || fs.readFileSync(src, 'utf8') !== PROBE_SRC) {
    fs.writeFileSync(src, PROBE_SRC);
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
  }
  return bin;
}

function startProbe(bin, bundle, onTick) {
  const child = spawn(bin, [bundle, '150'], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  createInterface({ input: child.stdout }).on('line', (line) => { try { onTick(JSON.parse(line)); } catch {} });
  return child;
}

// nettop -L prints a process line ("name.pid", cumulative bytes) followed by its flows.
function parseEndpoint(s) {
  const v6 = s.includes('::') || (s.match(/:/g) ?? []).length > 1;
  const i = v6 ? s.lastIndexOf('.') : s.lastIndexOf(':');
  return { ip: s.slice(0, i), port: s.slice(i + 1) };
}
function startNettop(flows) {
  const child = spawn('nettop', ['-L', '0', '-s', '1', '-n'], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  let pid = 0, pname = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    const f = line.split(',');
    if (f[0] === 'time') return;
    const m = /^(.*)\.(\d+)$/.exec(f[1] ?? '');
    if (m && !/^(tcp|udp)[46] /.test(f[1])) { pid = Number(m[2]); pname = m[1]; return; }
    const fm = /^(tcp|udp)([46]) (.+)<->(.+)$/.exec(f[1] ?? '');
    if (!fm || f[2] === 'lo0') return;
    const local = parseEndpoint(fm[3]), remote = parseEndpoint(fm[4]);
    const listen = f[3] === 'Listen';
    if (!listen && (remote.ip === '*' || /^(127\.|::1$|localhost)/.test(remote.ip))) return;
    if (listen && /^(127\.|::1$)/.test(local.ip)) return;
    const key = `${pid}|${fm[1]}|${fm[3]}|${fm[4]}`;
    const prev = flows.get(key);
    const bin = Number(f[4]) || 0, bout = Number(f[5]) || 0;
    flows.set(key, {
      pid, process: pname, proto: fm[1] + fm[2], iface: f[2], state: f[3], listen,
      local: fm[3], ip: remote.ip, port: remote.port,
      first: prev?.first ?? Date.now(), bytesIn: Math.max(prev?.bytesIn ?? 0, bin), bytesOut: Math.max(prev?.bytesOut ?? 0, bout),
    });
  });
  return child;
}

function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.lstatSync(p).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes, files };
}
// Size per directory up to `depth` levels below root (where the writes went).
function breakdown(root, depth = 4, limit = depth === 4 ? 12 : Infinity) {
  const out = {};
  const walk = (d, level) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(p, level + 1);
      else {
        const s = e.isDirectory() ? dirSize(p).bytes : (() => { try { return fs.lstatSync(p).size; } catch { return 0; } })();
        const k = path.relative(root, level < depth ? d : p) || '.';
        out[k] = (out[k] ?? 0) + s;
      }
    }
  };
  walk(root, 1);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

// Names under the real ~/Library that a launch might write despite $HOME (stat only, never read).
function realHomeTouched(bundleId, since) {
  const hits = [];
  for (const d of REAL_LIBRARY_DIRS) {
    const base = path.join(REAL_HOME, 'Library', d);
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(bundleId)) continue;
      try { if (fs.statSync(path.join(base, n)).mtimeMs >= since) hits.push(path.join(base, n)); } catch {}
    }
  }
  return hits;
}

const bundleId = (bundle) => execFileSync('defaults', ['read', path.join(bundle, 'Contents/Info.plist'), 'CFBundleIdentifier']).toString().trim();
const bundleVersion = (bundle) => execFileSync('defaults', ['read', path.join(bundle, 'Contents/Info.plist'), 'CFBundleShortVersionString']).toString().trim();

function footprints(pids) {
  if (!pids.length) return 0;
  try {
    const out = execFileSync('footprint', ['-f', 'bytes', ...pids.flatMap((p) => ['-p', String(p)])], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).toString();
    return [...out.matchAll(/\[\d+\]:.*?Footprint: (\d+) B/g)].reduce((s, m) => s + Number(m[1]), 0);
  } catch { return null; }
}

function treeOf(root, procs) {
  const byPid = new Map(procs.map((p) => [p[0], p]));
  const inTree = (p, seen = 0) => p[0] === root || p[2] === root || (seen < 32 && byPid.has(p[1]) && inTree(byPid.get(p[1]), seen + 1));
  return procs.filter((p) => inTree(p));
}

async function measure(app, probeBin, runIndex) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tc-home-${app.key}-`));
  const logFile = path.join(home, '..', `${path.basename(home)}.log`);
  const preexisting = execFileSync('ps', ['-axo', 'comm=']).toString().split('\n').filter((c) => c.startsWith(app.bundle + '/'));
  if (preexisting.length) throw new Error(`${app.name} is already running from ${app.bundle}; quit it first (this bench never touches it).`);
  const id = bundleId(app.bundle);
  const owns = OWNED_IDS.includes(id);
  if (owns) for (const p of realHomeTouched(id, 0)) fs.rmSync(p, { recursive: true, force: true });

  const flows = new Map();
  const nettop = startNettop(flows);
  let root = 0, firstWin = null, last = [], ticks = [];
  const cpuMax = new Map(), seenPids = new Map(), commands = new Map(), lastSeen = new Map();
  const recordCommand = (pid) => {
    const ps = spawn('ps', ['-o', 'args=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', () => { const c = out.trim(); if (c) commands.set(pid, c.split(home).join('$HOME').slice(0, 200)); });
  };
  const probe = startProbe(probeBin, app.bundle, (tick) => {
    if (!root) root = tick.procs.find((p) => p[3] === 1)?.[0] ?? 0;
    if (!root) return;
    owned.add(root);
    const tree = treeOf(root, tick.procs);
    last = tree;
    currentTree = tree.map((p) => p[0]);
    for (const p of tree) {
      if (!seenPids.has(p[0])) recordCommand(p[0]);
      cpuMax.set(p[0], Math.max(cpuMax.get(p[0]) ?? 0, p[5])); seenPids.set(p[0], p[7]);
      lastSeen.set(p[0], { name: p[7], rss: p[4], t: tick.t });
    }
    if (firstWin === null && tick.wins.some((w) => tree.some((p) => p[0] === w))) firstWin = tick.t;
    ticks.push({ t: tick.t, rss: tree.reduce((s, p) => s + p[4], 0), cpu: [...cpuMax.values()].reduce((s, v) => s + v, 0), procs: tree.length, threads: tree.reduce((s, p) => s + p[6], 0) });
  });
  await sleep(1500); // let nettop and the probe settle before launch

  const t0 = Date.now();
  execFileSync('open', ['-n', '-F', '--env', `HOME=${home}`, '--stdout', logFile, '--stderr', logFile, app.bundle]);
  while (Date.now() - t0 < IDLE_S * 1000) await sleep(200);
  const tEnd = Date.now();
  if (!root) throw new Error(`${app.name} did not start (log: ${logFile})`);

  const at = (t) => ticks.filter((k) => k.t <= t).at(-1) ?? ticks[0];
  const end = at(tEnd), steadyStart = at(tEnd - STEADY_S * 1000);
  const treePids = last.map((p) => p[0]);
  const fp = footprints(treePids);
  const resources = {
    rssMB: end.rss / 2 ** 20, peakRssMB: Math.max(...ticks.filter((k) => k.t <= tEnd).map((k) => k.rss)) / 2 ** 20,
    footprintMB: fp == null ? null : fp / 2 ** 20,
    cpuS: end.cpu / 1e9, cpuSteadyS: (end.cpu - steadyStart.cpu) / 1e9,
    processes: end.procs, threads: end.threads, processesSeen: seenPids.size,
    processNames: [...new Set(last.map((p) => p[7]))].sort(),
    // Every process attributed to the app during the window: CPU used, RSS when last seen, alive at the end.
    perProcess: [...seenPids.keys()].map((pid) => ({
      pid, name: lastSeen.get(pid).name, cpuS: +(cpuMax.get(pid) / 1e9).toFixed(3), rssMB: +(lastSeen.get(pid).rss / 2 ** 20).toFixed(1),
      aliveAtEnd: treePids.includes(pid), command: commands.get(pid) ?? null,
    })).sort((a, b) => b.cpuS - a.cpuS),
  };
  // "App" = the bundle's own executables and the system services macOS runs on its behalf (WebKit, Metal…);
  // "tools" = everything else it started (harness CLIs, shells, npm, git).
  const isApp = (p) => p.command == null ? !resources.perProcess.some((q) => q.name === p.name && q.command) : p.command.startsWith(app.bundle) || p.command.startsWith('/System/');
  resources.appCpuS = resources.perProcess.filter(isApp).reduce((s, p) => s + p.cpuS, 0);
  resources.toolCpuS = resources.cpuS - resources.appCpuS;
  resources.appRssMB = resources.perProcess.filter((p) => p.aliveAtEnd && isApp(p)).reduce((s, p) => s + p.rssMB, 0);
  resources.toolProcessesSeen = resources.perProcess.filter((p) => !isApp(p)).length;

  // Quit: SIGTERM to the app we launched, then SIGKILL whatever of its tree is left.
  const allTree = [...seenPids.keys()];
  try { process.kill(root, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && allTree.some(alive); i++) await sleep(200);
  for (const pid of treeOf(root, last).map((p) => p[0]).filter(alive)) try { process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(1500);
  owned.delete(root); currentTree = [];
  probe.kill(); nettop.kill(); children.delete(probe); children.delete(nettop);

  const pidSet = new Set(allTree);
  const net = [...flows.values()].filter((f) => pidSet.has(f.pid) && f.first >= t0 - 1000 && f.first <= tEnd)
    .map((f) => ({ ...f, firstS: +((f.first - t0) / 1000).toFixed(1) }));
  const touched = realHomeTouched(id, t0);
  const outside = owns ? touched.reduce((s, p) => s + (fs.statSync(p).isDirectory() ? dirSize(p).bytes : fs.statSync(p).size), 0) : null;
  const byDir = breakdown(home, 3);
  const disk = {
    home: dirSize(home), breakdown: breakdown(home), byDir, outsideHomeBytes: outside,
    ownBytes: Object.entries(byDir).filter(([k]) => app.ownData.test(k)).reduce((s, [, v]) => s + v, 0) + (outside ?? 0),
    realHomeTouched: touched.map((p) => p.replace(REAL_HOME, '~')),
  };
  if (owns) for (const p of touched) fs.rmSync(p, { recursive: true, force: true });
  const result = {
    app: app.key, run: runIndex, startedAt: new Date(t0).toISOString(), root,
    firstWindowMs: firstWin == null ? null : firstWin - t0, resources,
    network: net.filter((f) => !f.listen), listeners: net.filter((f) => f.listen).map((f) => `${f.proto} ${f.local} (${f.process})`),
    disk,
  };
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logFile, { force: true });
  return result;
}

// Every http(s) host named anywhere in a bundle (raw bytes), the candidates for matching an IP back to a name.
function bundleHosts(bundle) {
  const hosts = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else for (const m of fs.readFileSync(p).toString('latin1').matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
    }
  };
  walk(bundle);
  return hosts;
}

// Resolve candidate hosts now and map each address back to the names that resolve to it.
async function dnsMatches(candidates) {
  const byIp = new Map();
  const list = [...candidates];
  const withTimeout = (p) => Promise.race([p, sleep(3000).then(() => [])]).catch(() => []);
  for (let i = 0; i < list.length; i += 64) {
    await Promise.all(list.slice(i, i + 64).map(async (h) => {
      for (const ip of [...await withTimeout(dns.resolve4(h)), ...await withTimeout(dns.resolve6(h))]) {
        byIp.set(ip, [...(byIp.get(ip) ?? []), h]);
      }
    }));
  }
  return byIp;
}

async function labelHosts(ips, candidates) {
  const out = {};
  const matches = await dnsMatches(candidates);
  await Promise.all([...ips].map(async ({ ip, port }) => {
    const label = {};
    for (let i = 0; i < 2 && !label.rdns?.length; i++) try { label.rdns = (await dns.reverse(ip)).slice(0, 2); } catch { label.rdns = []; }
    for (let i = 0; i < 2 && port === '443' && !label.cert; i++) {
      label.cert = await new Promise((resolve) => {
        const s = tls.connect({ host: ip, port: 443, rejectUnauthorized: false, timeout: 4000 }, () => {
          const c = s.getPeerCertificate();
          const sans = (c.subjectaltname ?? '').split(', ').map((x) => x.replace(/^DNS:/, '')).filter(Boolean);
          s.destroy();
          resolve({ cn: c.subject?.CN ?? null, sans: sans.slice(0, 4), org: c.subject?.O ?? null });
        });
        s.on('error', () => resolve(null)); s.on('timeout', () => { s.destroy(); resolve(null); });
      });
    }
    label.dnsMatch = (matches.get(ip) ?? []).slice(0, 4);
    out[ip] = label;
  }));
  return out;
}

const labelText = (l) => {
  if (!l) return '?';
  const parts = [];
  if (l.dnsMatch?.length) parts.push(`DNS match ${l.dnsMatch.join(', ')}`);
  if (l.cert?.cn) parts.push(`cert ${l.cert.cn}${l.cert.sans?.length ? ` (SAN ${l.cert.sans.join(', ')})` : ''}`);
  if (l.rdns?.length) parts.push(`rDNS ${l.rdns.join(', ')}`);
  return parts.join('; ') || 'no rDNS, no cert';
};

function summarize(data) {
  const lines = [];
  const f = (v, d = 1) => (v == null ? 'n/a' : v.toFixed(d));
  const stat = (key, pick, d) => {
    const xs = data.runs.filter((r) => r.app === key).map(pick).filter((v) => v != null);
    return xs.length ? `${f(median(xs), d)} (${f(Math.min(...xs), d)}–${f(Math.max(...xs), d)})` : 'n/a';
  };
  const ratio = (pick) => {
    const m = (k) => median(data.runs.filter((r) => r.app === k).map(pick).filter((v) => v != null));
    const a = m('pandacode'), b = m('t3');
    return b ? (a / b).toFixed(2) : 'n/a';
  };
  const date = data.date;
  lines.push(`# Idle launch telemetry, ${date}`, '');
  lines.push(`${data.config.runs} cold launches per app, alternating order, each with a new empty \`$HOME\`, measured ${data.config.idleS} s after launch with nothing clicked and no agents running. Median (min–max). Ratio = PandaCode / T3 Code (below 1: PandaCode used less).`, '');
  lines.push('## Resources and disk', '', '| Metric | PandaCode | T3 Code | Ratio |', '| --- | ---: | ---: | ---: |');
  const rows = [
    ['Physical footprint at end, process tree (MB)', (r) => r.resources.footprintMB, 0],
    ['Resident memory (RSS) at end, process tree (MB)', (r) => r.resources.rssMB, 0],
    ['Peak RSS during the window (MB)', (r) => r.resources.peakRssMB, 0],
    [`CPU time, launch to ${data.config.idleS} s (s)`, (r) => r.resources.cpuS, 2],
    ['  of which app processes (s)', (r) => r.resources.appCpuS, 2],
    ['  of which tools it started (s)', (r) => r.resources.toolCpuS, 2],
    ['Tool processes started (harness CLIs, shells, npm, git…)', (r) => r.resources.toolProcessesSeen, 0],
    [`CPU time, last ${data.config.steadyS} s (idle) (s)`, (r) => r.resources.cpuSteadyS, 2],
    ['Processes at end', (r) => r.resources.processes, 0],
    ['Threads at end', (r) => r.resources.threads, 0],
    ['Time to first on-screen window (ms)', (r) => r.firstWindowMs, 0],
    ['Data written by launch: fresh $HOME + bench-owned ~/Library caches (MB)', (r) => (r.disk.home.bytes + (r.disk.outsideHomeBytes ?? 0)) / 2 ** 20, 2],
    ['  of which the app\'s own data dirs (MB)', (r) => r.disk.ownBytes / 2 ** 20, 2],
    ['Files written to the fresh $HOME', (r) => r.disk.home.files, 0],
    ['Remote flows (non-loopback)', (r) => r.network.length, 0],
    ['Bytes received over those flows (KB)', (r) => r.network.reduce((s, n) => s + n.bytesIn, 0) / 1024, 1],
    ['Bytes sent over those flows (KB)', (r) => r.network.reduce((s, n) => s + n.bytesOut, 0) / 1024, 1],
  ];
  for (const [label, pick, d] of rows) lines.push(`| ${label} | ${stat('pandacode', pick, d)} | ${stat('t3', pick, d)} | ${ratio(pick)} |`);
  lines.push(`| App bundle size on disk (MB) | ${f(data.apps.pandacode.bundleMB)} | ${f(data.apps.t3.bundleMB)} | ${(data.apps.pandacode.bundleMB / data.apps.t3.bundleMB).toFixed(2)} |`, '');

  for (const key of ['pandacode', 't3']) {
    const app = data.apps[key];
    const runs = data.runs.filter((r) => r.app === key);
    lines.push(`## Hosts contacted by ${app.name} at idle launch`, '');
    const byIp = new Map();
    for (const r of runs) for (const n of r.network) {
      const k = `${n.ip}|${n.port}|${n.proto}`;
      const e = byIp.get(k) ?? { ...n, runs: new Set(), procs: new Set(), firsts: [], perRun: new Map() };
      e.runs.add(r.run); e.procs.add(n.process); e.firsts.push(n.firstS);
      const pr = e.perRun.get(r.run) ?? { in: 0, out: 0 };
      e.perRun.set(r.run, { in: pr.in + n.bytesIn, out: pr.out + n.bytesOut });
      byIp.set(k, e);
    }
    if (!byIp.size) { lines.push('No non-loopback connections were observed from any process of the app in any run.', ''); continue; }
    const byName = new Map();
    for (const e of byIp.values()) {
      const l = data.hosts[e.ip] ?? {};
      const name = l.dnsMatch?.[0] ?? l.cert?.cn ?? l.rdns?.[0] ?? `unidentified ${e.ip}`;
      const g = byName.get(name) ?? { runs: new Set(), procs: new Set(), kbIn: 0 };
      e.runs.forEach((r) => g.runs.add(r)); e.procs.forEach((p) => g.procs.add(p)); g.kbIn += [...e.perRun.values()].reduce((a, b) => a + b.in, 0) / 1024 / runs.length;
      byName.set(name, g);
    }
    lines.push('By name (first DNS match, else certificate CN, else reverse DNS): ' + [...byName].sort((a, b) => b[1].runs.size - a[1].runs.size)
      .map(([n, g]) => `**${n}** (${[...g.procs].join(', ')}; ${g.runs.size}/${runs.length} runs, ~${f(g.kbIn)} KB in per run, averaged over all runs)`).join(', ') + '.', '');
    lines.push('| Remote | Proto | Identified as | Process | Runs seen | First seen (s, median) | In / out per run seen (KB, median) |', '| --- | --- | --- | --- | ---: | ---: | ---: |');
    for (const e of [...byIp.values()].sort((a, b) => median(a.firsts) - median(b.firsts))) {
      lines.push(`| ${e.ip}:${e.port} | ${e.proto} | ${labelText(data.hosts[e.ip])} | ${[...e.procs].join(', ')} | ${e.runs.size}/${runs.length} | ${f(median(e.firsts))} | ${f(median([...e.perRun.values()].map((v) => v.in)) / 1024)} / ${f(median([...e.perRun.values()].map((v) => v.out)) / 1024)} |`);
    }
    const procs = new Map();
    for (const r of runs) for (const p of r.resources.perProcess) {
      const k = `${p.name}\u0000${(p.command ?? '').replace(/\d{3,}/g, 'N')}`;
      const e = procs.get(k) ?? { name: p.name, command: p.command, runs: new Set(), cpu: [] };
      e.runs.add(r.run); e.cpu.push(p.cpuS); procs.set(k, e);
    }
    lines.push('', 'Processes attributed to the app (process tree plus processes macOS holds it responsible for), with the command line when `ps` could read it:', '');
    lines.push('| Process | Command | Runs seen | CPU per instance (s, median) |', '| --- | --- | ---: | ---: |');
    for (const e of [...procs.values()].sort((a, b) => median(b.cpu) - median(a.cpu))) {
      lines.push(`| ${e.name} | ${e.command ? '`' + e.command.replace(/\|/g, '\\|').replace(/`/g, "'") + '`' : 'n/a'} | ${e.runs.size}/${runs.length} | ${f(median(e.cpu), 2)} |`);
    }
    const listeners = [...new Set(runs.flatMap((r) => r.listeners))];
    lines.push('', `Non-loopback listening sockets: ${listeners.length ? listeners.join('; ') : 'none'}.`, '');
  }
  lines.push('## Where the launch writes', '');
  for (const key of ['pandacode', 't3']) {
    const r = data.runs.filter((x) => x.app === key).at(-1);
    lines.push(`${data.apps[key].name} (last run, largest paths under the fresh $HOME): ${Object.entries(r.disk.breakdown).map(([p, b]) => `\`${p}\` ${(b / 1024).toFixed(0)} KB`).join(', ') || 'nothing'}.`);
    const touched = [...new Set(data.runs.filter((x) => x.app === key).flatMap((x) => x.disk.realHomeTouched))];
    lines.push(`Paths under the real ~/Library named after its bundle ID with a newer mtime after launch: ${touched.length ? touched.map((t) => `\`${t}\``).join(', ') : 'none'}.`, '');
  }
  const e = data.environment;
  lines.push(`Machine: ${e.model}, ${e.cpu}, ${e.memGB} GB, macOS ${e.macos}. PandaCode ${data.apps.pandacode.version} (\`${data.apps.pandacode.bundleId}\`, commit ${e.pandacodeCommit}), T3 Code ${data.apps.t3.version}. Raw numbers: ${date}.json. Method and limitations: ../README.md.`);
  return lines.join('\n') + '\n';
}

// Results are published: no absolute home paths or user name.
const sanitize = (text) => text.split(REAL_HOME).join('~').split(ROOT.replace(REAL_HOME, '~')).join('<repo>')
  .replace(new RegExp(`\\b${os.userInfo().username}\\b`, 'g'), '<user>');

function write(data) {
  const dir = path.join(HERE, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const clean = JSON.parse(sanitize(JSON.stringify(data)));
  fs.writeFileSync(path.join(dir, `${data.date}.json`), JSON.stringify(clean, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), summarize(clean));
  console.log(`wrote results/${data.date}.json and results/summary.md`);
}

async function main() {
  if (process.env.FROM_JSON) return write(JSON.parse(fs.readFileSync(process.env.FROM_JSON, 'utf8'))); // re-summarize only
  if (process.platform !== 'darwin') throw new Error('macOS only');
  for (const a of APPS) if (!fs.existsSync(a.bundle)) throw new Error(`Missing ${a.name} bundle: ${a.bundle}`);
  const probeBin = buildProbe();
  const sh = (cmd, args) => execFileSync(cmd, args).toString().trim();
  const apps = Object.fromEntries(APPS.map((a) => [a.key, {
    name: a.name, bundle: a.bundle, bundleId: bundleId(a.bundle), version: bundleVersion(a.bundle),
    bundleMB: Number(sh('du', ['-sk', a.bundle]).split('\t')[0]) / 1024,
  }]));
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    for (const app of i % 2 ? [...APPS].reverse() : APPS) {
      console.log(`run ${i + 1}/${RUNS} ${app.name}…`);
      const r = await measure(app, probeBin, i + 1);
      console.log(`  footprint ${r.resources.footprintMB?.toFixed(0)} MB, rss ${r.resources.rssMB.toFixed(0)} MB, cpu ${r.resources.cpuS.toFixed(2)} s, ${r.resources.processes} procs, window ${r.firstWindowMs} ms, ${r.network.length} flows`);
      runs.push(r);
      await sleep(COOLDOWN_MS);
    }
  }
  const ips = new Map();
  for (const r of runs) for (const n of r.network) ips.set(n.ip, { ip: n.ip, port: n.port });
  const candidates = new Set(APPS.flatMap((a) => [...bundleHosts(a.bundle)]));
  const hosts = await labelHosts(ips.values(), candidates);
  const date = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  const data = {
    date, config: { runs: RUNS, idleS: IDLE_S, steadyS: STEADY_S, probeIntervalMs: 150, nettopIntervalS: 1 },
    environment: {
      model: sh('sysctl', ['-n', 'hw.model']), cpu: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
      memGB: Math.round(Number(sh('sysctl', ['-n', 'hw.memsize'])) / 2 ** 30), macos: sh('sw_vers', ['-productVersion']),
      pandacodeCommit: sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']), node: process.version,
    },
    apps, hosts, runs,
  };
  write(data);
}

main().then(() => { cleanup(); process.exit(0); }, (err) => { console.error(err.message ?? err); cleanup(); process.exit(1); });
