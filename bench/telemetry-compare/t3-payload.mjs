// Captures exactly what T3 Code's own server sends to its PostHog analytics, using fake canary logins.
// Starts the installed T3 server (Electron as Node, from the app bundle) with a throwaway $HOME and
// T3CODE_POSTHOG_HOST pointed at a local sink, waits for batches, kills only the process group it
// started, deletes the temp $HOME and writes results/t3-payload/{capture.json,summary.md}.
// Never reads the real ~/.codex, ~/.claude.json or ~/.t3. Usage: node t3-payload.mjs [waitSeconds]
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUNDLE = process.env.T3_APP ?? '/Applications/T3 Code (Nightly).app';
const ELECTRON = path.join(BUNDLE, 'Contents/MacOS', path.basename(BUNDLE, '.app'));
const SERVER = path.join(BUNDLE, 'Contents/Resources/app.asar/apps/server/dist/bin.mjs');
const WAIT_S = Number(process.argv[2] ?? 45);
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 't3-payload');

const C = {
  codexAccountId: 'canary-codex-account-1234',
  openaiUserId: 'user-canaryOpenAI5678',
  codexEmail: 'canary.user@example.invalid',
  codexName: 'Canary Codex Name',
  claudeUserId: 'canary-claude-userid-9999',
  claudeAccountUuid: 'canary-claude-uuid-4242',
  claudeEmail: 'canary.claude@example.invalid',
  claudeDisplayName: 'Canary',
  connectUserId: 'canary-connect-user-7777',
  anonymousInstallId: 'canary-install-anon-1111',
  accessToken: 'canary-access-token-abcd',
  refreshToken: 'canary-refresh-token-efgh',
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-payload-home-'));
  const idToken = [b64u({ alg: 'none', typ: 'JWT' }), b64u({
    email: C.codexEmail, email_verified: true, name: C.codexName, sub: 'canary-sub',
    'https://api.openai.com/auth': { user_id: C.openaiUserId, chatgpt_account_id: C.codexAccountId },
  }), ''].join('.');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/auth.json'), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: C.accessToken, refresh_token: C.refreshToken, account_id: C.codexAccountId },
    last_refresh: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    userID: C.claudeUserId,
    oauthAccount: { accountUuid: C.claudeAccountUuid, emailAddress: C.claudeEmail, displayName: C.claudeDisplayName },
  }));
  // T3's own state: a known install id and a fake linked T3 Connect account (file secret store, 0700 dir).
  const userdata = path.join(home, '.t3/userdata');
  fs.mkdirSync(path.join(userdata, 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userdata, 'anonymous-id'), C.anonymousInstallId);
  fs.writeFileSync(path.join(userdata, 'secrets/cloud-linked-user-id.bin'), C.connectUserId, { mode: 0o600 });
  return home;
}

