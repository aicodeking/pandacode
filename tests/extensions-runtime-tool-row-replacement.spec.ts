import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import {
  MAX_FIELDS, MAX_ROWS, MAX_SIGNALS, MAX_TOKEN_CHARS, PERMISSION, READ_PERMISSION,
  candidates, checkAll, checkRow, faultKey, gate, reconcile, render, riskView, select, signals, specificity,
  type Candidate, type Facts, type Granted,
} from '../src/extensions/runtime-tool-row-replacement';
import type { ExtensionSnapshot } from '../src/extensions/manager';

// Preview and model column of R1004 (replace built-in tool rows, risk signals with provenance). The groups run the
// deterministic model in src/extensions/runtime-tool-row-replacement.ts, which mirrors
// src-tauri/src/extensions/runtime_tool_row_replacement.rs (whose own unit tests are `runtime_tool_row_replacement::tests`).
// Installed WebView and real harness captures are reported in their own columns: this file claims only preview and model.
//
// Refusal-test reconciliation: no existing assertion about built-in rows is weakened. The row's destructive badge, exit status
// and refusal rows stay host-drawn (asserted below as a source check); what is new is only the additive replacement.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const load = (path: string) => JSON.parse(read(`tests/fixtures/extensions/runtime-tool-row-replacement/${path}`));
const replace = load('replace/extension.json'), rival = load('rival/extension.json'), bad = load('bad/extension.json');
const rows: Record<string, Facts> = load('rows.json').rows;
const source = read('src/extensions/runtime-tool-row-replacement.ts');
const [shell, bash, docs] = replace.contributes.toolRows;

const snapshot = (manifests: unknown[], options: { safeMode?: boolean; enabled?: boolean } = {}): ExtensionSnapshot => ({
  safeMode: options.safeMode ?? false, diagnostics: [],
  packages: manifests.map(manifest => ({ manifest, enabled: options.enabled ?? true, icons: {} })),
} as unknown as ExtensionSnapshot);
const everything: Granted = () => true;
const nothing: Granted = () => false;
const pickOf = (list: Candidate[], facts: Facts, safe = false, faulted = new Set<string>()) => select(list, facts, safe, faulted);

test('extensions runtime tool row replacement: the fixture validates and the one with an unknown token is refused with a frozen code', () => {
  expect(replace.permissions).toContain(PERMISSION);
  expect(validateContract('packages', [replace]).ok).toBe(true);
  expect(validateContract('packages', [rival]).ok).toBe(true);
  expect(validateContract('packages', [bad]).ok).toBe(false);
  expect(checkAll(replace.contributes.toolRows)).toBeNull();
  expect(checkRow(bad.contributes.toolRows[0])).toBe('InvalidShape');
});

test('extensions runtime tool row replacement: selectors, tokens, signals and lists are closed and bounded', () => {
  expect([MAX_ROWS, MAX_SIGNALS, MAX_FIELDS]).toEqual([16, 8, 8]);
  expect(checkRow({ ...shell, selector: {} })).toBe('InvalidShape');
  expect(checkRow({ ...shell, selector: { color: 'red' } })).toBe('InvalidShape');
  expect(checkRow({ ...shell, row: { sentence: 'x'.repeat(161) } })).toBe('LimitExceeded');
  expect(checkRow({ ...shell, row: { sentence: '{name' } })).toBe('InvalidShape');
  expect(checkRow({ ...shell, row: { sentence: '<b>{name}</b>' } })).toBeNull();
  expect(checkRow({ ...shell, signals: [{ id: 'a', risk: 'fatal', label: 'x', when: 'always' }] })).toBe('InvalidShape');
  expect(checkRow({ ...shell, signals: [{ id: 'a', risk: 'notice', label: 'x', when: 'hook-teleport' }] })).toBe('InvalidShape');
  expect(checkRow({ ...shell, signals: [{ id: 'a', risk: 'notice', label: 'x'.repeat(25), when: 'always' }] })).toBe('LimitExceeded');
  expect(checkRow({ ...shell, card: { title: 'Card', fields: Array.from({ length: 9 }, (_, n) => ({ label: `f${n}`, value: '{name}' })) } })).toBe('LimitExceeded');
  expect(checkRow({ ...shell, extra: true })).toBe('InvalidShape');
  const many = Array.from({ length: 17 }, (_, n) => ({ ...shell, id: `sample.rows/r${n}` }));
  expect(checkAll(many)).toBe('LimitExceeded');
  expect(checkAll(many.slice(0, 16))).toBeNull();
  expect(checkAll([shell, shell])).toBe('InvalidShape');
});

