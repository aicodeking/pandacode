import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A native reply that is a task (or tasks) replaces the one held in state. If it was read before a model, effort or
// permission pick saved, it puts the old choice back on screen, so every such call goes through main.ts' taskCall
// (model-switch.ts readTasks), or a read held open with beginRead. This scan fails on a bare `call` (the bridge's)
// that can answer with a task. An intended one says why on its line or the line before:
//   // task-read-guard: ok <reason>

const root = new URL('..', import.meta.url).pathname;
const ESCAPE = /\/\/\s*task-read-guard:\s*ok\s+\S/;

function files(dir, pattern) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

/** Tauri commands whose return type mentions Session (Session, Option<Session>, Vec<Session>), read from the Rust. */
function sessionCommands() {
  const commands = new Set();
  const command = /#\[tauri::command[^\]]*\]\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(([\s\S]*?)\)\s*->\s*([^{]+)\{/g;
  for (const file of files(join(root, 'src-tauri/src'), /\.rs$/)) {
    for (const match of readFileSync(file, 'utf8').matchAll(command)) {
      if (/\bSession\b/.test(match[3])) commands.add(match[1]);
    }
  }
  return commands;
}

/** Outside the files this guard's owners edit: reads that never replace a task held in state. */
const ALLOWED = [
  { file: 'src/schedules-settings.ts', command: 'list_sessions', reason: 'the schedule form lists tasks to pick from; never put in state' },
];

/** Bare `call` (not `host.call`, `overlayCall`, ...) with its type argument and first argument. */
const BARE_CALL = /(?<![\w.$])call\s*(<(?:[^<>()]|<[^<>]*>)*>)?\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?/g;

function violations(commands) {
  const found = [];
  for (const file of files(join(root, 'src'), /\.ts$/)) {
    const path = relative(root, file);
    const text = readFileSync(file, 'utf8'), lines = text.split('\n');
    for (const match of text.matchAll(BARE_CALL)) {
      const [, typeArg = '', ...names] = match;
      const command = names.find(name => name !== undefined);
      if (!(command !== undefined && commands.has(command)) && !/\bSession\b/.test(typeArg)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (ESCAPE.test(lines[line - 1]) || ESCAPE.test(lines[line - 2] ?? '')) continue;
      if (ALLOWED.some(entry => entry.file === path && entry.command === command)) continue;
      found.push(`${path}:${line} ${command ?? typeArg}`);
    }
  }
  return found;
}

test('the command list is read from the Rust and covers the task-answering commands', () => {
  const commands = sessionCommands();
  for (const name of ['get_task', 'list_sessions', 'configure_session', 'set_task_preference', 'update_task_details', 'set_task_stage',
    'set_task_link', 'set_resume_at_reset', 'recreate_worktree', 'attach_worktree', 'create_worktree', 'github_detect_pull_request',
    'pin_session', 'reorder_sessions', 'set_reasoning_effort']) assert.ok(commands.has(name), `${name} answers with a task`);
  assert.ok(!commands.has('update_session'), 'update_session answers with nothing');
});

test('every native call answering with a task goes through taskCall or readTasks', () => {
  assert.deepEqual(violations(sessionCommands()), [], 'use taskCall (main.ts), or add `// task-read-guard: ok <reason>`');
});

test('the scan catches a bare call and honours the escape and host.call', () => {
  const commands = new Set(['get_task']);
  const scan = text => [...text.matchAll(BARE_CALL)].filter(match => commands.has(match[2]) || /\bSession\b/.test(match[1] ?? ''))
    .filter(match => { const lines = text.split('\n'), line = text.slice(0, match.index).split('\n').length; return !ESCAPE.test(lines[line - 1]) && !ESCAPE.test(lines[line - 2] ?? ''); });
  assert.equal(scan("await call<Session>('get_task', {})").length, 1);
  assert.equal(scan("await call('get_task', {})").length, 1);
  assert.equal(scan("await call<Session | null>('other', {})").length, 1);
  assert.equal(scan("await call<Map<string, Session>>(\n  'other')").length, 1);
  assert.equal(scan("await host.call<Session>('get_task', {})").length, 0);
  assert.equal(scan("await taskCall<Session>('get_task', {})").length, 0);
  assert.equal(scan("await overlayCall<Session>('get_task', {})").length, 0);
  assert.equal(scan("await call<Project>('add_project', {})").length, 0);
  assert.equal(scan("// task-read-guard: ok held by the caller\nawait call<Session>('get_task', {})").length, 0);
  assert.equal(scan("// task-read-guard: ok\nawait call<Session>('get_task', {})").length, 1, 'the escape needs a reason');
});

test('host modules that answer with tasks are handed taskCall by main.ts', () => {
  const commands = sessionCommands();
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
  const hostCall = /\bhost\.call\s*(?:<(?:[^<>()]|<[^<>]*>)*>)?\s*\(\s*(?:'([^']*)'|[^,)]*'([^']*)')/g;
  const factories = [];
  for (const [, names, module] of main.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+)'/g)) {
    let source;
    try { source = readFileSync(join(root, 'src', `${module}.ts`), 'utf8'); } catch { continue; }
    const answersTasks = [...source.matchAll(hostCall)].some(match => commands.has(match[1] ?? match[2]))
      || /\bhost\.call\s*<\s*Session\b/.test(source);
    if (!answersTasks) continue;
    for (const name of names.split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(name => /^create[A-Z]/.test(name))) {
      factories.push({ module, name });
    }
  }
  assert.ok(factories.some(entry => entry.name === 'createWorktrees'), 'worktrees.ts is checked');
  for (const { module, name } of factories) {
    for (const use of main.matchAll(new RegExp(`\\b${name}\\(\\{([\\s\\S]{0,400})`, 'g'))) {
      assert.match(use[1], /\bcall:\s*taskCall\b/, `${name} (${module}.ts) needs call: taskCall`);
    }
  }
});
