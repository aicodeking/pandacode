#!/usr/bin/env node
// Linux counterpart of run.mjs (which is macOS only). See README.md, "Linux".
// Same protocol: RUNS cold launches per app, alternating order, fresh empty $HOME each, IDLE_S seconds
// idle from the moment of launch, then SIGTERM (SIGKILL after 10 s) and measure.
// Differences (forced by Linux, documented in the report):
//  - process attribution: descendants of the launched pid OR any process carrying this run's marker env var
//    (/proc/<pid>/environ), instead of macOS "responsibility";
//  - network: the app runs in its own network namespace; every packet on its veth is captured (tcpdump),
//    so no sampling gaps and every flow belongs to the app. Host names come from the app's own DNS
//    answers and TLS/QUIC SNI in the capture. `ss` inside the namespace (every 0.5 s) maps flows to processes;
//  - memory: PSS (smaps_rollup) stands in for macOS "physical footprint"; RSS as in the original;
//  - first window: first X11 window (Xvfb, no WM) that is viewable, >=100 px tall, whose _NET_WM_PID is in the tree.
// Must run as root (namespace, tcpdump); the apps run as BENCH_USER. Usage:
//   sudo -E PANDACODE_DIR=<AppDir> T3_DIR=<AppDir> RUNS=5 IDLE_S=60 node run-linux.mjs
// (AppDir = an AppImage extracted with --appimage-extract, i.e. its squashfs-root.)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUNS = Number(process.env.RUNS ?? 5);
const IDLE_S = Number(process.env.IDLE_S ?? 60);
const STEADY_S = Math.min(30, IDLE_S / 2);
const COOLDOWN_MS = 5000;
const NS = process.env.NETNS ?? 'tcns';
const VETH = 'veth-tc0';
const USER = process.env.BENCH_USER ?? 'user';
const UID = Number(execFileSync('id', ['-u', USER]).toString()), GID = Number(execFileSync('id', ['-g', USER]).toString());
const DISPLAY = process.env.DISPLAY ?? ':99';
const PATH_ENV = process.env.APP_PATH ?? process.env.PATH;
const OUT = process.env.OUT ?? path.join(HERE, 'results', 'linux'); // never overwrites the macOS results/summary.md
const PCAPS = path.join(OUT, 'pcap');
const CLK = Number(execFileSync('getconf', ['CLK_TCK']).toString());
const PAGE = Number(execFileSync('getconf', ['PAGESIZE']).toString());

const APPS = [
  { key: 'pandacode', name: 'PandaCode', dir: process.env.PANDACODE_DIR, appimage: process.env.PANDACODE_APPIMAGE, args: [],
    ownData: /^\.(local\/share|config|cache)\/ai\.pandacode/ },
  { key: 't3', name: 'T3 Code', dir: process.env.T3_DIR, appimage: process.env.T3_APPIMAGE, args: (process.env.T3_ARGS ?? '').split(' ').filter(Boolean),
    ownData: /^(\.t3(\/|$)|\.config\/(t3code|T3 Code))/ },
];