test('extensions runtime tool row replacement: a granted package replaces a built-in row with coherent input, result and attribution', () => {
  const list = candidates(snapshot([replace]), everything);
  const pick = pickOf(list, rows['bash-status']);
  expect(pick.kind).toBe('replace');
  if (pick.kind !== 'replace') return;
  // The more specific declaration (kind and name) wins over the kind-wide one.
  expect(pick.candidate.row.id).toBe('sample.rows/bash');
  expect(specificity(bash.selector)).toBeGreaterThan(specificity(shell.selector));
  expect(pick.candidate.label).toBe('Calm rows');
  expect(render(pick.candidate.row, rows['bash-status'], true).sentence).toBe('Bash ran git status');
  const card = render(shell, rows['bash-status'], true);
  expect(card).toMatchObject({ sentence: 'Shell: git status', cardTitle: 'Command', fields: [['Status', 'completed'], ['Output', 'nothing to commit']] });
  // An MCP row is selected by its server.
  const mcp = pickOf(list, rows['docs-search']);
  expect(mcp.kind === 'replace' && mcp.candidate.row.id).toBe('sample.rows/mcp-docs');
  expect(render(docs, rows['docs-search'], true).sentence).toBe('Docs lookup: tokens');
  // A row nothing selects stays built-in.
  expect(pickOf(list, rows['read-file'])).toEqual({ kind: 'builtin', reason: 'NoMatch' });
});

