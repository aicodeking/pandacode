import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The warm-spare pool sizes live in `providers/warm.rs`; Settings, the README, the privacy page,
// AGENTS.md and docs/worker-tokens.md repeat the totals by hand, so a changed limit must change them too.
const WARM = 'src-tauri/src/providers/warm.rs';
const MEMORY = 'src-tauri/src/providers/warm/memory.rs';
const STATS = 'src-tauri/src/providers/warm/stats.rs';
const EXIT = 'src-tauri/src/providers/exit.rs';
const SETTINGS = 'src/settings.ts';
const ABOUT = 'src/about-settings.ts';
const README = 'README.md';
const PRIVACY = 'website/src/pages/privacy.astro';
const AGENTS = 'AGENTS.md';
const WORKER_TOKENS = 'docs/worker-tokens.md';
// Every hand-written copy that carries the full warm-spare limits, in the order a reader meets
// them. The Settings hint is a concise summary whose row links to docs/worker-tokens.md instead; its
// own tests below check what it must and must not say and that the link is wired.
const FULL_COPIES = [README, PRIVACY, WORKER_TOKENS, AGENTS];
const HEADLESS = 'docs/headless.md';
const AGENT_REFERENCE = 'docs/agent-reference.md';

function rustLimit(source, name) {
  const match = source.match(new RegExp(`^const ${name}: usize = (\\d+);`, 'm'));
  assert.ok(match, `const ${name} not found in ${WARM}`);
  const value = Number(match[1]);
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer, got ${match[1]}`);
  return value;
}

function limits() {
  const source = readFileSync(WARM, 'utf8');
  const limit = rustLimit(source, 'LIMIT');
  const lead = rustLimit(source, 'LEAD_LIMIT');
  return { limit, lead, total: limit + lead };
}

// Markdown wraps lines; compare with whitespace collapsed.
function flat(path) {
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
}

test('warm.rs declares both pool limits', () => {
  const { limit, lead, total } = limits();
  assert.equal(total, limit + lead);
});

// The Settings hint is one string on the `warm-spares` switch; checked on its own so a match
// elsewhere in settings.ts cannot stand in for it.
function settingsHint() {
  const entry = readFileSync(SETTINGS, 'utf8').match(/\{\s*id:\s*'warm-spares'[^\n]*\}/);
  assert.ok(entry, `warm-spares switch not found in ${SETTINGS}`);
  return entry[0].replace(/\s+/g, ' ');
}

/** The warm-spare text of a copy: the Settings hint, or the whole file with whitespace collapsed. */
const textOf = (path) => (path === SETTINGS ? settingsHint() : flat(path));

test('every copy states the total pool size', () => {
  const { total } = limits();
  for (const path of [SETTINGS, README, PRIVACY, AGENTS]) {
    assert.match(textOf(path), new RegExp(`\\bup to ${total}\\b`), `${path} must state "up to ${total}"`);
  }
});

test('docs/worker-tokens.md states both limits and the total', () => {
  const { limit, lead, total } = limits();
  const text = flat(WORKER_TOKENS);
  const switchStart = text.indexOf('**Warm spare switch');
  assert.ok(switchStart >= 0, 'Warm spare switch section not found');
  // The section opens with what off means (including the post-`git status` re-check), then the sizes.
  assert.match(text.slice(switchStart, switchStart + 1200), new RegExp(`\\bup to ${total};`));
  const costStart = text.indexOf('**What a spare costs and saves.**');
  assert.ok(costStart >= 0, 'What a spare costs and saves section not found');
  assert.match(text.slice(costStart, costStart + 300), new RegExp(`\\bat most ${total} in all\\b`));
  assert.match(text, new RegExp(`\\(${limit} ordinary spares,`));
  assert.ok(text.includes(`(\`LEAD_LIMIT\` ${lead})`), `LEAD_LIMIT ${lead} not stated`);
});

// The measured figures are written once in `providers/warm.rs` (from the bench recorded in
// docs/worker-tokens.md) and repeated by hand elsewhere; a re-measurement must update every copy.
const LEAD_SPARE = 'src-tauri/src/lead_spare.rs';
const ARCHITECT_WORKERS = 'docs/architect-workers.md';
// Normalize hyphen/en dash so only the numbers are compared.
const dash = (range) => range.replace(/-/g, '–');

function canonical(pattern, anchor, what) {
  const source = readFileSync(WARM, 'utf8');
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `${anchor} not found in ${WARM}`);
  const match = source.slice(at).match(pattern);
  assert.ok(match, `${what} not found near ${anchor} in ${WARM}`);
  return dash(match[1]);
}

