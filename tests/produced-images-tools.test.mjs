// Record-level parity: a shell record's row thumbnail (describeTool(...).produced) must be an image Rust's
// tool_images_auth/shell.rs also serves for the same record. Cases with a `tool` in the shared fixture carry the
// record's name and raw input; `served` (when present) overrides `produced` for the record (a VM command's image
// is in the VM, so nothing is served even though the command writes one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// dom.ts's fileIcon reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
const { describeTool } = await import('../src/tool-trace.ts');
const { normalizeTool } = await import('../src/tool-names.ts');

const CASES = JSON.parse(readFileSync(new URL('./fixtures/produced-images.json', import.meta.url), 'utf8'));
const TOOL_CASES = CASES.filter(entry => entry.tool !== undefined);
const expected = entry => ('served' in entry ? entry.served : entry.produced);
/** The row's path as Rust sees it: a relative output joined to the record's working directory. */
const joined = (path, cwd) => (cwd && path && !/^[/~]/.test(path) ? `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}` : path);
const record = entry => ({ name: entry.tool, status: 'completed', input: entry.input, output: '' });

test('the fixture has record cases for every shell harness spelling', () => {
  const names = TOOL_CASES.map(entry => entry.tool);
  for (const pattern of [/^Ran \S/, /^Running: /, /^Bash$/, /^Command$/, /^bash$/, /vm_exec$/]) {
    assert.ok(names.some(name => pattern.test(name)), String(pattern));
  }
  assert.ok(TOOL_CASES.some(entry => /^Ran /.test(entry.tool) && JSON.parse(entry.input).workdir), 'a Devin case with a workdir');
  assert.ok(TOOL_CASES.some(entry => entry.tool === 'Command' && /\nWorking directory: /.test(entry.input)), 'a Codex plain-text case');
});

test('Devin and Kimi shell titles normalize to Bash', () => {
  for (const entry of TOOL_CASES.filter(entry => /^(?:Ran|Running:) /.test(entry.tool))) {
    assert.equal(normalizeTool(record(entry)).name, 'Bash', entry.tool);
  }
});

test('every record case shows the thumbnail Rust serves', () => {
  for (const entry of TOOL_CASES) {
    const trace = describeTool(record(entry));
    assert.equal(trace.kind, 'shell', entry.tool);
    assert.equal(joined(trace.produced ?? null, entry.cwd), expected(entry), `${entry.tool}: ${entry.input}`);
  }
});

test('a record that is still running or failed shows no thumbnail', () => {
  for (const entry of TOOL_CASES.filter(entry => expected(entry))) {
    for (const status of ['running', 'failed']) {
      assert.equal(describeTool({ ...record(entry), status }).produced, undefined, `${entry.tool} ${status}`);
    }
  }
});
