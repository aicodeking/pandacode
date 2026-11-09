import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const lib = fs.readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('tests/fixtures/web-command-coverage.json', root), 'utf8'));
const registry = fs.readFileSync(new URL('src-tauri/src/web_gateway/registry_generated.rs', root), 'utf8');

function mainCommands() {
  const start = lib.indexOf('if invoke.message.webview_ref().label() != "main"');
  const body = /tauri::generate_handler!\[([\s\S]*?)\n\s*\]/.exec(lib.slice(start))?.[1];
  assert.ok(body, 'main handler inventory not found');
  const commands = body.split(',').map(value => value.trim()).filter(Boolean);
  assert.ok(commands.every(value => /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/.test(value)), 'unparsed handler entry');
  return commands;
}
function wireName(rustPath) {
  const fn = rustPath.split('::').at(-1);
  const definition = new RegExp(`#\\[tauri\\s*::\\s*command\\(rename\\s*=\\s*"([^"]+)"\\)\\][\\s\\S]{0,300}\\bfn\\s+${fn}\\b`).exec(lib);
  return definition?.[1] ?? fn;
}
function registryEntries() {
  const snake = value => value.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return [...registry.matchAll(/name: "([^"]+)",\s+exposure: Exposure::(\w+),\s+guard: Guard::(\w+),\s+mutation: (true|false),\s+reason: "([^"]*)"/g)]
    .map(match => ({ command: match[1], classification: snake(match[2]), guard: snake(match[3]), mutation: match[4] === 'true', reason: match[5] }));
}

test('web parity inventory reconciles 397 main-window commands with registry and coverage', () => {
  const allCommands = mainCommands(); const commands = allCommands.filter(name => !name.startsWith('web_gateway::')); const entries = registryEntries();
  assert.equal(commands.length, 397, `expected 397 domain commands, found ${commands.length}`);
  assert.deepEqual(allCommands.filter(name => name.startsWith('web_gateway::')).sort(), [
    'web_gateway::web_gateway_info', 'web_gateway::web_gateway_pair', 'web_gateway::web_gateway_preferences_publish',
    'web_gateway::web_gateway_ready', 'web_gateway::web_gateway_resolve',
    'web_gateway::web_gateway_revoke_session', 'web_gateway::web_gateway_sessions', 'web_gateway::web_gateway_set_session_limit',
  ].sort(), 'native-only lifecycle command inventory drifted');
  assert.equal(new Set(allCommands).size, allCommands.length, 'main-window command list contains duplicates');
  assert.equal(fixture.count, 397, 'coverage fixture count drifted');
  assert.equal(entries.length, fixture.count, 'registry count differs from checked-in inventory');
  const byCommand = new Map(entries.map(entry => [entry.command, entry]));
  const coverage = new Map(fixture.commands.map(entry => [entry.command, entry]));
  for (const rustPath of commands) { const command = wireName(rustPath); const entry = byCommand.get(command); const covered = coverage.get(command); assert.ok(entry, `registry missing ${command}`); assert.ok(covered, `coverage missing ${command}`); assert.equal(covered.rustPath, rustPath, `${command} coverage rust path drifted`); }
  assert.equal(coverage.size, entries.length, 'coverage has unknown or duplicate command entries');
  for (const entry of entries) {
    const covered = coverage.get(entry.command);
    assert.ok(covered, `coverage has no registry entry for ${entry.command}`);
    for (const field of ['classification', 'guard', 'mutation', 'reason']) assert.equal(covered[field], entry[field], `${entry.command} ${field} drifted`);
  }
  assert.ok(fixture.commands.some(entry => entry.classification === 'blocked'), 'coverage must retain explicit blocked work');
  assert.ok(fixture.commands.every(entry => entry.acceptanceTest === 'required'), 'coverage cannot claim verification without concrete acceptance tests');
});