function startSink(requests) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = req.headers['content-encoding'];
      try { if (enc === 'gzip') buf = zlib.gunzipSync(buf); else if (enc === 'br') buf = zlib.brotliDecompressSync(buf); } catch {}
      requests.push({ at: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body: buf.toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":1}');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const groupPids = (pgid) => execFileSync('ps', ['-axo', 'pid=,pgid=']).toString().trim().split('\n')
  .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p);

async function capture() {
  if (!fs.existsSync(ELECTRON)) throw new Error(`T3 Code not found at ${BUNDLE}`);
  const requests = [];
  const sink = await startSink(requests);
  const home = makeHome();
  const t3Port = await freePort();
  const log = [];
  let child;
  fs.mkdirSync(path.join(home, 'tmp'));
  try {
    child = spawn(ELECTRON, [SERVER], {
      cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: home, USER: 'canary', LOGNAME: 'canary', TMPDIR: path.join(home, 'tmp'),
        // Minimal PATH so no provider CLI (codex, claude) is found and started with the fake logins.
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        ELECTRON_RUN_AS_NODE: '1', T3CODE_HOME: path.join(home, '.t3'), T3CODE_NO_BROWSER: '1',
        T3CODE_HOST: '127.0.0.1', T3CODE_PORT: String(t3Port),
        T3CODE_POSTHOG_HOST: `http://127.0.0.1:${sink.address().port}`,
      },
    });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => log.push(d.toString()));
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_S * 1000 && child.exitCode === null) await sleep(500);
  } finally {
    if (child?.pid) {
      const pids = groupPids(child.pid);
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 25 && groupPids(child.pid).length; i++) await sleep(200);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await sleep(500);
      var leftover = groupPids(child.pid), started = pids;
    }
    await sleep(1000); // a finalizer flush may arrive after SIGTERM
    sink.close();
  }
  const userRe = new RegExp(`\\b${os.userInfo().username}\\b`, 'g');
  const realHome = fs.realpathSync(home);
  const redact = (s) => [[realHome, '$TMP_HOME'], [home, '$TMP_HOME'], [os.homedir(), '$REAL_HOME']]
    .reduce((acc, [a, b]) => acc.split(a).join(b), s).replace(userRe, '$USER');
  fs.rmSync(home, { recursive: true, force: true });
  return {
    version: execFileSync('defaults', ['read', path.join(BUNDLE, 'Contents/Info.plist'), 'CFBundleShortVersionString']).toString().trim(),
    waitS: WAIT_S, startedPids: started ?? [], leftoverPids: leftover ?? [], homeDeleted: !fs.existsSync(home),
    requests: requests.map((r) => ({ ...r, body: redact(r.body), headers: JSON.parse(redact(JSON.stringify(r.headers))) })),
    serverLogTail: redact(log.join('')).split('\n').slice(-40),
  };
}

function walk(v, at, out) {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k, out);
  else out.push([at, v]);
  return out;
}

