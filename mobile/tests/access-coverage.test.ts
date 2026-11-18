// Every screen or component that calls a host method needing more than View access (Access::Control
// or Access::Full in src-tauri/src/remote/methods/*.rs) must also gate it: reference one of the
// access helpers (useHostAllows, useHostBlock, menuGate, AccessNote / useAccessNote, ...) and name
// the method there, so a View phone sees why instead of an error after the tap. Static and
// pragmatic: wrappers in src/connect/api/*.ts map to their methods; a caller passes when its file
// holds a gate helper and the method's name. Exceptions are listed in ALLOWED with the reason.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MOBILE = fileURLToPath(new URL('..', import.meta.url));
const METHODS_DIR = fileURLToPath(new URL('../../src-tauri/src/remote/methods/', import.meta.url));
const API_DIR = join(MOBILE, 'src/connect/api');
const SCANNED = ['src/app', 'src/ui'].map(dir => join(MOBILE, dir));
const GATES = /\b(useHostAllows|useHostBlock|useNeedsFullAccessSwitch|menuGate|gatedPress|AccessNote|useAccessNote|accessNoteText|blockedBy|allows)\b/;

/** `file:method` pairs that call without a gate on purpose. */
const ALLOWED: Record<string, string> = {
  // Background and system calls are not user actions to explain: none are Control/Full today, kept
  // here so a future change to their access shows up as a decision rather than a failure.
  'any:subscribe': 'the live stream, opened by the client',
  'any:tasks.list': 'background list refresh',
  'any:host.hello': 'capability handshake',
  // Gated through a sibling with the same access (and Full access switch).
  'src/app/machines.tsx:vm.stop': 'Stop shows only where vm.start is allowed (canPower)',
  'src/app/terminal.tsx:terminal.list': 'the screen is gated on terminal.open / terminal.read / terminal.write',
  'src/app/terminal.tsx:terminal.resize': 'the screen is gated on terminal.open / terminal.read / terminal.write',
  'src/app/terminal.tsx:terminal.close': 'the screen is gated on terminal.open / terminal.read / terminal.write',
  // Mounted only behind their parent's gate.
  'src/ui/terminal/useTerminalPoll.ts:terminal.read': 'used only by terminal.tsx, which checks useHostBlock(terminal.read)',
  'src/ui/admin/CloudAgentStart.tsx:cloudAgents.start': 'mounted only by machines.tsx once useHostBlock(cloudAgents.start) is clear',
  // Pinning never fails for access: pinThread (connect/api/threads.ts) keeps a phone-only pin when the phone may not pin on the computer.
  'src/ui/InboxRow.tsx:thread.pin': 'pinsSync falls back to this phone\'s own pin when access blocks thread.pin',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Registry method -> its declared access, read from the Rust sources like capabilities.test does. */
function restrictedMethods(): Map<string, string> {
  const access = new Map<string, string>();
  for (const name of readdirSync(METHODS_DIR).filter(n => n.endsWith('.rs'))) {
    const source = readFileSync(join(METHODS_DIR, name), 'utf8');
    for (const m of source.matchAll(/Method\s*\{\s*name:\s*"([^"]+)",\s*access:\s*Access::(\w+)/g)) access.set(m[1], m[2]);
  }
  return new Map([...access].filter(([, level]) => level === 'Control' || level === 'Full'));
}

/** Exported wrapper in connect/api -> the restricted methods its body calls through hostCall/hostCallOnce/runOnce. */
function wrappers(restricted: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const path of walk(API_DIR)) {
    const source = readFileSync(path, 'utf8');
    const starts = [...source.matchAll(/^export (?:const|async function|function) (\w+)/gm)];
    starts.forEach((start, i) => {
      const body = source.slice(start.index, starts[i + 1]?.index ?? source.length);
      if (!/\b(hostCall|hostCallOnce|runOnce)\b/.test(body)) return;
      const methods = [...body.matchAll(/'([a-zA-Z]+\.[a-zA-Z.]+)'/g)].map(m => m[1]).filter(m => restricted.has(m));
      if (methods.length) out.set(start[1], [...new Set(methods)]);
    });
  }
  return out;
}

test('the scan reads the method registry and the API wrappers', () => {
  const restricted = restrictedMethods();
  assert.ok(restricted.size > 30, `found ${restricted.size} Control/Full methods`);
  assert.equal(restricted.get('schedules.runNow'), 'Control');
  assert.ok(!restricted.has('schedules.list'), 'View methods are not restricted');
  const calls = wrappers(restricted);
  assert.deepEqual(calls.get('forgetForBot'), ['bot.forget']);
  assert.deepEqual(calls.get('runScheduleNow'), ['schedules.runNow']);
});

test('every caller of a Control/Full host method also gates it', () => {
  const restricted = restrictedMethods();
  const calls = wrappers(restricted);
  const missing: string[] = [];
  for (const path of SCANNED.flatMap(walk)) {
    const source = readFileSync(path, 'utf8');
    const imports = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from '[^']*connect\/api\/[^']+';$/gm)].flatMap(m => m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]));
    const gated = GATES.test(source);
    const relative = path.slice(MOBILE.length);
    for (const [wrapper, methods] of calls) {
      // Only wrappers imported from connect/api (a local `setRouting` state setter is not the API's).
      if (!imports.includes(wrapper)) continue;
      for (const method of methods) {
        if (ALLOWED[`${relative}:${method}`] || ALLOWED[`any:${method}`]) continue;
        const named = source.includes(`'${method}'`) || source.includes(`"${method}"`);
        if (!gated || !named) missing.push(`${relative}: ${wrapper} (${method}, ${restricted.get(method)})`);
      }
    }
  }
  assert.deepEqual(missing, [], `gate these with useHostAllows/useHostBlock/menuGate/AccessNote, or add them to ALLOWED with a reason:\n${missing.join('\n')}`);
});