// ONLY=t3 runs one app; T3_ENV='K=V K2=V2' adds env vars to the T3 launch (e.g. the telemetry opt-out).
for (const a of APPS) a.extraEnv = Object.fromEntries((process.env[`${a.key.toUpperCase()}_ENV`] ?? '').split(' ').filter(Boolean).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
if (process.env.ONLY) APPS.splice(0, APPS.length, ...APPS.filter((a) => a.key === process.env.ONLY));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sh = (cmd, args, opts) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();

function setupNetns() {
  try { sh('ip', ['netns', 'del', NS]); } catch {}
  try { sh('ip', ['link', 'del', VETH]); } catch {}
  sh('ip', ['netns', 'add', NS]);
  sh('ip', ['link', 'add', VETH, 'type', 'veth', 'peer', 'name', 'veth-tc1']);
  sh('ip', ['link', 'set', 'veth-tc1', 'netns', NS]);
  sh('ip', ['addr', 'add', '10.200.1.1/24', 'dev', VETH]); sh('ip', ['link', 'set', VETH, 'up']);
  const x = (...a) => sh('ip', ['netns', 'exec', NS, ...a]);
  x('ip', 'addr', 'add', '10.200.1.2/24', 'dev', 'veth-tc1'); x('ip', 'link', 'set', 'veth-tc1', 'up'); x('ip', 'link', 'set', 'lo', 'up');
  x('ip', 'route', 'add', 'default', 'via', '10.200.1.1');
  sh('sysctl', ['-q', '-w', 'net.ipv4.ip_forward=1']);
  const wan = sh('ip', ['route', 'show', 'default']).match(/dev (\S+)/)[1];
  try { sh('iptables', ['-t', 'nat', '-D', 'POSTROUTING', '-s', '10.200.1.0/24', '-o', wan, '-j', 'MASQUERADE']); } catch {}
  sh('iptables', ['-t', 'nat', '-A', 'POSTROUTING', '-s', '10.200.1.0/24', '-o', wan, '-j', 'MASQUERADE']);
  for (const c of ['FORWARD']) { try { sh('iptables', ['-I', c, '-i', VETH, '-j', 'ACCEPT']); sh('iptables', ['-I', c, '-o', VETH, '-j', 'ACCEPT']); } catch {} }
  // The namespace cannot reach a 127.x stub resolver; give it a public resolver so the app's own DNS is captured.
  fs.mkdirSync(`/etc/netns/${NS}`, { recursive: true });
  fs.writeFileSync(`/etc/netns/${NS}/resolv.conf`, `nameserver ${process.env.NS_DNS ?? '1.1.1.1'}\n`);
  return wan;
}

// ---- process sampling from /proc ----
function listProcs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = read(`/proc/${d}/stat`); if (!stat) continue;
    const r = stat.lastIndexOf(')'); const comm = stat.slice(stat.indexOf('(') + 1, r);
    const f = stat.slice(r + 2).split(' ');
    out.push({ pid: Number(d), comm, ppid: Number(f[1]), cpuTicks: Number(f[11]) + Number(f[12]), threads: Number(f[17]), rss: Number(f[21]) * PAGE });
  }
  return out;
}
const markerCache = new Map();
function hasMarker(pid, marker) {
  if (markerCache.has(pid)) return markerCache.get(pid);
  const env = read(`/proc/${pid}/environ`); const v = env != null && env.includes(`TC_BENCH_RUN=${marker}`);
  if (env != null) markerCache.set(pid, v);
  return v;
}
function treeOf(root, procs, marker) {
  const kids = new Map(); for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const inTree = new Set(); const stack = [root];
  while (stack.length) { const pid = stack.pop(); if (inTree.has(pid)) continue; inTree.add(pid); for (const k of kids.get(pid) ?? []) stack.push(k.pid); }
  return procs.filter((p) => inTree.has(p.pid) || hasMarker(p.pid, marker));
}
const exeOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };
const cmdOf = (pid) => { const c = read(`/proc/${pid}/cmdline`); return c ? c.split('\0').filter(Boolean).join(' ') : null; };
const pssOf = (pid) => { const s = read(`/proc/${pid}/smaps_rollup`); const m = s && /^Pss:\s+(\d+) kB/m.exec(s); return m ? Number(m[1]) * 1024 : null; };

// ---- first window via X11 ----
function windowsOwnedBy(pids) {
  try {
    const ids = sh('xdotool', ['search', '--onlyvisible', '--name', ''], { env: { ...process.env, DISPLAY } }).split('\n').filter(Boolean);
    for (const id of ids) {
      let pid; try { pid = Number(sh('xdotool', ['getwindowpid', id], { env: { ...process.env, DISPLAY } })); } catch { continue; }
      if (!pids.has(pid)) continue;
      const g = sh('xdotool', ['getwindowgeometry', id], { env: { ...process.env, DISPLAY } });
      const m = /Geometry: (\d+)x(\d+)/.exec(g); if (m && Number(m[2]) >= 100) return true;
    }
  } catch {}
  return false;
}