function rangesIn(path, pattern) {
  return [...flat(path).matchAll(new RegExp(pattern.source, 'g'))].map((m) => dash(m[1]));
}

test('every copy states the measured idle memory range from warm.rs', () => {
  // The comment above `MAX_RENEWALS` carries the canonical short-session RSS envelope.
  const source = readFileSync(WARM, 'utf8');
  const decl = source.indexOf('const MAX_RENEWALS');
  assert.ok(decl >= 0, `MAX_RENEWALS not found in ${WARM}`);
  const comment = source.slice(source.lastIndexOf('const LEAD_LIMIT', decl), decl);
  const found = comment.match(/(\d+[–-]\d+)\s+MiB/);
  assert.ok(found, `MiB range not found in the MAX_RENEWALS comment of ${WARM}`);
  const range = dash(found[1]);
  for (const path of [LEAD_SPARE, SETTINGS, README, AGENTS, WORKER_TOKENS, ARCHITECT_WORKERS]) {
    assert.ok(rangesIn(path, /~?(\d+[–-]\d+)\s+MiB/).includes(range), `${path} must state ${range} MiB`);
  }
});

test('every copy states the measured startup saving from warm.rs', () => {
  // The module doc comment at the top of warm.rs carries the canonical saving range.
  const range = canonical(/(\d+\.\d+[–-]\d+\.\d+)\s+s\b/, '//!', 'startup saving range');
  for (const path of [README, AGENTS, WORKER_TOKENS]) {
    assert.ok(rangesIn(path, /(\d+\.\d+[–-]\d+\.\d+)\s+s\b/).includes(range), `${path} must state ${range} s`);
  }
});

test('every copy states the live signed-in startup saving from docs/worker-tokens.md', () => {
  // The live probe's reading in docs/worker-tokens.md is the record; the offline bench range above
  // stays beside it, and every user-facing copy repeats both.
  const text = flat(WORKER_TOKENS);
  const found = text.match(/on a real login a spare skips ~(\d+\.\d+[–-]\d+\.\d+) s of CLI startup/);
  assert.ok(found, `live signed-in saving not found in ${WORKER_TOKENS}`);
  const range = dash(found[1]);
  for (const path of [SETTINGS, README, AGENTS, WORKER_TOKENS, ARCHITECT_WORKERS]) {
    assert.ok(rangesIn(path, /(\d+\.\d+[–-]\d+\.\d+)\s+s\b/).includes(range), `${path} must state ${range} s`);
  }
});

// Rust constants written as integer products (`6 * 1024 * 1024 * 1024`, `Duration::from_secs(30 * 60)`).
function product(expr, what) {
  const factors = expr.replace(/_/g, '').split('*').map((f) => Number(f.trim()));
  assert.ok(factors.length > 0 && factors.every((f) => Number.isInteger(f) && f > 0), `${what}: not an integer product: ${expr}`);
  return factors.reduce((a, b) => a * b, 1);
}

function rustBytes(path, name) {
  const match = readFileSync(path, 'utf8').match(new RegExp(`const ${name}: u64 = ([\\d_ *]+);`));
  assert.ok(match, `const ${name} not found in ${path}`);
  return product(match[1], name);
}

function rustSecs(path, name) {
  const match = readFileSync(path, 'utf8').match(new RegExp(`const ${name}: Duration = Duration::from_secs\\(([\\d_ *]+)\\);`));
  assert.ok(match, `const ${name}: Duration::from_secs(..) not found in ${path}`);
  return product(match[1], name);
}

const GIB = 1024 ** 3;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function memoryThresholds() {
  const total = rustBytes(MEMORY, 'MIN_TOTAL_RAM_BYTES') / GIB;
  const available = rustBytes(MEMORY, 'MIN_AVAILABLE_RAM_BYTES') / GIB;
  // Copies write GiB with at most one decimal; a threshold that is not one must change the copies' form too.
  for (const value of [total, available]) assert.equal(Number(value.toFixed(1)), value, `${value} GiB is not a one-decimal GiB figure`);
  return { total: String(total), available: String(available) };
}