function analyze(cap) {
  const bodies = cap.requests.map((r) => r.body);
  const raw = bodies.join('\n');
  const events = cap.requests.flatMap((r) => { try { return JSON.parse(r.body).batch ?? []; } catch { return []; } });
  const leaves = events.flatMap((e) => walk(e, '', []).map(([k, v]) => [e.event, k, v]));
  const canaries = Object.entries(C).map(([name, value]) => {
    const hash = sha(value);
    const forms = { plain: value, base64: Buffer.from(value).toString('base64').replace(/=+$/, ''), base64url: Buffer.from(value).toString('base64url') };
    return {
      name, value, sha256: hash,
      hashFoundAt: [...new Set(leaves.filter(([, , v]) => v === hash).map(([ev, k]) => `${ev}: ${k}`))],
      rawFoundAs: Object.entries(forms).filter(([, f]) => raw.includes(f)).map(([k]) => k),
      hashInRaw: raw.includes(hash),
    };
  });
  const keyValues = {};
  for (const [, k, v] of leaves) if (!/^(uuid|timestamp)$/.test(k)) (keyValues[k] ??= new Set()).add(JSON.stringify(v));
  return {
    batches: cap.requests.length, urls: [...new Set(cap.requests.map((r) => `${r.method} ${r.url}`))],
    eventNames: [...new Set(events.map((e) => e.event))],
    eventCounts: events.reduce((m, e) => ({ ...m, [e.event]: (m[e.event] ?? 0) + 1 }), {}),
    propertyKeys: [...new Set(leaves.map(([, k]) => k))].sort(),
    keyValues: Object.fromEntries(Object.entries(keyValues).map(([k, s]) => [k, [...s]])),
    canaries,
    atSignLines: raw.split(/(?<=[,{])/).filter((s) => s.includes('@')),
    emailLines: raw.split(/(?<=[,{])/).filter((s) => /email/i.test(s)),
    pathsOrUser: raw.split(/(?<=[,{])/).filter((s) => /\$TMP_HOME|\$REAL_HOME|\$USER|canary(?!-)|hostname/i.test(s)),
  };
}

function summary(cap, a) {
  const plainLeak = a.canaries.filter((c) => c.rawFoundAs.length);
  const L = [`# T3 Code analytics payload capture (${new Date().toISOString().slice(0, 10)})`, '',
    `T3 Code ${cap.version}, server from the installed bundle, ${cap.waitS} s, ${a.batches} request(s) to the sink: ${a.urls.join(', ') || 'none'}.`, '',
    '## Verdict', '',
    plainLeak.length ? `**Plain canary values were sent:** ${plainLeak.map((c) => `${c.name} (${c.rawFoundAs.join('/')})`).join(', ')}.`
      : '**No email address and no plain account id was sent.** No canary string appeared in any body in plain, base64 or base64url form.',
    `- \`@\` anywhere in the bodies: ${a.atSignLines.length ? a.atSignLines.map((s) => `\`${s}\``).join(', ') : 'none'}.`,
    `- \`email\` (any case) anywhere in the bodies: ${a.emailLines.length ? a.emailLines.map((s) => `\`${s}\``).join(', ') : 'none'}.`,
    `- Paths, user name, hostname: ${a.pathsOrUser.length ? a.pathsOrUser.map((s) => `\`${s}\``).join(', ') : 'none found'}.`,
    '- What is sent instead: unsalted SHA-256 hex of account identifiers (table below). These are stable pseudonyms, not anonymous: anyone who knows an account id can recompute the hash and match it.', '',
    '## Canary → SHA-256 → where it appeared', '',
    '| Canary | Value | SHA-256 (hex) | Hash sent in | Plain/base64 in body |', '| --- | --- | --- | --- | --- |',
    ...a.canaries.map((c) => `| ${c.name} | \`${c.value}\` | \`${c.sha256}\` | ${c.hashFoundAt.join('<br>') || '—'} | ${c.rawFoundAs.join(', ') || 'no'} |`), '',
    '## Events', '', ...Object.entries(a.eventCounts).map(([e, n]) => `- \`${e}\` × ${n}`), '',
    '## Every property key and the values seen', '', '| Key | Values |', '| --- | --- |',
    ...a.propertyKeys.filter((k) => a.keyValues[k]).map((k) => `| \`${k}\` | ${a.keyValues[k].map((v) => `\`${v}\``).join(', ')} |`), '',
    '## Evidence lines', '', '```json', ...cap.requests.map((r) => r.body), '```', '',
    '## Method and scope', '',
    '- Fresh empty `$HOME` in a temp dir with fake logins only: `~/.codex/auth.json` (account_id, unsigned id_token JWT carrying an email, a name and `https://api.openai.com/auth.user_id`, dummy access/refresh tokens), `~/.claude.json` (userID, oauthAccount with accountUuid, emailAddress, displayName), and T3 state `~/.t3/userdata/anonymous-id` plus a fake linked T3 Connect user id in the file secret store. The real ~/.codex, ~/.claude.json and ~/.t3 were never read.',
    '- The user\'s own T3 Code window was running, so instead of a second GUI copy (`open -n`) the script ran the same app bundle\'s server (`app.asar/apps/server/dist/bin.mjs`) with the bundle\'s Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), `T3CODE_POSTHOG_HOST` set to a 127.0.0.1 sink, `T3CODE_NO_BROWSER=1`, and a minimal PATH so no provider CLI started. Telemetry identity, owners and `sendBatch` all live in this server process, so the payload is the same code path; the only expected difference is `clientType`/`serverMode` (`cli-web-client`/`web` instead of `desktop-app`/`desktop`).',
    '- No client connected, so only boot-time events appear (`server.boot.heartbeat`, `install.owner_observed` observed by `server`). Client-side owners (`connect`/`device` from a connected UI) and turn/feature events were not exercised; per the bundle they carry the same hashed-owner shape.',
    '- Scope: this shows what **T3 Code\'s server sends to its own PostHog** (default `https://ingest.t3.codes`). Telemetry sent by the provider CLIs themselves (Codex, Claude Code) is separate and out of scope.',
    `- Processes: started ${cap.startedPids.length} (own process group), left after kill: ${cap.leftoverPids.length}; temp HOME deleted: ${cap.homeDeleted}. Raw bodies: capture.json (temp path and user name redacted).`];
  return L.join('\n') + '\n';
}

const cap = await capture();
const a = analyze(cap);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify({ ...cap, analysis: a }, null, 2));
fs.writeFileSync(path.join(OUT, 'summary.md'), summary(cap, a));
console.log(`batches=${a.batches} events=${a.eventNames.join(',')} leftover=${cap.leftoverPids.length} -> ${OUT}`);
if (!a.batches) process.exitCode = 1;