test('extensions runtime tool row replacement: input and output need tasks.tools.read and a secret never reaches the sentence', () => {
  expect(READ_PERMISSION).toBe('tasks.tools.read');
  expect(render(shell, rows['bash-status'], false).fields[1][1]).toBe('[not granted]');
  const secret = render(shell, rows['bash-secret'], true);
  expect(secret.sentence).toBe('Shell: [hidden]');
  expect(secret.fields[1][1]).toBe('[hidden]');
  const wide = render(shell, { ...rows['bash-status'], target: `a\n\tb${'x'.repeat(400)}` }, true).sentence;
  expect(wide).not.toContain('\n');
  expect([...wide].length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
  // The package never gets raw markup: tokens are text only and the module sets textContent, never innerHTML.
  expect(source).not.toMatch(/innerHTML|insertAdjacentHTML/);
});

test('extensions runtime tool row replacement: hook-derived signals carry provenance and only the deciding package lights them', () => {
  const wipe = rows['bash-wipe'];
  const own = signals(shell, 'sample.rows', wipe, { decision: 'deny', by: 'sample.rows' });
  expect(own.map(signal => [signal.id, signal.source])).toEqual([['denied', 'hook'], ['failed', 'package']]);
  expect(own[0]).toMatchObject({ decision: 'deny', owner: 'sample.rows' });
  // Another package's decision, or another decision, never lights this package's hook signal.
  expect(signals(shell, 'sample.rows', rows['bash-status'], { decision: 'deny', by: 'sample.rows-rival' })).toEqual([]);
  expect(signals(shell, 'sample.rows', rows['bash-status'], { decision: 'approve', by: 'sample.rows' })).toEqual([]);
  expect(signals(shell, 'sample.rows', rows['bash-status'])).toEqual([]);
  // The built-in destructive badge is kept first and never lowered, replaced row or not.
  const chips = riskView(true, own);
  expect(chips[0]).toMatchObject({ source: 'builtin', risk: 'destructive' });
  expect(chips.map(chip => chip.risk)).toEqual(['destructive', 'destructive', 'caution']);
  expect(riskView(true, [])[0].label).toBe('destructive');
  expect(riskView(false, [])).toEqual([]);
});

test('extensions runtime tool row replacement: the native approval or denial is never misreported', () => {
  expect(reconcile('approved', 'sample.rows', { decision: 'approve', by: 'sample.rows' })).toEqual({ state: 'approved', by: 'sample.rows' });
  // The user denied after the package approved: the row says denied and lists the claim as overruled.
  expect(reconcile('denied', undefined, { decision: 'approve', by: 'sample.rows' })).toEqual({ state: 'denied', by: 'host', overruled: 'sample.rows approve' });
  // The package denied and the host denied: no overrule.
  expect(reconcile('denied', 'sample.rows', { decision: 'deny', by: 'sample.rows' }).overruled).toBeUndefined();
  // A package that asked leaves the call pending until the user decides.
  expect(reconcile('pending', undefined, { decision: 'ask', by: 'sample.rows' }).overruled).toBeUndefined();
  expect(reconcile('approved', undefined, { decision: 'deny', by: 'sample.rows' }).overruled).toBe('sample.rows deny');
  expect(reconcile('none', undefined)).toEqual({ state: 'none', by: 'host' });
});

test('extensions runtime tool row replacement: a destructive or failed row is replaceable and keeps its built-in badge, with no safety-only exclusion', () => {
  const list = candidates(snapshot([replace]), everything);
  const pick = pickOf(list, rows['bash-wipe']);
  expect(pick.kind).toBe('replace');
  expect(rows['bash-wipe'].builtinDestructive && rows['bash-wipe'].failed).toBe(true);
  // The mount leaves the built-in badge, exit status and chevron alone: it hides only the sentence parts it replaces.
  expect(source).toContain("'[data-trace-badge]'");
  expect(source).not.toMatch(/safetyOnly|SAFETY_EXCLUDE|excluded/i);
  expect(read('src/extensions/extensions.css')).toMatch(/\[data-row-replacement\][^{]*\.tool-trace-verb/);
});

test('extensions runtime tool row replacement: stale, conflicting, revoked, disabled, safe-mode and faulted rows restore the built-in row', () => {
  const alone = candidates(snapshot([replace]), everything);
  expect(pickOf(alone, rows['bash-status']).kind).toBe('replace');
  // A stale selector matches nothing.
  const stale = [{ ...alone[0], row: { ...shell, selector: { name: 'Gone' } } }];
  expect(pickOf(stale, rows['bash-status'])).toEqual({ kind: 'builtin', reason: 'NoMatch' });
  // Two packages claiming the same rows equally conflict: neither wins.
  const both = candidates(snapshot([replace, rival]), everything).filter(item => item.row.id !== 'sample.rows/bash');
  expect(pickOf(both, rows['bash-status'])).toEqual({ kind: 'builtin', reason: 'Conflict' });
  // A more specific declaration of one package wins without conflict.
  const mixed = candidates(snapshot([replace, rival]), everything);
  const winner = pickOf(mixed, rows['bash-status']);
  expect(winner.kind === 'replace' && winner.candidate.owner).toBe('sample.rows');
  expect(pickOf(candidates(snapshot([replace]), nothing), rows['bash-status'])).toEqual({ kind: 'builtin', reason: 'Revoked' });
  expect(pickOf(candidates(snapshot([replace], { enabled: false }), everything), rows['bash-status'])).toEqual({ kind: 'builtin', reason: 'NoMatch' });
  expect(pickOf(alone, rows['bash-status'], true)).toEqual({ kind: 'builtin', reason: 'SafeMode' });
  expect(pickOf(alone, rows['bash-status'], false, new Set([faultKey('sample.rows', 'sample.rows/bash'), faultKey('sample.rows', 'sample.rows/shell')]))).toEqual({ kind: 'builtin', reason: 'Faulted' });
  // A fault in the narrow declaration only falls back to the broader one.
  const fell = pickOf(alone, rows['bash-status'], false, new Set([faultKey('sample.rows', 'sample.rows/bash')]));
  expect(fell.kind === 'replace' && fell.candidate.row.id).toBe('sample.rows/shell');
  expect(gate(true)).toBe('ok');
  expect(gate(false)).toBe('PermissionDenied');
});

test('extensions runtime tool row replacement: the module never sends, stops, approves or edits a call, is wired once and styled from an always-loaded stylesheet', () => {
  expect(source).not.toMatch(/respondApproval|respond_approval|sendMessage|stopTask|invoke\(/);
  expect(source).not.toMatch(/tailwind|#[0-9a-f]{6}\b/i);
  const css = read('src/extensions/extensions.css');
  expect(css).toContain('.tool-replacement-chip');
  expect(css).not.toMatch(/\.tool-replacement[^{]*\{[^}]*(transition:[^;]*(width|height|top|left)|backdrop-filter)/);
  const main = read('src/main.ts');
  expect(main.match(/runtime-tool-row-replacement/g)?.length).toBe(1);
});