test('every copy states the low-memory thresholds from warm/memory.rs in GiB', () => {
  const { total, available } = memoryThresholds();
  assert.equal(Number(available) < Number(total), true, 'the available-RAM floor sits below the total-RAM floor');
  const totalAt = new RegExp(`\\b${escape(total)} GiB\\b`, 'g');
  for (const path of FULL_COPIES) {
    const text = textOf(path);
    // GiB, not GB: the thresholds are binary (`* 1024`), and a decimal-unit copy reads ~7% low.
    for (const value of [total, available]) {
      assert.doesNotMatch(text, new RegExp(`\\b${escape(value)} ?GB\\b`), `${path} must write ${value} GiB, not GB`);
    }
    // One statement names both floors, says the free-RAM floor is read on Linux and Windows, and
    // that macOS uses memory pressure instead.
    const windows = [...text.matchAll(totalAt)].map((m) => text.slice(m.index, m.index + 500));
    assert.ok(windows.length > 0, `${path} must state ${total} GiB`);
    const ok = windows.some((w) =>
      w.includes(`${available} GiB`) && /\bLinux\b/.test(w) && /\bWindows\b/.test(w) && /\bmacOS\b[^.;]{0,40}\bpressure\b/.test(w));
    assert.ok(ok, `${path} must state ${total} GiB total, ${available} GiB free on Linux/Windows and macOS memory pressure together`);
  }
});

test('every copy states the expiry backoff range from warm/stats.rs', () => {
  const minMinutes = rustSecs(STATS, 'EXPIRY_COOLDOWN') / 60;
  const maxMinutes = rustSecs(STATS, 'MAX_EXPIRY_COOLDOWN') / 60;
  assert.ok(Number.isInteger(minMinutes) && Number.isInteger(maxMinutes) && minMinutes < maxMinutes, 'cooldowns are whole minutes, min below max');
  // The pause doubles from the first cooldown to the cap, so the cap is a power-of-two multiple.
  assert.ok(Number.isInteger(Math.log2(maxMinutes / minMinutes)), `${maxMinutes} min is not ${minMinutes} min doubled`);
  const maxHours = maxMinutes / 60;
  const min = new RegExp(`\\b${minMinutes}(?:\\s*(?:min|minutes)\\b|\\s*[–-]\\s*${maxMinutes}\\b|\\s*→)`);
  const max = Number.isInteger(maxHours)
    ? new RegExp(`\\b(?:${maxMinutes}\\s*(?:min|minutes)|${maxHours}\\s*(?:h|hours))\\b`)
    : new RegExp(`\\b${maxMinutes}\\s*(?:min|minutes)\\b`);
  for (const path of FULL_COPIES) {
    const text = textOf(path);
    assert.match(text, min, `${path} must state the ${minMinutes}-minute first pause`);
    assert.match(text, max, `${path} must state the ${maxMinutes}-minute cap`);
  }
});

test('every copy states the graceful retire wait from exit.rs', () => {
  const secs = rustSecs(EXIT, 'SPARE_RETIRE_WAIT');
  const wait = new RegExp(`\\b${secs} (?:s|seconds)\\b`, 'g');
  for (const path of FULL_COPIES) {
    const text = textOf(path);
    // Anchored to the retirement it describes, so an unrelated "2 s" elsewhere cannot satisfy it.
    const near = [...text.matchAll(wait)].some((m) => /SessionEnd|retire/i.test(text.slice(Math.max(0, m.index - 200), m.index + 200)));
    assert.ok(near, `${path} must state the ${secs} s graceful retire wait beside SessionEnd or retirement`);
  }
});

// The live signed-in probe in docs/worker-tokens.md is the record for what the telemetry switch
// saves on a real login; the offline dummy-key bench (~1.5 s) must not stand in for it.
function liveProbeMs(text, pattern, what) {
  const found = text.match(pattern);
  assert.ok(found, `live signed-in probe ${what} not found in ${WORKER_TOKENS}`);
  return Number(found[1].replace(/,/g, ''));
}