// ---- network: ss inside the namespace (process names) + tcpdump on the veth (everything) ----
function ssSample(map) {
  let out = '';
  try { out = sh('ip', ['netns', 'exec', NS, 'ss', '-tunapH']); } catch { return; }
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/); if (f.length < 6) continue;
    const local = f[4], peer = f[5]; const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (!m) continue;
    const key = `${local}|${peer}`;
    if (!map.has(key)) map.set(key, { proc: m[1], pid: Number(m[2]), state: f[1], netid: f[0] });
  }
}
function listenersNow() {
  try {
    return sh('ip', ['netns', 'exec', NS, 'ss', '-tulnpH']).split('\n').filter(Boolean)
      .map((l) => l.trim().split(/\s+/)).filter((f) => !/^(127\.|\[::1\]|\[::ffff:127)/.test(f[4]))
      .map((f) => `${f[0]} ${f[4]} ${(/users:\(\("([^"]+)"/.exec(f.join(' ')) ?? [])[1] ?? ''}`);
  } catch { return []; }
}

const splitEp = (s) => { const i = s.lastIndexOf(':'); return { ip: s.slice(0, i).replace(/^\[|\]$/g, '').replace(/^::ffff:/, ''), port: s.slice(i + 1) }; };

function parsePcap(file, t0, ssMap) {
  const fields = ['frame.time_epoch', 'ip.src', 'ip.dst', 'ipv6.src', 'ipv6.dst', 'tcp.srcport', 'tcp.dstport', 'udp.srcport', 'udp.dstport', 'frame.len',
    'tls.handshake.extensions_server_name', 'dns.flags.response', 'dns.qry.name', 'dns.a', 'dns.aaaa', 'dns.cname', 'http.host'];
  let txt = '';
  try { txt = execFileSync('tshark', ['-r', file, '-o', 'tcp.desegment_tcp_streams:TRUE', '-T', 'fields', ...fields.flatMap((f) => ['-e', f]), '-E', 'separator=\t', '-E', 'occurrence=a', '-E', 'aggregator=,'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { txt = e.stdout?.toString() ?? ''; }
  const LOCAL = '10.200.1.2';
  const flows = new Map(); const ipNames = new Map(); const dnsQueries = new Map();
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const [ts, s4, d4, s6, d6, tsp, tdp, usp, udp, len, sni, dnsResp, qname, a, aaaa, cname, host] = line.split('\t');
    const src = s4 || s6, dst = d4 || d6; if (!src || !dst) continue;
    const proto = tsp ? 'tcp' : udp || usp ? 'udp' : 'other';
    const sp = tsp || usp || '', dp = tdp || udp || '';
    const out = src === LOCAL; if (!out && dst !== LOCAL) continue;
    const remote = out ? dst : src, rport = out ? dp : sp, lport = out ? sp : dp;
    const t = Number(ts) * 1000;
    if (qname && /^(1|True)$/.test(dnsResp)) {
      for (const ip of [...(a ? a.split(',') : []), ...(aaaa ? aaaa.split(',') : [])]) ipNames.set(ip, [...new Set([...(ipNames.get(ip) ?? []), qname.split(',')[0]])]);
    }
    if (qname && /^(0|False)$/.test(dnsResp)) { const q = qname.split(',')[0]; if (!dnsQueries.has(q)) dnsQueries.set(q, +((t - t0) / 1000).toFixed(1)); }
    const key = `${proto}|${lport}|${remote}|${rport}`;
    const fl = flows.get(key) ?? { proto: proto + (s6 ? '6' : '4'), ip: remote, port: rport, lport, first: t, bytesIn: 0, bytesOut: 0, packets: 0, sni: null, httpHost: null };
    fl.packets++; if (out) fl.bytesOut += Number(len); else fl.bytesIn += Number(len);
    if (sni && !fl.sni) fl.sni = sni.split(',')[0];
    if (host && !fl.httpHost) fl.httpHost = host.split(',')[0];
    flows.set(key, fl);
  }
  const procFor = (fl) => {
    for (const [k, v] of ssMap) { const [l, p] = k.split('|'); const L = splitEp(l), P = splitEp(p); if (L.port === fl.lport && P.ip === fl.ip && P.port === fl.port) return v.proc; }
    return null;
  };
  const network = [...flows.values()].map((fl) => ({
    proto: fl.proto, ip: fl.ip, port: fl.port, firstS: +((fl.first - t0) / 1000).toFixed(1), bytesIn: fl.bytesIn, bytesOut: fl.bytesOut, packets: fl.packets,
    sni: fl.sni, httpHost: fl.httpHost, dnsNames: ipNames.get(fl.ip) ?? [], process: procFor(fl),
  })).sort((a, b) => a.firstS - b.firstS);
  return { network, dnsQueries: Object.fromEntries(dnsQueries) };
}

function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { bytes += fs.lstatSync(p).size; files++; } catch {} } } };
  walk(dir); return { bytes, files };
}
function breakdown(root, depth = 4, limit = depth === 4 ? 12 : Infinity) {
  const out = {};
  const walk = (d, level) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(p, level + 1);
      else { const s = e.isDirectory() ? dirSize(p).bytes : (() => { try { return fs.lstatSync(p).size; } catch { return 0; } })();
        const k = path.relative(root, level < depth ? d : p) || '.'; out[k] = (out[k] ?? 0) + s; } } };
  walk(root, 1);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