test('telemetry-off signed-in savings in Settings and docs/worker-tokens.md match the live probe', () => {
  const text = flat(WORKER_TOKENS);
  const start = text.indexOf('Live signed-in probe');
  assert.ok(start >= 0, `Live signed-in probe section not found in ${WORKER_TOKENS}`);
  const probe = text.slice(start);
  const defaultLine = probe.slice(probe.indexOf('Default env:'));
  const privacyLine = probe.slice(probe.indexOf('Telemetry switch'));
  const defaultInit = liveProbeMs(defaultLine, /`init_ms` cold median ([\d,]+) ms/, 'default init_ms');
  const defaultExit = liveProbeMs(defaultLine, /stdin-EOF exit after `result` ([\d,]+) ms/, 'default exit');
  const privacyInit = liveProbeMs(privacyLine, /`init_ms` cold ([\d,]+) ms/, 'telemetry-switch init_ms');
  const privacyWarm = liveProbeMs(privacyLine, /`init_ms` cold [\d,]+ ms → warm ([\d,]+) ms/, 'telemetry-switch warm init_ms');
  const privacyExit = liveProbeMs(privacyLine, /stdin-EOF exit ([\d,]+) ms/, 'telemetry-switch exit');
  const startupSaved = ((defaultInit - privacyInit) / 1000).toFixed(2);
  const exitSaved = ((defaultExit - privacyExit) / 1000).toFixed(2);
  const warmSaved = ((privacyInit - privacyWarm) / 1000).toFixed(2);

  // The concise Settings hint leaves the telemetry trade-off to docs/worker-tokens.md, but must
  // never present the offline ~1.5 s as a signed-in figure.
  assert.doesNotMatch(settingsHint(), /~?1\.5 s/, `${SETTINGS} must not present the offline ~1.5 s as the signed-in saving`);

  const label = '**Trade-off with "Turn off agent telemetry".**';
  const at = text.indexOf(label);
  assert.ok(at >= 0, `telemetry trade-off bullet not found in ${WORKER_TOKENS}`);
  const rest = text.slice(at + label.length);
  const ends = [rest.indexOf(' - **'), rest.indexOf('**Git state')].filter((i) => i >= 0);
  const bullet = rest.slice(0, Math.min(...ends)).trim();
  for (const saved of [startupSaved, exitSaved, warmSaved]) {
    assert.ok(bullet.includes(`~${saved} s`), `${WORKER_TOKENS} telemetry trade-off must state ~${saved} s from the live probe`);
  }
  assert.ok(!bullet.startsWith('That switch alone removes ~1.5 s'), `${WORKER_TOKENS} telemetry trade-off must lead with the signed-in figures`);
});

test('Settings refresh scope and preview-only refresh override stay aligned', () => {
  for (const path of [README, WORKER_TOKENS, ARCHITECT_WORKERS]) {
    const text = flat(path);
    assert.ok(text.includes('every 30 s while Settings → Agents is open'), `${path} must say the totals refresh every 30 s while Settings → Agents is open`);
    assert.ok(!text.includes('every 30 s while Settings is open'), `${path} must not say every 30 s while Settings is open`);
  }
  const source = readFileSync(SETTINGS, 'utf8');
  const fn = source.match(/const warmStatsRefreshMs = \(\) => \{([\s\S]*?)\n\};/);
  assert.ok(fn, `warmStatsRefreshMs not found in ${SETTINGS}`);
  const guard = fn[1].indexOf('if (!preview) return WARM_STATS_REFRESH_MS;');
  const override = fn[1].indexOf('warm-spares-refresh-ms');
  assert.ok(guard >= 0 && override > guard, `${SETTINGS} warmStatsRefreshMs must return WARM_STATS_REFRESH_MS outside preview before reading warm-spares-refresh-ms`);
});

test('the Settings hint is a concise plain-English summary that points to the full limits', () => {
  const hint = settingsHint().match(/hint:\s*'([^']*)'/);
  assert.ok(hint, `warm-spares hint text not found in ${SETTINGS}`);
  const text = hint[1];
  const { total } = limits();
  assert.ok(text.length <= 340, `${SETTINGS} warm-spares hint must stay concise (<= 340 chars), got ${text.length}`);
  for (const phrase of ['Off by default', `up to ${total}`, '195–255 MiB', '0.38–0.62 s', 'Anthropic or your configured Claude endpoint', 'git status']) {
    assert.ok(text.includes(phrase), `${SETTINGS} warm-spares hint must state "${phrase}"`);
  }
  // A tooltip cannot open a repository path; the full limits are a link button on the row instead.
  assert.ok(!text.includes('docs/worker-tokens.md'), `${SETTINGS} warm-spares hint must not carry the raw docs/worker-tokens.md path`);
  assert.doesNotMatch(text, /~?1\.5 s/, `${SETTINGS} warm-spares hint must not claim ~1.5 s as the signed-in saving`);
});

test('the README and privacy page disclose configured Claude endpoints for warm spares', () => {
  for (const path of [README, PRIVACY]) {
    assert.match(readFileSync(path, 'utf8'), /configured Claude endpoint/, `${path} must disclose configured Claude endpoints for warm spares`);
  }
});