let currentTree = [], tcpdumpChild = null;
function cleanup() { for (const pid of currentTree) try { process.kill(pid, 'SIGKILL'); } catch {} try { tcpdumpChild?.kill('SIGKILL'); } catch {} }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

async function measure(app, runIndex) {
  const marker = `${app.key}-${runIndex}-${Date.now()}`;
  const home = fs.mkdtempSync(path.join('/tmp', `tc-home-${app.key}-`));
  fs.chownSync(home, UID, GID); fs.chmodSync(home, 0o700);
  const logFile = `${home}.log`;
  fs.mkdirSync(PCAPS, { recursive: true });
  const pcap = path.join(PCAPS, `${app.key}-${runIndex}.pcap`);
  tcpdumpChild = spawn('tcpdump', ['-i', VETH, '-n', '-s', '0', '-U', '-w', pcap], { stdio: 'ignore' });
  await sleep(1500);

  const env = {
    HOME: home, USER, LOGNAME: USER, PATH: PATH_ENV, DISPLAY, LANG: 'C.UTF-8', SHELL: '/bin/bash',
    DBUS_SESSION_BUS_ADDRESS: process.env.APP_DBUS ?? '', TC_BENCH_RUN: marker, ...app.extraEnv,
  };
  const t0 = Date.now();
  const child = spawn('ip', ['netns', 'exec', NS, 'setpriv', `--reuid=${UID}`, `--regid=${GID}`, '--init-groups', '--',
    path.join(app.dir, 'AppRun'), ...app.args], { env, cwd: home, stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')] });
  const root = child.pid; // ip and setpriv exec in place, so this pid becomes AppRun and then the app
  const ssMap = new Map();
  let firstWin = null, last = [], lastSs = 0;
  const ticks = [], cpuMax = new Map(), seen = new Map();
  while (Date.now() - t0 < IDLE_S * 1000) {
    const procs = listProcs();
    const tree = treeOf(root, procs, marker);
    last = tree; currentTree = tree.map((p) => p.pid);
    for (const p of tree) {
      if (!seen.has(p.pid)) seen.set(p.pid, { name: p.comm, exe: exeOf(p.pid), command: cmdOf(p.pid) });
      // AppRun is a shell script that execs the app in place, so the same pid changes executable: keep the latest.
      const s = seen.get(p.pid); s.rss = p.rss;
      if (s.name !== p.comm) { s.name = p.comm; s.exe = exeOf(p.pid) ?? s.exe; s.command = cmdOf(p.pid) ?? s.command; }
      cpuMax.set(p.pid, Math.max(cpuMax.get(p.pid) ?? 0, p.cpuTicks));
    }
    const t = Date.now();
    if (firstWin === null && tree.length && windowsOwnedBy(new Set(tree.map((p) => p.pid)))) firstWin = t;
    ticks.push({ t, rss: tree.reduce((s, p) => s + p.rss, 0), cpu: [...cpuMax.values()].reduce((s, v) => s + v, 0), procs: tree.length, threads: tree.reduce((s, p) => s + p.threads, 0) });
    if (t - lastSs >= 500) { ssSample(ssMap); lastSs = t; }
    await sleep(150);
  }
  const tEnd = Date.now();
  const at = (t) => ticks.filter((k) => k.t <= t).at(-1) ?? ticks[0];
  const end = at(tEnd), steadyStart = at(tEnd - STEADY_S * 1000);
  const treePids = last.map((p) => p.pid);
  const pss = treePids.map(pssOf).filter((v) => v != null);
  const listeners = listenersNow();
  const resources = {
    rssMB: end.rss / 2 ** 20, peakRssMB: Math.max(...ticks.map((k) => k.rss)) / 2 ** 20,
    pssMB: pss.length ? pss.reduce((a, b) => a + b, 0) / 2 ** 20 : null,
    cpuS: end.cpu / CLK, cpuSteadyS: (end.cpu - steadyStart.cpu) / CLK,
    processes: end.procs, threads: end.threads, processesSeen: seen.size,
    perProcess: [...seen.entries()].map(([pid, s]) => ({
      pid, name: s.name, exe: s.exe, cpuS: +(cpuMax.get(pid) / CLK).toFixed(3), rssMB: +((s.rss ?? 0) / 2 ** 20).toFixed(1),
      aliveAtEnd: treePids.includes(pid), command: s.command ? s.command.split(home).join('$HOME').slice(0, 200) : null,
    })).sort((a, b) => b.cpuS - a.cpuS),
  };
  // "App" = executables inside the app's own (extracted AppImage) bundle, plus the system WebKitGTK helper
  // processes a Tauri app uses on Linux (the counterpart of macOS /System WebKit services). Everything else = tools.
  const isApp = (p) => (p.exe ?? '').startsWith(app.dir + '/') || /webkit2?gtk|WebKit(Web|Network|GPU)Process/i.test(p.exe ?? '') || (p.command ?? '').startsWith(app.dir + '/') || (p.command ?? '').startsWith(`bash ${app.dir}/AppRun`);
  resources.appCpuS = resources.perProcess.filter(isApp).reduce((s, p) => s + p.cpuS, 0);
  resources.toolCpuS = resources.cpuS - resources.appCpuS;
  resources.toolProcessesSeen = resources.perProcess.filter((p) => !isApp(p)).length;

  const allSeen = [...seen.keys()];
  try { process.kill(root, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && allSeen.some(alive); i++) await sleep(200);
  for (const p of treeOf(root, listProcs(), marker)) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  for (const pid of allSeen.filter(alive)) try { if (hasMarker(pid, marker)) process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(1500);
  currentTree = [];
  tcpdumpChild.kill('SIGINT'); await sleep(1000); tcpdumpChild = null;

  const { network: allFlows, dnsQueries } = parsePcap(pcap, t0, ssMap);
  const network = allFlows.filter((f) => f.firstS <= IDLE_S + 0.5);
  const byDir = breakdown(home, 3);
  const disk = { home: dirSize(home), breakdown: breakdown(home), byDir,
    ownBytes: Object.entries(byDir).filter(([k]) => app.ownData.test(k)).reduce((s, [, v]) => s + v, 0) };
  const logTail = (read(logFile) ?? '').split(home).join('$HOME').split('\n').slice(-15);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(logFile, { force: true });
  return { app: app.key, run: runIndex, startedAt: new Date(t0).toISOString(), root,
    firstWindowMs: firstWin == null ? null : firstWin - t0, resources, network, dnsQueries, listeners, disk, logTail,
    afterWindowFlows: allFlows.length - network.length };
}

const nameOf = (n) => n.sni ?? n.httpHost ?? n.dnsNames?.[0] ?? `unidentified ${n.ip}`;

function summarize(data) {
  const L = [];
  const f = (v, d = 1) => (v == null || Number.isNaN(v) ? 'n/a' : v.toFixed(d));
  const stat = (key, pick, d) => { const xs = data.runs.filter((r) => r.app === key).map(pick).filter((v) => v != null);
    return xs.length ? `${f(median(xs), d)} (${f(Math.min(...xs), d)}–${f(Math.max(...xs), d)})` : 'n/a'; };
  const ratio = (pick) => { const m = (k) => median(data.runs.filter((r) => r.app === k).map(pick).filter((v) => v != null)); const a = m('pandacode'), b = m('t3'); return b ? (a / b).toFixed(2) : 'n/a'; };
  L.push(`# Idle launch telemetry (Linux reproduction), ${data.date}`, '');
  L.push(`${data.config.runs} cold launches per app, alternating order, each with a new empty \`$HOME\`, measured ${data.config.idleS} s after launch with nothing clicked and no agents running. Median (min–max). Ratio = PandaCode / T3 Code.`, '');
  L.push('## Resources and disk', '', '| Metric | PandaCode | T3 Code | Ratio |', '| --- | ---: | ---: | ---: |');
  const rows = [
    ['Proportional set size (PSS) at end, process tree (MB)', (r) => r.resources.pssMB, 0],
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
    ['Data written to the fresh $HOME (MB)', (r) => r.disk.home.bytes / 2 ** 20, 2],
    ['  of which the app\'s own data dirs (MB)', (r) => r.disk.ownBytes / 2 ** 20, 2],
    ['Files written to the fresh $HOME', (r) => r.disk.home.files, 0],
    ['Remote flows (non-loopback, incl. DNS)', (r) => r.network.length, 0],
    ['Bytes received over those flows (KB)', (r) => r.network.reduce((s, n) => s + n.bytesIn, 0) / 1024, 1],
    ['Bytes sent over those flows (KB)', (r) => r.network.reduce((s, n) => s + n.bytesOut, 0) / 1024, 1],
  ];
  for (const [label, pick, d] of rows) L.push(`| ${label} | ${stat('pandacode', pick, d)} | ${stat('t3', pick, d)} | ${ratio(pick)} |`);
  L.push(`| App bundle (AppImage file) size (MB) | ${f(data.apps.pandacode.bundleMB)} | ${f(data.apps.t3.bundleMB)} | ${(data.apps.pandacode.bundleMB / data.apps.t3.bundleMB).toFixed(2)} |`);
  L.push(`| App bundle extracted size (MB) | ${f(data.apps.pandacode.extractedMB)} | ${f(data.apps.t3.extractedMB)} | ${(data.apps.pandacode.extractedMB / data.apps.t3.extractedMB).toFixed(2)} |`, '');
  for (const key of ['pandacode', 't3']) {
    const app = data.apps[key]; const runs = data.runs.filter((r) => r.app === key);
    L.push(`## Hosts contacted by ${app.name} at idle launch`, '');
    const byName = new Map();
    for (const r of runs) for (const n of r.network) {
      if (n.port === '53') continue;
      const name = nameOf(n);
      const g = byName.get(name) ?? { runs: new Set(), procs: new Set(), firsts: [], perRun: new Map(), ips: new Set() };
      g.runs.add(r.run); if (n.process) g.procs.add(n.process); g.firsts.push(n.firstS); g.ips.add(`${n.ip}:${n.port}/${n.proto}`);
      const pr = g.perRun.get(r.run) ?? { in: 0, out: 0 }; g.perRun.set(r.run, { in: pr.in + n.bytesIn, out: pr.out + n.bytesOut });
      byName.set(name, g);
    }
    if (!byName.size) { L.push('No non-loopback connections were observed.', ''); continue; }
    L.push('Host = TLS/QUIC SNI sent by the app, else the DNS name the app itself resolved to that address. Bytes are whole IP packets (headers and TLS included).', '');
    L.push('| Host | Process (from ss) | Runs seen | First seen (s, median) | In / out per run seen (KB, median) | Addresses |', '| --- | --- | ---: | ---: | ---: | --- |');
    for (const [name, g] of [...byName].sort((a, b) => median(a[1].firsts) - median(b[1].firsts))) {
      L.push(`| ${name} | ${[...g.procs].join(', ') || '?'} | ${g.runs.size}/${runs.length} | ${f(median(g.firsts))} | ${f(median([...g.perRun.values()].map((v) => v.in)) / 1024)} / ${f(median([...g.perRun.values()].map((v) => v.out)) / 1024)} | ${[...g.ips].slice(0, 4).join(', ')}${g.ips.size > 4 ? ` +${g.ips.size - 4}` : ''} |`);
    }
    const q = new Map(); for (const r of runs) for (const [n, t] of Object.entries(r.dnsQueries)) { const e = q.get(n) ?? { runs: 0, t: [] }; e.runs++; e.t.push(t); q.set(n, e); }
    L.push('', 'DNS names the app looked up: ' + [...q].sort((a, b) => median(a[1].t) - median(b[1].t)).map(([n, e]) => `\`${n}\` (${e.runs}/${runs.length}, ${f(median(e.t))} s)`).join(', ') + '.', '');
    const procs = new Map();
    for (const r of runs) for (const p of r.resources.perProcess) {
      const k = `${p.name}\u0000${(p.command ?? '').replace(/\d{3,}/g, 'N')}`;
      const e = procs.get(k) ?? { name: p.name, command: p.command, runs: new Set(), cpu: [] }; e.runs.add(r.run); e.cpu.push(p.cpuS); procs.set(k, e);
    }
    L.push('Processes attributed to the app:', '', '| Process | Command | Runs seen | CPU per instance (s, median) |', '| --- | --- | ---: | ---: |');
    for (const e of [...procs.values()].sort((a, b) => median(b.cpu) - median(a.cpu)).slice(0, 40))
      L.push(`| ${e.name} | ${e.command ? '`' + e.command.replace(/\|/g, '\\|').replace(/`/g, "'") + '`' : 'n/a'} | ${e.runs.size}/${runs.length} | ${f(median(e.cpu), 2)} |`);
    const listeners = [...new Set(runs.flatMap((r) => r.listeners))];
    L.push('', `Non-loopback listening sockets: ${listeners.length ? listeners.join('; ') : 'none'}.`, '');
  }
  L.push('## Where the launch writes', '');
  for (const key of ['pandacode', 't3']) {
    const r = data.runs.filter((x) => x.app === key).at(-1);
    L.push(`${data.apps[key].name} (last run, largest paths under the fresh $HOME): ${Object.entries(r.disk.breakdown).map(([p, b]) => `\`${p}\` ${(b / 1024).toFixed(0)} KB`).join(', ') || 'nothing'}.`, '');
  }
  const e = data.environment;
  L.push(`Machine: ${e.machine}. PandaCode ${data.apps.pandacode.version}, T3 Code ${data.apps.t3.version}. Raw numbers: ${data.date}.json; packet captures: pcap/.`);
  return L.join('\n') + '\n';
}

async function main() {
  if (process.env.FROM_JSON) { const d = JSON.parse(fs.readFileSync(process.env.FROM_JSON, 'utf8')); fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(d)); return; }
  if (process.getuid() !== 0) throw new Error('run as root (sudo -E)');
  for (const a of APPS) if (!a.dir || !fs.existsSync(path.join(a.dir, 'AppRun'))) throw new Error(`Missing extracted ${a.name}: ${a.dir}`);
  setupNetns();
  const mb = (p) => Number(sh('du', ['-sk', p]).split('\t')[0]) / 1024;
  const apps = Object.fromEntries(APPS.map((a) => [a.key, { name: a.name, dir: a.dir, version: process.env[`${a.key.toUpperCase()}_VERSION`] ?? '?',
    bundleMB: a.appimage ? fs.statSync(a.appimage).size / 2 ** 20 : null, extractedMB: mb(a.dir), args: a.args }]));
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    for (const app of i % 2 ? [...APPS].reverse() : APPS) {
      console.log(`run ${i + 1}/${RUNS} ${app.name}…`);
      const r = await measure(app, i + 1);
      const hosts = [...new Set(r.network.filter((n) => n.port !== '53').map(nameOf))];
      console.log(`  pss ${r.resources.pssMB?.toFixed(0)} MB, rss ${r.resources.rssMB.toFixed(0)} MB, cpu ${r.resources.cpuS.toFixed(2)} s, ${r.resources.processes} procs, window ${r.firstWindowMs} ms, ${r.network.length} flows: ${hosts.join(' ')}`);
      runs.push(r);
      await sleep(COOLDOWN_MS);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const data = { date, config: { runs: RUNS, idleS: IDLE_S, steadyS: STEADY_S, procIntervalMs: 150, ssIntervalMs: 500, capture: 'tcpdump on per-app netns veth' },
    environment: { machine: `${os.cpus().length} vCPU ${Math.round(os.totalmem() / 2 ** 30)} GB, ${sh('bash', ['-c', '. /etc/os-release; echo $PRETTY_NAME'])}, kernel ${os.release()}, ${os.cpus()[0].model}`, node: process.version, path: PATH_ENV, display: DISPLAY },
    apps, runs };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${date}.json`), JSON.stringify(data, null, 2) + '\n');
  if (APPS.length === 2) fs.writeFileSync(path.join(OUT, 'summary.md'), summarize(data));
  console.log(`wrote ${OUT}/${date}.json and summary.md`);
}
main().then(() => { cleanup(); process.exit(0); }, (err) => { console.error(err.stack ?? err); cleanup(); process.exit(1); });