test('the warm-spares row links to the full limits in docs/worker-tokens.md', () => {
  const about = readFileSync(ABOUT, 'utf8');
  const links = about.match(/export const PROJECT_LINKS = \{([\s\S]*?)\n\} as const;/);
  assert.ok(links, `PROJECT_LINKS not found in ${ABOUT}`);
  const url = links[1].match(/^\s*warmSpares:\s*'([^']+)'/m);
  assert.ok(url, `${ABOUT} PROJECT_LINKS must define warmSpares`);
  assert.ok(url[1].endsWith('/docs/worker-tokens.md#turn-speed-cached-instructions-and-warm-spares'), `${ABOUT} PROJECT_LINKS.warmSpares must point to docs/worker-tokens.md#turn-speed-cached-instructions-and-warm-spares, got ${url[1]}`);
  assert.ok(url[1].startsWith('https://github.com/'), `${ABOUT} PROJECT_LINKS.warmSpares must be a public https URL, got ${url[1]}`);
  // That anchor must still exist above the preregistered tail.
  assert.match(readFileSync(WORKER_TOKENS, 'utf8'), /^#+ Turn speed: cached instructions and warm spares$/m, `${WORKER_TOKENS} must keep the heading PROJECT_LINKS.warmSpares points to`);

  const settings = readFileSync(SETTINGS, 'utf8');
  assert.match(settings, /import\s*\{[^}]*\bPROJECT_LINKS\b[^}]*\}\s*from\s*'\.\/about-settings'/, `${SETTINGS} must import PROJECT_LINKS from ./about-settings`);
  const uses = [...settings.matchAll(/PROJECT_LINKS\.warmSpares\b/g)].map(m => m.index);
  assert.ok(uses.length > 0, `${SETTINGS} must use PROJECT_LINKS.warmSpares`);
  const openUrl = /data-action="open-url"|dataset\.action\s*=\s*['"]open-url['"]|setAttribute\(\s*['"]data-action['"]\s*,\s*['"]open-url['"]\s*\)/;
  // Either the button is built inline next to the warm-spares row, or it is a named constant
  // (`const NAME = `...open-url...PROJECT_LINKS.warmSpares...``) that the warm-spares row uses.
  const wired = uses.some(at => {
    const lineStart = settings.lastIndexOf('\n', at) + 1;
    const line = settings.slice(lineStart, settings.indexOf('\n', at));
    const named = line.match(/^\s*const\s+(\w+)\s*=/);
    if (named && openUrl.test(line)) {
      const name = named[1];
      return new RegExp(`'warm-spares'[^\\n]{0,120}\\b${name}\\b|\\b${name}\\b[^\\n]{0,120}'warm-spares'`).test(settings);
    }
    const near = settings.slice(Math.max(0, at - 600), at + 600);
    return openUrl.test(near) && near.includes('warm-spares');
  });
  assert.ok(wired, `${SETTINGS} must put PROJECT_LINKS.warmSpares on a data-action="open-url" button on the warm-spares row`);
});

test('the warm-spares-on opt-in marker in warm.rs matches every doc and Settings', () => {
  const found = readFileSync(WARM, 'utf8').match(/^const WARM_SPARES_ON_FILE: &str = "([^"]+)";/m);
  assert.ok(found, `const WARM_SPARES_ON_FILE not found in ${WARM}`);
  const marker = found[1];
  assert.equal(marker, 'warm-spares-on');
  for (const path of [README, AGENTS, HEADLESS, AGENT_REFERENCE, WORKER_TOKENS, ARCHITECT_WORKERS, PRIVACY, SETTINGS]) {
    const text = flat(path);
    assert.ok(!text.includes('warm-spares-off'), `${path} must not mention the retired warm-spares-off marker`);
    if (path === SETTINGS) {
      assert.ok(settingsHint().includes('Off by default'), `${SETTINGS} warm-spares hint must say Off by default`);
    } else if (path !== PRIVACY && path !== ARCHITECT_WORKERS) {
      assert.ok(text.includes(`\`${marker}\``), `${path} must name the \`${marker}\` marker`);
    }
  }
  for (const path of [README, PRIVACY, WORKER_TOKENS, HEADLESS, AGENT_REFERENCE]) {
    assert.match(flat(path), /\boff by default\b/i, `${path} must say Warm Claude spares are off by default`);
  }
  assert.ok(!flat(README).includes('Warm Claude spares (on by default)'), `${README} must not call Warm Claude spares on by default`);
  assert.ok(!flat(PRIVACY).includes('<strong>Warm Claude spares</strong> (on by default)'), `${PRIVACY} must not call Warm Claude spares on by default`);
});
